// ElevenLabs adapter: text-to-speech for IVR prompts + conversational-agent bridge.
import { getDb } from './db.js';
import { decryptSecret } from './crypto.js';

function keyFor(workspaceId) {
  if (workspaceId) {
    const row = getDb().prepare(`SELECT secret_enc FROM credentials WHERE workspace_id=? AND provider='elevenlabs'`).get(workspaceId);
    if (row) return decryptSecret(row.secret_enc);
  }
  return process.env.ELEVENLABS_API_KEY || null;
}

// Voice preview / prompt audio -> returns MP3 buffer (used by /api/tts).
export async function tts({ workspaceId, text, voiceId }) {
  const key = keyFor(workspaceId);
  if (!key) throw new Error('No ElevenLabs API key configured');
  const vid = voiceId || 'JBFqnCBsd6RMkjVDRZzb'; // default public voice; replace with yours
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: String(text).slice(0, 2500),
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) throw new Error(`elevenlabs tts ${res.status}: ${await res.text()}`);
  trackChars(workspaceId, text.length);
  return Buffer.from(await res.arrayBuffer());
}

function trackChars(workspaceId, n) {
  if (!workspaceId) return;
  getDb().prepare(`INSERT INTO usage_events (id, workspace_id, type, qty) VALUES (?,?,?,?)`)
    .run('use_' + Math.random().toString(16).slice(2, 14), workspaceId, 'tts_char', n);
}

// Conversational AI agent webhook payload validation (HMAC-SHA256 header).
import crypto from 'node:crypto';
export function verifyAgentWebhook(rawBody, signatureHeader) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signatureHeader)));
  } catch { return false; }
}

// Kick off an agent-initiated call via the ElevenLabs Conversational AI telephony API.
export async function initiateAgentCall({ workspaceId, agentId, phoneNumber, campaignId }) {
  const key = keyFor(workspaceId);
  const aid = agentId || process.env.ELEVENLABS_AGENT_ID;
  if (!key || !aid) throw new Error('ELEVENLABS_API_KEY / agent id missing');
  const res = await fetch('https://api.elevenlabs.io/v1/conversational-ai/calls/initiate', {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: aid,
      customer_id: `ws_${workspaceId}`,
      ring_seconds: 90,
      call_sid_variant: campaignId || undefined,
      to_number: phoneNumber,
      from_number_cli: process.env.ELEVENLABS_FROM_NUMBER || undefined,
    }),
  });
  if (!res.ok) throw new Error(`elevenlabs initiate ${res.status}: ${await res.text()}`);
  return res.json(); // { call_id, conversation_signal_capabilities ... }
}
