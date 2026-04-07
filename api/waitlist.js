// Vercel Serverless Function — /api/waitlist
// ENV VARS REQUIRED (set in Vercel dashboard):
//   SUPABASE_URL          e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (not anon)
//   RESEND_API_KEY        from resend.com

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, name, role, deals, bottleneck, phone, referredBy, website } = req.body || {};

  // Honeypot — bots fill the hidden "website" field; humans don't
  if (website) return res.status(200).json({ ok: true });

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRe.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  const SITE_URL     = process.env.SITE_URL || `https://${req.headers.host}`;

  // Deterministic-ish referral code: first 5 chars of email + 4 random alphanum
  const prefix = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5);
  const suffix = Math.random().toString(36).substr(2, 4).toUpperCase();
  let refCode = prefix + suffix;

  let spotNumber = 1;
  let isNewUser = true;

  // ── Supabase insert ──────────────────────────────────────────────────────────
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      // Check if user already exists
      const getRes = await fetch(`${SUPABASE_URL}/rest/v1/waitlist?email=eq.${encodeURIComponent(email)}`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      });
      const existing = await getRes.json();

      if (existing && existing.length > 0) {
        isNewUser = false;
        refCode = existing[0].referral_code || refCode; // keep original referral code
        
        // Patch only defined fields so we don't overwrite with nulls
        const updatePayload = {};
        if (name) updatePayload.name = name;
        if (role) updatePayload.role = role;
        if (deals) updatePayload.deals = deals;
        if (bottleneck) updatePayload.bottleneck = bottleneck;
        if (phone) updatePayload.phone = phone;
        
        if (Object.keys(updatePayload).length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/waitlist?email=eq.${encodeURIComponent(email)}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
            body: JSON.stringify(updatePayload),
          });
        }
      } else {
        // Insert new user
        await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer':        'return=minimal',
          },
          body: JSON.stringify({
            email,
            name:          name        || null,
            role:          role        || null,
            deals:         deals       || null,
            bottleneck:    bottleneck  || null,
            phone:         phone       || null,
            referral_code: refCode,
            referred_by:   referredBy  || null,
            referral_url:  `${SITE_URL}?ref=${refCode}`,
          }),
        });
      }

      // Get total count for spot number
      const countRes = await fetch(
        `${SUPABASE_URL}/rest/v1/waitlist?select=id`,
        {
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer':        'count=exact',
            'Range-Unit':    'items',
            'Range':         '0-0',
          },
        }
      );
      const cr = countRes.headers.get('content-range'); // "0-0/47"
      if (cr) spotNumber = parseInt(cr.split('/')[1]) || 1;

    } catch (e) {
      console.error('Supabase error:', e);
      // Non-fatal — still show the funnel
    }
  }

  // ── Resend confirmation email ────────────────────────────────────────────────
  console.log('Resend check — key present:', !!RESEND_KEY, '| isNewUser:', isNewUser);
  if (RESEND_KEY) {
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${RESEND_KEY}`,
        },
        body: JSON.stringify({
          from:    'Project Prep Pro <onboarding@resend.dev>',
          to:      [email],
          subject: `You're in — Spot #${spotNumber} secured`,
          html: `
            <div style="font-family:Georgia,serif;max-width:520px;margin:40px auto;color:#0d0b09;background:#faf9f7;padding:40px;border:1px solid #e8e0d0">
              <p style="font-size:0.7rem;letter-spacing:0.3em;text-transform:uppercase;color:#b8921f;margin:0 0 24px">Project Prep Pro &nbsp;·&nbsp; Metro Atlanta</p>
              <h1 style="font-size:2rem;font-weight:300;margin:0 0 8px;line-height:1.1">You're in.</h1>
              <p style="font-size:1.1rem;color:#b8921f;font-weight:600;margin:0 0 24px">Spot #${spotNumber} secured.</p>
              <p style="color:#555;line-height:1.7;margin:0 0 32px">We'll send your invite the moment the first Metro Atlanta cohort opens. You'll be among the first 200 professionals to shape the platform.</p>
              <p style="color:#333;font-weight:600;margin:0 0 8px">Move up the list &mdash;</p>
              <p style="color:#555;line-height:1.7;margin:0 0 16px">Share your referral link. Every professional who signs up through you moves you closer to the front of the cohort.</p>
              <div style="background:#1a1a14;padding:16px 20px;margin:0 0 8px;font-family:monospace;font-size:0.85rem;color:#b8921f;word-break:break-all">
                ${SITE_URL}?ref=${refCode}
              </div>
              <p style="font-size:0.78rem;color:#999;margin:0 0 32px">2 referrals = Priority Access &nbsp;·&nbsp; 5 referrals = Founding Member status</p>
              <hr style="border:none;border-top:1px solid #e8e0d0;margin:0 0 24px">
              <p style="font-size:0.72rem;color:#bbb;margin:0">You're receiving this because you joined the Project Prep Pro waitlist. Reply to unsubscribe.</p>
            </div>
          `,
        }),
      });
      const resendBody = await resendRes.json();
      console.log('Resend response:', resendRes.status, JSON.stringify(resendBody));
    } catch (e) {
      console.error('Resend error:', e);
    }
  }

  return res.status(200).json({
    ok:           true,
    spotNumber,
    referralCode: refCode,
    referralUrl:  `${SITE_URL}?ref=${refCode}`,
  });
}
