// Telephony adapters. The platform stays carrier-agnostic:
//  - vapi   : fastest path (Claude + ElevenLabs hosted, gives you a phone number too)
//  - twilio : DIY — Twilio Programmable Voice webhook -> our /calls/twilio/voice endpoint
//  - mock   : local development without any carrier account
import crypto from 'node:crypto';
import { getDb, id } from './db.js';
import { decryptSecret } from './crypto.js';
import { reply as geminiReply, extractLead } from '../lib/gemini.js';

function providerKey(ws, provider) {
  const row = getDb().prepare('SELECT secret_enc FROM credentials WHERE workspace_id=? AND provider=?').get(ws, provider);
  return row ? decryptSecret(row.secret_enc) : process.env[provider.toUpperCase() + '_API_KEY'];
}

export function brainProvider() {
  return process.env.GEMINI_API_KEY ? 'gemini' : (process.env.ANTHROPIC_API_KEY ? 'anthropic' : null);
}

export function activeCarrier() {
  if (process.env.VAPI_API_KEY) return 'vapi';
  if (process.env.TWILIO_ACCOUNT_SID) return 'twilio';
  return 'mock';
}

// ---- outbound campaign dial ------------------------------------------------
export async function dialOutbound({ workspaceId, campaignId, leadId, toNumber }) {
  const carrier = activeCarrier();
  const calls = getDb();
  const callId = id('call_');
  calls.prepare(`INSERT INTO calls (id, workspace_id, campaign_id, lead_id, direction, status, to_number)
                 VALUES (?, ?, ?, ?, 'outbound', 'queued', ?)`).run(callId, workspaceId, campaignId, leadId, toNumber);

  if (carrier === 'mock') {
    calls.prepare(`UPDATE calls SET status='completed', started_at=?, ended_at=?, duration_sec=45,
                   transcript='[mock] Assistant: Hello! Caller: Yes I am interested.' WHERE id=?`)
      .run(Date.now() - 45000, Date.now(), callId);
    return { callId, carrier };
  }
  if (carrier === 'vapi') {
    const res = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: { authorization: `Bearer ${providerKey(workspaceId, 'vapi')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        assistant: {
          // Brain = Google Gemini (free tier). Voice = ElevenLabs. Number = Vapi.
          model: { provider: 'google', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
                   temperature: 0.4 },
          voice: { provider: '11labs', voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb' },
          firstMessage: 'Hello! Am I speaking with the owner of the business?',
          serverUrl: `${process.env.BASE_URL}/calls/webhook/vapi`,
          serverApiKey: process.env.WEBHOOK_SECRET,
        },
        customer: { number: toNumber },
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        metadata: { workspaceId, campaignId, leadId, callId },
      }),
    });
    if (!res.ok) throw new Error(`vapi dial ${res.status}: ${await res.text()}`);
    const j = await res.json();
    calls.prepare(`UPDATE calls SET status='ringing', provider_call_id=? WHERE id=?`).run(j.id, callId);
    return { callId, carrier, providerCallId: j.id };
  }
  // twilio
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  const params = new URLSearchParams({
    To: toNumber, From: process.env.TWILIO_FROM_NUMBER,
    Url: `${process.env.BASE_URL}/calls/twilio/voice?callId=${callId}`,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
    body: params,
  });
  if (!res.ok) throw new Error(`twilio dial ${res.status}: ${await res.text()}`);
  const j = await res.json();
  calls.prepare(`UPDATE calls SET status='ringing', provider_call_id=? WHERE id=?`).run(j.sid, callId);
  return { callId, carrier, providerCallId: j.sid };
}

// ---- post-call enrichment: Claude extracts structured lead data ------------
export async function finalizeCall(callId) {
  const db = getDb();
  const call = db.prepare('SELECT * FROM calls WHERE id=?').get(callId);
  if (!call || !call.transcript) return call;
  // meter call minutes against the workspace quota (billed usage)
  if (!db.prepare(`SELECT 1 FROM usage_events WHERE ref_id=? AND type='call_minute'`).get(callId)) {
    db.prepare(`INSERT INTO usage_events (id, workspace_id, type, qty, cost_cents, ref_id) VALUES (?,?,?,?,?,?)`)
      .run(id('use_'), call.workspace_id, 'call_minute', Math.max(1, Math.round(call.duration_sec / 60)),
           call.cost_cents || 0, callId);
  }
  if (call.extracted_json) return call;
  let extraction = null;
  try {
    extraction = await extractLead({
      workspaceId: call.workspace_id, transcript: call.transcript,
      meta: { phone: call.to_number, campaign: call.campaign_id },
    });
  } catch (e) { console.error('extraction failed', e.message); }
  db.prepare(`UPDATE calls SET extracted_json=?, summary=? WHERE id=?`)
    .run(extraction ? JSON.stringify(extraction) : null, extraction?.summary || null, callId);
  if (extraction && call.lead_id) {
    db.prepare(`UPDATE leads SET score=?, intent=?, name=COALESCE(?,name), company=COALESCE(?,company),
                custom=?, updated_at=datetime('now') WHERE id=?`)
      .run(extraction.score, extraction.intent, extraction.contact_name, extraction.company,
           JSON.stringify({ budget_bdt: extraction.budget_bdt, timeline: extraction.timeline,
                            objections: extraction.objections, next_action: extraction.next_action }), call.lead_id);
  } else if (extraction && call.to_number) {
    // inbound unknown caller -> create lead automatically
    const lid = id('lead_');
    db.prepare(`INSERT INTO leads (id, workspace_id, phone, name, company, source, score, intent, custom)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(lid, call.workspace_id, call.to_number, extraction.contact_name, extraction.company, 'inbound',
           extraction.score, extraction.intent, JSON.stringify(extraction));
    db.prepare(`UPDATE calls SET lead_id=? WHERE id=?`).run(lid, callId);
  }
  return db.prepare('SELECT * FROM calls WHERE id=?').get(callId);
}

// ---- in-browser demo chat (WebSocket "phone call" simulator) ---------------
// Protocol: client sends {type:'say', text}; server replies {type:'reply', text}.
const sessions = new Map(); // ws -> {workspaceId, messages}

export function attachRealtime(wss, authenticate) {
  wss.on('connection', async (ws, req) => {
    const wsId = await authenticate(req);            // validates session cookie
    if (!wsId) { ws.close(4401); return; }
    sessions.set(ws, { workspaceId: wsId, messages: [] });
    ws.send(JSON.stringify({ type: 'hello', text: 'Demo line open. Say something as the customer.' }));
    ws.on('message', async (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        const s = sessions.get(ws); if (!s) return;
        if (msg.type === 'say') {
          s.messages.push({ role: 'user', content: String(msg.text).slice(0, 1200) });
          const answer = await geminiReply({ workspaceId: s.workspaceId, messages: s.messages.slice(-12) });
          s.messages.push({ role: 'assistant', content: answer });
          ws.send(JSON.stringify({ type: 'reply', text: answer }));
        }
      } catch (e) { ws.send(JSON.stringify({ type: 'error', text: e.message })); }
    });
    ws.on('close', () => sessions.delete(ws));
  });
}

export function twilioVoiceTwiml(callId) {
  // Minimal DIY path: Twilio gathers speech, we POST it back to /calls/twilio/gather.
  const base = process.env.BASE_URL;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello, this is a demo assistant from VoiceLeads. How can I help you today?</Say>
  <Gather input="speech" voice="Polly.Aditi" language="en-US" action="/calls/twilio/gather?callId=${callId}" method="POST" timeout="8">
    <Say>Over to you.</Say>
  </Gather>
  <Hangup/>
</Response>`;
}
