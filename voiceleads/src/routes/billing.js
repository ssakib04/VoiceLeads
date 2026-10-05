// Subscription billing with bKash: plans, checkout (first payment), mandate agreement
// (auto-renewal), callbacks (re-verified server-side), cancel.
import { Router } from 'express';
import { z } from 'zod';
import { getDb, id, audit } from '../lib/db.js';
import { requireAuth, requireWorkspace, roleIn } from '../lib/auth.js';
import * as bk from '../lib/bkash.js';

export function billingRoutes() {
  const r = Router();

  r.get('/plans', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM plans WHERE active=1').all());
  });

  // Start subscription: creates pending sub -> bKash payment URL + agreement URL.
  r.post('/checkout', requireAuth, (req, res) => {
    const { workspace_id, plan_id } = z.object({ workspace_id: z.string(), plan_id: z.string() }).parse(req.body);
    const role = getDb().prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?')
      .get(workspace_id, req.user.id)?.role;
    if (!role) return res.status(403).json({ error: 'forbidden' });
    const plan = getDb().prepare('SELECT * FROM plans WHERE id=? AND active=1').get(plan_id);
    if (!plan) return res.status(404).json({ error: 'unknown plan' });
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM subscriptions WHERE workspace_id=? AND status IN ('pending_payment','active','trialing')`)
      .get(workspace_id);
    if (existing && existing.status === 'active') return res.status(409).json({ error: 'already subscribed' });
    const subId = existing?.status === 'pending_payment' ? existing.id : id('sub_');
    if (!existing) db.prepare(`INSERT INTO subscriptions (id, workspace_id, plan_id, status) VALUES (?,?,?,'pending_payment')`)
      .run(subId, workspace_id, plan_id);
    else db.prepare(`UPDATE subscriptions SET plan_id=?, status='pending_payment' WHERE id=?`).run(plan_id, subId);
    audit({ workspace_id, user_id: req.user.id, action: 'checkout_start', ip: req.ip, meta: { plan_id } });
    res.json({ subscriptionId: subId, amount_bdt: plan.amount_bdt, plan: plan.name });
  });

  // Ask bKash for a payment URL for this pending subscription (customer pays first month).
  r.post('/bkash/payment-url', requireAuth, requireWorkspace('member'), async (req, res) => {
    const subId = z.object({ subscription_id: z.string() }).parse(req.body).subscription_id;
    const sub = getDb().prepare('SELECT * FROM subscriptions WHERE id=? AND workspace_id=?').get(subId, req.workspaceId);
    if (!sub) return res.status(404).json({ error: 'no such subscription' });
    try {
      const out = await bk.startCheckout({ workspaceId: req.workspaceId, planId: sub.plan_id,
        subscriptionId: subId, firstPayment: true });
      res.json(out); // { url, paymentID } — redirect the browser to `url`
    } catch (e) { res.status(502).json({ error: 'bkash unavailable', detail: String(e.message || e) }); }
  });

  // Mandate (auto-renewal) approval URL.
  r.post('/bkash/agreement-url', requireAuth, requireWorkspace('member'), async (req, res) => {
    const subId = z.object({ subscription_id: z.string() }).parse(req.body).subscription_id;
    try {
      const out = await bk.startCheckout({ workspaceId: req.workspaceId, planId: '', subscriptionId: subId, firstPayment: false });
      res.json(out); // { url: agreementURL, reference_id }
    } catch (e) { res.status(502).json({ error: 'bkash unavailable', detail: String(e.message || e) }); }
  });

  // ---- Callbacks registered in bKash dashboard ----------------------------
  // bKash redirects here after customer approves. NEVER trust query params alone:
  // we re-query payment/agreement status against bKash API before activating.
  r.get('/bkash/callback/:kind/:subId', async (req, res) => {
    const { kind, subId } = req.params;
    if (!bk.verifyWebhookSignature(req)) return res.status(400).send('bad request');
    const db = getDb();
    const sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(subId);
    if (!sub) return res.status(404).send('unknown subscription');
    let html = '<h2>Payment failed</h2><p>Please try again.</p>';
    try {
      if (kind === 'payment' || kind === 'renewal') {
        const paymentID = req.query.paymentID || req.query.payment_id;
        const exec = await bk.paymentExecute(paymentID);              // authoritative verify
        const ok = exec.statusCode === '00' || exec.transaction?.transactionStatus === 'Completed';
        db.prepare(`UPDATE payments SET status=?, raw=? WHERE external_ref=? AND subscription_id=?`)
          .run(ok ? 'complete' : 'failed', JSON.stringify(exec), paymentID, subId);
        if (ok) {
          db.prepare(`UPDATE subscriptions SET status='active', current_period_end=? WHERE id=?`)
            .run(Date.now() + 30 * 864e5, subId);
          html = '<h2>Payment successful ✅</h2><p>Your subscription is active. Close this window.</p>';
        }
      } else if (kind === 'agreement') {
        const refId = req.query.agreement_reference_id || req.query.reference_id;
        const exec = await bk.agreementExecute(refId);                 // authoritative verify
        if (exec.statusCode === '00' && exec.status === 'ACTIVE') {
          db.prepare('UPDATE subscriptions SET bkash_agreement_id=? WHERE id=?').run(exec.agreement_id, subId);
          html = '<h2>Auto-renewal enabled ✅</h2><p>You will be charged monthly via bKash.</p>';
        }
      }
    } catch (e) { console.error('bkash callback', e); }
    db.prepare('INSERT INTO webhooks_log (id, source, event_type, payload, processed) VALUES (?,?,?,?,1)')
      .run(id('whl_'), 'bkash', kind, JSON.stringify({ ...req.query, subId }));
    audit({ workspace_id: sub.workspace_id, action: `bkash_callback_${kind}`, ip: req.ip });
    res.type('html').send(`<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">${html}</body></html>`);
  });

  r.get('/status', requireAuth, (req, res) => {
    const wsId = req.query.workspace_id || req.query.ws;
    if (!wsId || !roleIn(wsId, req.user.id)) return res.status(403).json({ error: 'forbidden' });
    req.workspaceId = wsId;
    const sub = getDb().prepare(`SELECT s.*, p.name plan_name, p.amount_bdt, p.included_minutes
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.workspace_id=?
      ORDER BY s.created_at DESC LIMIT 1`).get(req.workspaceId);
    const payments = getDb().prepare(`SELECT id, kind, amount_bdt, status, created_at FROM payments
      WHERE workspace_id=? ORDER BY created_at DESC LIMIT 12`).all(req.workspaceId);
    res.json({ subscription: sub, payments });
  });

  r.post('/cancel', requireAuth, requireWorkspace('admin'), async (req, res) => {
    const db = getDb();
    const sub = db.prepare(`SELECT * FROM subscriptions WHERE workspace_id=? AND status IN ('active','trialing','past_due')`)
      .get(req.workspaceId);
    if (!sub) return res.status(404).json({ error: 'nothing to cancel' });
    db.prepare(`UPDATE subscriptions SET cancel_at_period_end=1 WHERE id=?`).run(sub.id);
    if (sub.bkash_agreement_id) { try { await bk.revokeAgreement(sub.bkash_agreement_id); } catch {} }
    audit({ workspace_id: req.workspaceId, user_id: req.user.id, action: 'cancel_subscription', ip: req.ip });
    res.json({ ok: true, valid_until: sub.current_period_end });
  });

  return r;
}
