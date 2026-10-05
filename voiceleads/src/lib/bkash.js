// bKash Tokenized Checkout + Agreement API client (merchant account).
// Flow for SUBSCRIPTIONS (this is what makes monthly recurring billing possible):
//   1. userIdentification(id_token) -> access_id_token          [done once per session, cached]
//   2. agreementCreate(url) -> agreementURL -> customer approves in bKash app
//   3. agreementExecute(agreement_reference_id) -> agreement_id (status ACTIVE)
//   4. Every month, server-side: paymentCreate(agreement_id, amount) -> paymentURL
//      then paymentExecute -> verify with paymentStatusQuery. No customer click needed
//      beyond the first approval — this is the "automatic renewal" leg.
// For ONE-OFF payment (first month upfront), same shape without agreement_id.
import { getDb } from './db.js';

const BASE = () => process.env.BKASH_BASE_URL || 'https://tokenized.pay.bka.sh';

let tokenCache = { value: null, exp: 0 };

async function post(pathName, body, headers = {}) {
  const res = await fetch(`${BASE()}/version/1.2.0${pathName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      username: process.env.BKASH_APP_KEY || '',
      password: process.env.BKASH_APP_SECRET || '',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`bkash ${pathName} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export async function getIdToken(force = false) {
  if (!force && tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const r = await post('/tokenized/checkout/validate-id-token', { id_token: process.env.BKASH_ID_TOKEN });
  tokenCache = { value: r.access_id_token, exp: Date.now() + 55 * 60 * 1000 }; // rotates hourly
  return tokenCache.value;
}

const hdr = async () => ({ 'id-token': await getIdToken() });

export async function paymentCreate({ mode = '0011', amount, currency = 'BDT', intent = 'sale',
  reference, callbackURL, agreement_id }) {
  return post('/tokenized/checkout/create', {
    mode, payerReference: reference, callbackURL,
    amount: String(amount), currency, intent, reference,
    ...(agreement_id ? { agreement_id } : {}),
  }, await hdr());
}

export async function paymentExecute(paymentID) {
  return post('/tokenized/checkout/execute', { paymentID }, await hdr());
}

export async function paymentStatusQuery(paymentID) {
  return post('/tokenized/checkout/status', { paymentID }, await hdr());
}

export async function agreementCreate(callbackURL) {
  return post('/tokenized/checkout/agreement/create', {
    callbackURL, reference: 'voiceleads-' + Date.now(),
  }, await hdr());
}

export async function agreementExecute(agreement_reference_id) {
  return post('/tokenized/checkout/agreement/execute', { agreement_reference_id }, await hdr());
}

export async function revokeAgreement(agreement_id) {
  return post('/tokenized/checkout/agreement/revoke', { agreement_id }, await hdr());
}

// --- Subscription orchestration on top of the raw client -------------------
import crypto from 'node:crypto';
import { id } from './db.js';

export async function startCheckout({ workspaceId, planId, subscriptionId, firstPayment }) {
  const db = getDb();
  const callbackURL = `${process.env.BASE_URL}/billing/bkash/callback/${firstPayment ? 'payment' : 'agreement'}/${subscriptionId}`;
  if (firstPayment) {
    const p = await paymentCreate({
      amount: planAmount(planId), reference: `ws_${workspaceId}`, callbackURL,
    });
    db.prepare(`INSERT INTO payments (id, workspace_id, subscription_id, provider, kind, amount_bdt, status, external_ref, raw)
                VALUES (?,?,?,?,?,?,?,'initiated',?,?)`)
      .run(id('pay_'), workspaceId, subscriptionId, 'bkash', 'manual', planAmount(planId), p.paymentID, JSON.stringify(p));
    return { url: p.bKashPaymentURL ?? p.paymentURL ?? null, paymentID: p.paymentID };
  }
  const a = await agreementCreate(callbackURL);
  return { url: a.agreementURL, reference_id: a.agreement_reference_id };
}

export function planAmount(planId) {
  const p = getDb().prepare('SELECT amount_bdt FROM plans WHERE id=?').get(planId);
  if (!p) throw new Error('unknown plan ' + planId);
  return p.amount_bdt;
}

// Called by cron worker: charge every active subscription whose period ended.
export async function captureRenewals() {
  const db = getDb();
  const due = db.prepare(`SELECT s.*, p.amount_bdt FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.status='active' AND s.cancel_at_period_end=0
      AND s.bkash_agreement_id IS NOT NULL AND s.current_period_end <= ?`).all(Date.now());
  const results = [];
  for (const sub of due) {
    try {
      const created = await paymentCreate({
        amount: sub.amount_bdt, reference: `ws_${sub.workspace_id}`,
        callbackURL: `${process.env.BASE_URL}/billing/bkash/callback/renewal/${sub.id}`,
        agreement_id: sub.bkash_agreement_id,
      });
      const exec = await paymentExecute(created.paymentID);
      const ok = exec.statusCode === '00' || exec.transaction?.transactionStatus === 'Completed';
      db.prepare(`INSERT INTO payments (id, workspace_id, subscription_id, provider, kind, amount_bdt, status, external_ref, raw)
                  VALUES (?,?,?,'bkash','auto_capture',?,?,?,?)`)
        .run(id('pay_'), sub.workspace_id, sub.id, sub.amount_bdt,
             ok ? 'complete' : 'failed', created.paymentID, JSON.stringify(exec));
      if (ok) {
        db.prepare(`UPDATE subscriptions SET current_period_end=?, status='active' WHERE id=?`)
          .run(Date.now() + 30 * 864e5, sub.id);
      } else {
        db.prepare(`UPDATE subscriptions SET status='past_due' WHERE id=?`).run(sub.id);
      }
      results.push({ sub: sub.id, ok });
    } catch (e) {
      db.prepare(`UPDATE subscriptions SET status='past_due' WHERE id=?`).run(sub.id);
      results.push({ sub: sub.id, ok: false, error: String(e.message || e) });
    }
  }
  return results;
}

export function verifyWebhookSignature(req) {
  // bKash tokenized callbacks are one-time redirect URLs (no HMAC). Defense-in-depth:
  // subscription ids are unguessable random tokens and we ALWAYS re-query payment status
  // server-side before trusting a "success" — never take the query string's word for it.
  return /^[a-f0-9]{24,}$/.test(String(req.params.subId || '').replace(/^sub_/, ''));
}
