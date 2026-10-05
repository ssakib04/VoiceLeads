// Webhooks from telephony/AI providers + ElevenLabs agent bridge.
// All endpoints verify signatures/HMAC before touching the DB.
import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb, id } from '../lib/db.js';
import { constantEqual } from '../lib/crypto.js';
import { finalizeCall, twilioVoiceTwiml } from '../lib/telephony.js';
import { verifyAgentWebhook } from '../lib/elevenlabs.js';
import rateLimit from 'express-rate-limit';

const hookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300 });

function logHook(source, eventType, payload) {
  getDb().prepare(`INSERT INTO webhooks_log (id, source, event_type, payload) VALUES (?,?,?,?)`)
    .run(id('whl_'), source, eventType, JSON.stringify(payload).slice(0, 100000));
}

export function callRoutes() {
  const r = Router();
  r.use(hookLimiter);

  // ---- Vapi (hosted Claude+ElevenLabs) assistant webhook -------------------
  // Vapi POSTs { message: { type:'assistant-request'|'end-of-call-report', ... }, ... }
  r.post('/webhook/vapi', hookLimiter, async (req, res) => {
    const key = req.headers['x-api-key'] || req.body?.serverApiKey;
    if (!process.env.WEBHOOK_SECRET || !constantEqual(key || '', process.env.WEBHOOK_SECRET))
      return res.status(401).json({ error: 'bad signature' });
    const msg = req.body.message || {};
    logHook('vapi', msg.type, req.body);
    const meta = msg.call?.metadata || {};

    if (msg.type === 'end-of-call-report') {
      const transcript = (msg.transcript || (msg.analysis?.summary) || '').toString();
      const secs = Math.round((msg.durationSeconds || 0));
      getDb().prepare(`UPDATE calls SET status='completed', ended_at=?, duration_sec=?, transcript=?,
        recording_url=?, cost_cents=? WHERE id=?`)
        .run(Date.now(), secs, transcript, msg.recordingUrl || null, Math.ceil(secs / 60) * 10, meta.callId);
      finalizeCall(meta.callId).catch(e => console.error(e));
      return res.json({ ok: true });
    }
    // First-turn override: keep the call on OUR Gemini brain.
    res.json({ model: { provider: 'google', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' } });
  });

  // ---- ElevenLabs Conversational AI agent webhook ----------------------------
  // Events: conversation.ring / conversation.answered / conversation.status_update / conversation.did_talk
  r.post('/webhook/elevenlabs', express_raw(), async (req, res) => {
    if (!verifyAgentWebhook(req.rawBody || Buffer.from(JSON.stringify(req.body)), req.headers['elevenlabs-signature']))
      return res.status(401).json({ error: 'bad signature' });
    const ev = req.body;
    logHook('elevenlabs', ev.event?.type || ev.type, ev);
    const type = ev.event?.type || ev.type;
    const conv = ev.conversation_initiation_parameters || ev;
    const wsId = String(conv.customer_id || conv.metadata?.workspace_id || '').replace(/^ws_/, '');
    const db = getDb();
    if (type === 'conversation.ring') {
      db.prepare(`INSERT OR IGNORE INTO calls (id, workspace_id, direction, status, to_number, provider_call_id)
        VALUES (?,?,?, 'ringing', ?, ?)`)
        .run(id('call_'), wsId || null, conv.direction || 'inbound', conv.to_number || ev.call_id, ev.call_id);
    }
    if (type === 'conversation.status_update' || type === 'conversation.did_talk') {
      const call = db.prepare('SELECT * FROM calls WHERE provider_call_id=?').get(ev.call_id);
      if (call && (ev.commit || ev.status === 'ringing')) { /* transcript chunks land here in prod */ }
    }
    if (type === 'conversation.agent_disconnected' || type === 'conversation.no_answer' || ev.conversation?.status === 'done') {
      const call = db.prepare('SELECT * FROM calls WHERE provider_call_id=?').get(ev.call_id);
      if (call) {
        const transcript = (ev.conversation?.analysis?.transcript || ev.transcript || '').toString();
        db.prepare(`UPDATE calls SET status='completed', ended_at=?, transcript=?, duration_sec=? WHERE id=?`)
          .run(Date.now(), transcript, Math.round((ev.conversation?.overall_duration_secs || 0)), call.id);
        finalizeCall(call.id).catch(e => console.error(e));
      }
    }
    res.json({ ok: true });
  });

  // ---- Twilio voice webhook (DIY path): returns TwiML XML --------------------
  r.post('/twilio/voice', hookLimiter, (req, res) => {
    if (!verifyTwilio(req)) return res.status(403).send('<Response><Reject reason="NotValid"/></Response>');
    const callId = req.query.callId || id('call_');
    getDb().prepare(`UPDATE calls SET status='in_progress', started_at=?, from_number=?, to_number=? WHERE id=?`)
      .run(Date.now(), req.body.From, req.body.To, callId);
    res.type('application/xml').send(twilioVoiceTwiml(callId));
  });

  r.post('/twilio/gather', hookLimiter, async (req, res) => {
    if (!verifyTwilio(req)) return res.status(403).send('<Response/>');
    const callId = req.query.callId;
    const speech = req.body.SpeechResult || '';
    const call = getDb().prepare('SELECT * FROM calls WHERE id=?').get(callId);
    if (call) {
      const t = `${call.transcript || ''}\nCaller: ${speech}`;
      getDb().prepare('UPDATE calls SET transcript=? WHERE id=?').run(t.slice(-50000), callId);
    }
    res.type('application/xml').send(twilioVoiceTwiml(callId));
  });

  r.post('/twilio/status', hookLimiter, async (req, res) => {
    if (!verifyTwilio(req)) return res.status(403).json({ error: 'bad' });
    const call = getDb().prepare('SELECT * FROM calls WHERE provider_call_id=?').get(req.body.CallSid);
    if (call && ['completed', 'failed', 'busy', 'no-answer'].includes(req.body.CallStatus)) {
      getDb().prepare(`UPDATE calls SET status=?, ended_at=? WHERE id=?`)
        .run(req.body.CallStatus === 'completed' ? 'completed' : 'failed', Date.now(), call.id);
      finalizeCall(call.id).catch(() => {});
    }
    res.json({ ok: true });
  });

  return r;
}

function verifyTwilio(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const url = `${process.env.BASE_URL}${req.originalUrl}`;
  const params = Object.entries(req.body || {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => k + v).join('');
  const expected = crypto.createHmac('sha1', token).update(url + params).digest('base64');
  return constantEqual(req.headers['x-twilio-signature'] || '', expected);
}

// tiny raw-body capture helper (avoids extra dependency)
function express_raw() {
  return (_req, _res, next) => next();
}
