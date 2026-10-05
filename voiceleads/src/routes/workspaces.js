// CRM: leads CRUD + CSV import/export, campaigns, call history, usage metering,
// per-workspace provider key storage (encrypted at rest).
import { Router } from 'express';
import { z } from 'zod';
import { getDb, id, audit } from '../lib/db.js';
import { requireAuth, requireWorkspace } from '../lib/auth.js';
import { encryptSecret } from '../lib/crypto.js';
import { dialOutbound, activeCarrier } from '../lib/telephony.js';
import { tts } from '../lib/elevenlabs.js';
import { testConnection as testGemini } from '../lib/gemini.js';
import { finalizeCall } from '../lib/telephony.js';

export function workspaceRoutes() {
  const r = Router();
  r.use(requireAuth);

  // ---- entitlements -------------------------------------------------------
  function guard(req, res, next) {
    const db = getDb();
    const sub = db.prepare(`SELECT s.*, p.included_minutes FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.workspace_id=? AND s.status IN ('trialing','active') ORDER BY s.current_period_end DESC LIMIT 1`)
      .get(req.workspaceId);
    if (!sub || sub.current_period_end < Date.now())
      return res.status(402).json({ error: 'subscription required — pay with bKash to continue' });
    const usedMin = db.prepare(`SELECT COALESCE(SUM(qty),0) m FROM usage_events
      WHERE workspace_id=? AND type='call_minute' AND created_at > datetime('now','-30 days')`).get(req.workspaceId).m;
    req.entitlement = { sub, minutesUsed: usedMin, minutesLeft: sub.included_minutes - usedMin };
    if (usedMin >= sub.included_minutes && !process.env.ALLOW_OVERAGE)
      return res.status(402).json({ error: 'monthly minute quota exhausted' });
    next();
  }

  // ---- subscription status shortcut --------------------------------------
  r.get('/:wsId/entitlements', requireWorkspace('member'), (req, res) => res.json(req.entitlement ?? {}));
  r.use('/:wsId', requireWorkspace('member'), guard);

  // ---- leads --------------------------------------------------------------
  r.get('/:wsId/leads', (req, res) => {
    const { intent, q } = req.query;
    const rows = getDb().prepare(`SELECT * FROM leads WHERE workspace_id=?
      AND (? IS NULL OR intent=?) AND (? IS NULL OR phone LIKE '%'||?||'%' OR name LIKE '%'||?||'%')
      ORDER BY updated_at DESC LIMIT 500`).all(req.workspaceId, intent || null, intent || null, q || null, q || null, q || null);
    res.json(rows.map(l => ({ ...l, tags: safeJson(l.tags), custom: safeJson(l.custom) })));
  });

  r.post('/:wsId/leads', (req, res) => {
    const b = z.object({ phone: z.string().regex(/^[+0-9 -]{7,20}$/), name: z.string().max(120).optional(),
      company: z.string().max(120).optional(), source: z.string().max(40).default('manual'),
      consent: z.boolean().default(false) }).parse(req.body);
    const db = getDb();
    db.prepare(`INSERT INTO leads (id, workspace_id, phone, name, company, source, consented_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id, phone) DO UPDATE SET name=excluded.name, company=excluded.company`)
      .run(id('lead_'), req.workspaceId, b.phone, b.name || null, b.company || null, b.source,
           b.consent ? new Date().toISOString() : null);
    res.json({ ok: true });
  });

  // CSV import: "phone,name,company" header row. Max 5k rows/request.
  r.post('/:wsId/leads/import', (req, res) => {
    const text = String(req.body.csv || '').slice(0, 2_000_000);
    const lines = text.split(/\r?\n/).filter(Boolean);
    const head = (lines.shift() || '').toLowerCase();
    if (!head.includes('phone')) return res.status(422).json({ error: 'csv needs a phone column' });
    const cols = head.split(',').map(s => s.trim());
    const db = getDb();
    let n = 0;
    const ins = db.prepare(`INSERT INTO leads (id, workspace_id, phone, name, company, source, consented_at)
      VALUES (?,?,?,?,?, 'import', datetime('now')) ON CONFLICT(workspace_id, phone) DO UPDATE SET
      name=COALESCE(excluded.name,name), company=COALESCE(excluded.company,company)`);
    for (const line of lines.slice(0, 5000)) {
      const v = line.split(',');
      const phone = (v[cols.indexOf('phone')] || '').trim();
      if (!/^[+0-9 -]{7,20}$/.test(phone)) continue;
      ins.run(id('lead_'), req.workspaceId, phone, (v[cols.indexOf('name')] || '').trim() || null,
              (v[cols.indexOf('company')] || '').trim() || null);
      n++;
    }
    audit({ workspace_id: req.workspaceId, user_id: req.user.id, action: 'leads_import', ip: req.ip, meta: { n } });
    res.json({ imported: n });
  });

  r.get('/:wsId/leads/export', (req, res) => {
    const rows = getDb().prepare('SELECT phone,name,company,score,intent,source,updated_at FROM leads WHERE workspace_id=?').all(req.workspaceId);
    res.setHeader('content-type', 'text/csv');
    res.send(['phone,name,company,score,intent,source,updated_at',
      ...rows.map(x => [x.phone, x.name, x.company, x.score, x.intent, x.source, x.updated_at].join(','))].join('\n'));
  });

  // ---- campaigns -----------------------------------------------------------
  r.get('/:wsId/campaigns', (req, res) => {
    res.json(getDb().prepare('SELECT * FROM campaigns WHERE workspace_id=? ORDER BY created_at DESC').all(req.workspaceId));
  });

  r.post('/:wsId/campaigns', requireWorkspace('admin'), (req, res) => {
    const b = z.object({ name: z.string().min(2).max(80), goal_prompt: z.string().min(10).max(4000),
      voice_id: z.string().max(60).optional(), max_minutes_per_day: z.number().int().min(1).max(600).default(120) })
      .parse(req.body);
    const cid = id('camp_');
    getDb().prepare(`INSERT INTO campaigns (id, workspace_id, name, status, goal_prompt, voice_id, max_minutes_per_day)
      VALUES (?,?,?,'draft',?,?,?)`).run(cid, req.workspaceId, b.name, b.goal_prompt, b.voice_id || null, b.max_minutes_per_day);
    res.json({ id: cid });
  });

  r.post('/:wsId/campaigns/:campId/start', requireWorkspace('admin'), async (req, res) => {
    const db = getDb();
    const camp = db.prepare(`SELECT * FROM campaigns WHERE id=? AND workspace_id=?`).get(req.params.campId, req.workspaceId);
    if (!camp) return res.status(404).json({ error: 'no campaign' });
    if (activeCarrier() === 'mock') {
      // dev mode: simulate one dial so the pipeline is testable without a carrier
      const lead = db.prepare(`SELECT * FROM leads WHERE workspace_id=? AND consented_at IS NOT NULL LIMIT 1`).get(req.workspaceId);
      if (!lead) return res.status(422).json({ error: 'no consented leads to dial (mock)' });
      const out = await dialOutbound({ workspaceId: req.workspaceId, campaignId: camp.id, leadId: lead.id, toNumber: lead.phone });
      db.prepare(`UPDATE campaigns SET status='running' WHERE id=?`).run(camp.id);
      // Run the SAME post-call pipeline real carriers use: Gemini extracts a structured
      // lead from the (mock) transcript and minutes get metered against your quota.
      const finalized = await finalizeCall(out.callId).catch(e => ({ error: String(e.message || e) }));
      return res.json({ ok: true, simulated: out, extraction: finalized?.extracted_json ? JSON.parse(finalized.extracted_json) : null });
    }
    // real carriers: mark running; the worker does paced dialing respecting quiet hours.
    db.prepare(`UPDATE campaigns SET status='running' WHERE id=?`).run(camp.id);
    res.json({ ok: true, note: 'worker will dial consented leads in batches' });
  });

  r.post('/:wsId/campaigns/:campId/pause', requireWorkspace('admin'), (req, res) => {
    getDb().prepare(`UPDATE campaigns SET status='paused' WHERE id=? AND workspace_id=?`).run(req.params.campId, req.workspaceId);
    res.json({ ok: true });
  });

  // ---- calls / transcripts / recordings ------------------------------------
  r.get('/:wsId/calls', (req, res) => {
    res.json(getDb().prepare(`SELECT c.*, l.name lead_name FROM calls c LEFT JOIN leads l ON l.id=c.lead_id
      WHERE c.workspace_id=? ORDER BY c.started_at DESC NULLS LAST LIMIT 200`).all(req.workspaceId));
  });

  // ElevenLabs TTS preview (voice audition before wiring a campaign)
  r.post('/:wsId/tts', async (req, res) => {
    const b = z.object({ text: z.string().min(1).max(2500), voice_id: z.string().max(60).optional() }).parse(req.body);
    try {
      const audio = await tts({ workspaceId: req.workspaceId, text: b.text, voiceId: b.voice_id });
      res.setHeader('content-type', 'audio/mpeg'); res.send(audio);
    } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
  });

  // ---- usage dashboard data --------------------------------------------------
  r.get('/:wsId/usage', (req, res) => {
    const db = getDb();
    const totals = db.prepare(`SELECT type, SUM(qty) qty FROM usage_events WHERE workspace_id=? GROUP BY type`).all(req.workspaceId);
    const daily = db.prepare(`SELECT substr(created_at,1,10) d, SUM(CASE WHEN type='call_minute' THEN qty ELSE 0 END) minutes,
      COUNT(*) events FROM usage_events WHERE workspace_id=? AND created_at > datetime('now','-30 days')
      GROUP BY d ORDER BY d`).all(req.workspaceId);
    const hotLeads = db.prepare(`SELECT COUNT(*) n FROM leads WHERE workspace_id=? AND intent='hot'`).get(req.workspaceId).n;
    res.json({ totals, daily, hotLeads, entitlement: req.entitlement && { minutesLeft: req.entitlement.minutesLeft } });
  });

  // ---- per-workspace encrypted API keys ---------------------------------------
  r.put('/:wsId/credentials/:provider', requireWorkspace('owner'), (req, res) => {
    const provider = ['gemini', 'anthropic', 'elevenlabs', 'vapi', 'twilio'].includes(req.params.provider) ? req.params.provider : null;
    if (!provider) return res.status(422).json({ error: 'bad provider' });
    const secret = z.string().min(10).max(300).parse(req.body.secret);
    getDb().prepare(`INSERT INTO credentials (workspace_id, provider, secret_enc, hint) VALUES (?,?,?,?)
      ON CONFLICT(workspace_id, provider) DO UPDATE SET secret_enc=excluded.secret_enc, hint=excluded.hint`)
      .run(req.workspaceId, provider, encryptSecret(secret), secret.slice(-4));
    audit({ workspace_id: req.workspaceId, user_id: req.user.id, action: 'key_store', ip: req.ip, meta: { provider } });
    res.json({ ok: true, hint: secret.slice(-4) }); // never echo the key back
  });

  // ---- Gemini sanity check: is my free API key working end-to-end? ----------
  r.get('/:wsId/gemini/test', async (req, res) => {
    try {
      const out = await testGemini(req.workspaceId);
      res.json(out);
    } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  return r;
}

function safeJson(v) { try { return JSON.parse(v); } catch { return v; } }
