/**
 * Devil Dash — POST /api/create-checkout
 *
 * Creates a Stripe Checkout Session for one agreed job.
 *
 * Pay model (locked by Chad, 2026-10-23):
 *   - The dasher sets their fee and keeps 100% of it.
 *   - The customer pays dasher fee + a FLAT Devil Dash service fee.
 *   - Service fee = SERVICE_FEE_CENTS (single source of truth — change here only).
 *
 * Money goes to Chad's Stripe account (acct_1TsHBeCXK9iNU3DY, "Crown Cartel").
 * Dasher payouts are handled by Chad in v1 (same as the text-in flow);
 * automatic Connect payouts are a future phase.
 *
 * Env vars (Vercel project settings — never commit):
 *   STRIPE_SECRET_KEY   (required) sk_live_... or sk_test_...
 *   SITE_ORIGIN         (optional) defaults to the production URL below.
 *
 * Zero-dependency: talks to api.stripe.com with fetch + form encoding,
 * so the GitHub-upload deploy pipeline needs no package.json / build step.
 */

const SERVICE_FEE_CENTS = 300; // FLAT $3.00 Devil Dash service fee on every order.
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://devil-dash-tat2face.vercel.app';
const MIN_DASHER_FEE_CENTS = 100;      // $1.00 floor — below this a card charge makes no sense
const MAX_DASHER_FEE_CENTS = 100000;   // $1,000.00 sanity ceiling for a single local job

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function encodeForm(params, prefix, out) {
  out = out || [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'object') encodeForm(v, `${name}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(v)}`);
      });
    } else if (typeof value === 'object') {
      encodeForm(value, name, out);
    } else {
      out.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }
  return out;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function validate(input) {
  const errors = [];
  const jobRef = typeof input.jobRef === 'string' ? input.jobRef.trim() : '';
  if (!jobRef || jobRef.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9\-_ ]*$/.test(jobRef)) {
    errors.push('jobRef must be 1-64 chars: letters, numbers, dashes, underscores, spaces.');
  }
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length > 300) errors.push('summary must be 300 characters or fewer.');
  const dasherFeeCents = input.dasherFeeCents;
  if (!Number.isInteger(dasherFeeCents) ||
      dasherFeeCents < MIN_DASHER_FEE_CENTS ||
      dasherFeeCents > MAX_DASHER_FEE_CENTS) {
    errors.push(`dasherFeeCents must be an integer between ${MIN_DASHER_FEE_CENTS} and ${MAX_DASHER_FEE_CENTS}.`);
  }
  return { errors, jobRef, summary, dasherFeeCents };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST.' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    // Gate signal: the function is deployed but the key has not been set in
    // Vercel env vars yet. pay.html turns this into a "text us instead" message.
    return sendJson(res, 503, {
      error: 'stripe_not_configured',
      message: 'Card payments are not switched on yet.'
    });
  }

  let input;
  try {
    input = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'bad_json', message: 'Request body must be JSON.' });
  }

  const { errors, jobRef, summary, dasherFeeCents } = validate(input || {});
  if (errors.length) {
    return sendJson(res, 400, { error: 'validation_failed', details: errors });
  }

  const serviceFeeCents = SERVICE_FEE_CENTS;
  const totalCents = dasherFeeCents + serviceFeeCents;
  const jobLabel = summary || `Devil Dash job ${jobRef}`;

  const form = encodeForm({
    mode: 'payment',
    success_url: `${SITE_ORIGIN}/pay.html?status=success&ref=${encodeURIComponent(jobRef)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE_ORIGIN}/pay.html?status=cancelled&ref=${encodeURIComponent(jobRef)}`,
    client_reference_id: jobRef,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: dasherFeeCents,
          product_data: {
            name: `Devil Dash — ${jobLabel}`,
            description: 'Dasher fee — paid for the job you agreed by text. Dasher keeps 100% of this fee.'
          }
        }
      },
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: serviceFeeCents,
          product_data: {
            name: 'Devil Dash service fee',
            description: 'Flat $3.00 platform fee.'
          }
        }
      }
    ],
    metadata: {
      source: 'devil-dash-pay',
      job_ref: jobRef,
      dasher_fee_cents: String(dasherFeeCents),
      service_fee_cents: String(serviceFeeCents)
    },
    payment_intent_data: {
      metadata: {
        source: 'devil-dash-pay',
        job_ref: jobRef,
        dasher_fee_cents: String(dasherFeeCents),
        service_fee_cents: String(serviceFeeCents)
      }
    }
  }).join('&');

  let stripeRes;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form
    });
  } catch (e) {
    return sendJson(res, 502, { error: 'stripe_unreachable', message: 'Could not reach Stripe. Try again or text 602-500-0246.' });
  }

  const session = await stripeRes.json().catch(() => null);
  if (!stripeRes.ok || !session || !session.url) {
    const stripeMsg = session && session.error ? session.error.message : 'Unknown Stripe error.';
    console.error('[devildash] checkout session failed:', stripeMsg);
    return sendJson(res, 502, { error: 'stripe_error', message: stripeMsg });
  }

  return sendJson(res, 200, {
    url: session.url,
    sessionId: session.id,
    jobRef,
    dasherFeeCents,
    serviceFeeCents,
    totalCents
  });
};

// Exported for local unit tests; ignored by Vercel.
module.exports._internals = { SERVICE_FEE_CENTS, validate, encodeForm };
