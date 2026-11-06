/**
 * Devil Dash — POST /api/webhook
 *
 * Stripe webhook receiver. Verifies the Stripe signature by hand
 * (HMAC-SHA256, zero-dependency) and records completed checkouts.
 *
 * On checkout.session.completed for a Devil Dash payment, it writes one
 * structured line to the function log:
 *   [DEVILDASH_PAID] {"type":"job_paid", ...}
 * View it in Vercel → devil-dash → Logs. That log line is the v1 record
 * of the paid job (job ref, amounts, customer email, session id).
 *
 * SMS notification: there is no SMS provider configured for these
 * functions, so the webhook does NOT text Chad. Ops flow in v1: the
 * customer lands on the pay.html success page, and the paid job is
 * confirmed in the Vercel log + the Stripe dashboard. The customer's
 * job thread already lives in Chad's texts (602-500-0246) — he matches
 * the job ref from the log/Stripe to the text thread.
 *
 * Env vars (Vercel project settings — never commit):
 *   STRIPE_WEBHOOK_SECRET  (required) whsec_... for THIS endpoint.
 *   STRIPE_SECRET_KEY      (not needed here)
 */

const crypto = require('crypto');

const SIGNATURE_TOLERANCE_SECONDS = 300; // Stripe's recommended 5 minutes

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  // Fallback if a body parser ran first (config below should prevent this):
  // re-serialize the parsed JSON. Signature check may fail on exotic payloads,
  // in which case Stripe retries and the raw path handles it.
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body), 'utf8');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseSignatureHeader(header) {
  const out = { timestamp: null, signatures: [] };
  if (!header) return out;
  for (const part of String(header).split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') out.timestamp = v;
    if (k === 'v1') out.signatures.push(v);
  }
  return out;
}

function verifySignature(rawBody, header, secret) {
  const { timestamp, signatures } = parseSignatureHeader(header);
  if (!timestamp || signatures.length === 0) return { ok: false, reason: 'missing_signature_parts' };
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const match = signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
  return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

// Exported for local unit tests; ignored by Vercel.
module.exports._internals = { verifySignature, parseSignatureHeader };
module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return sendJson(res, 503, { error: 'webhook_not_configured' });
  }

  const rawBody = await readRawBody(req);
  const check = verifySignature(rawBody, req.headers['stripe-signature'], webhookSecret);
  if (!check.ok) {
    console.warn('[devildash] webhook signature rejected:', check.reason);
    return sendJson(res, 400, { error: 'invalid_signature', reason: check.reason });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return sendJson(res, 400, { error: 'bad_json' });
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data && event.data.object ? event.data.object : {};
    const meta = s.metadata || {};
    if (meta.source === 'devil-dash-pay' || s.client_reference_id) {
      const record = {
        type: 'job_paid',
        job_ref: meta.job_ref || s.client_reference_id || null,
        amount_total_cents: s.amount_total,
        currency: s.currency,
        dasher_fee_cents: meta.dasher_fee_cents ? Number(meta.dasher_fee_cents) : null,
        service_fee_cents: meta.service_fee_cents ? Number(meta.service_fee_cents) : null,
        payment_status: s.payment_status,
        customer_email: (s.customer_details && s.customer_details.email) || null,
        checkout_session_id: s.id,
        payment_intent: s.payment_intent,
        paid_at: new Date().toISOString()
      };
      // v1 record of the paid job (Vercel function log + Stripe dashboard).
      console.log('[DEVILDASH_PAID] ' + JSON.stringify(record));
    }
  }

  return sendJson(res, 200, { received: true });
};
