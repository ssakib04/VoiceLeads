// Google Gemini: conversation brain + post-call lead extraction.
// Works on the FREE-tier API key from https://aistudio.google.com/apikey
// (gemini-2.5-flash is free for requests & tokens; limits ≈10 RPM / 250 RPD —
//  fine for testing, upgrade to a paid key when you go live.)
// Keys come from env (GEMINI_API_KEY) or per-workspace encrypted credentials.
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { getDb } from './db.js';
import { decryptSecret } from './crypto.js';

export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function keyFor(workspaceId) {
  if (workspaceId) {
    const row = getDb().prepare(`SELECT secret_enc FROM credentials WHERE workspace_id=? AND provider='gemini'`)
      .get(workspaceId);
    if (row) return decryptSecret(row.secret_enc);
  }
  return process.env.GEMINI_API_KEY || null;
}

export function geminiClient(workspaceId) {
  const key = keyFor(workspaceId);
  if (!key) throw new Error('No Gemini API key configured — put GEMINI_API_KEY in .env (free key: https://aistudio.google.com/apikey)');
  return new GoogleGenAI({ apiKey: key });
}

export const SYSTEM_PROMPT = `You are a polite, concise Bangladeshi phone sales assistant.
Rules:
- Speak naturally for voice (short sentences, no markdown, no lists).
- Never fabricate prices, legal claims, or availability.
- If asked whether you are an AI, answer honestly.
- Always obtain explicit consent before continuing a sales conversation.
- Goal: qualify interest, capture name/company/timeline/budget, book a demo or follow-up.
- End calls gracefully when goal met or the caller is not interested.`;

// One conversational turn. messages = [{role:'user'|'assistant', content:string}, ...]
// If no Gemini key but an Anthropic key exists, transparently fall back (legacy support).
export async function reply({ workspaceId, messages, model = GEMINI_MODEL }) {
  if (!keyFor(workspaceId) && process.env.ANTHROPIC_API_KEY) {
    const legacy = await import('./anthropic.legacy.js');
    return legacy.reply({ workspaceId, messages });
  }
  const ai = geminiClient(workspaceId);
  const res = await ai.models.generateContent({
    model,
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] })),
    config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: 300, temperature: 0.4 },
  });
  trackUsage(workspaceId, res.usageMetadata);
  return (res.text || '').trim();
}

function trackUsage(workspaceId, usage) {
  if (!workspaceId || !usage) return;
  getDb().prepare(`INSERT INTO usage_events (id, workspace_id, type, qty, cost_cents) VALUES (?,?,?,?,?)`)
    .run('use_' + Math.random().toString(16).slice(2, 14), workspaceId, 'llm_token',
         (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0), 0);
}

const ExtractionSchema = z.object({
  summary: z.string(),
  intent: z.enum(['hot', 'warm', 'cold']),
  score: z.number().int().min(0).max(100),
  contact_name: z.string().nullable(),
  company: z.string().nullable(),
  budget_bdt: z.number().nullable(),
  timeline: z.string().nullable(),
  objections: z.array(z.string()),
  next_action: z.string().nullable(),
  consent_given: z.boolean(),
});

// Turn a transcript into structured CRM data. Used after every call ends.
export async function extractLead({ workspaceId, transcript, meta = {}, model = GEMINI_MODEL }) {
  if (!keyFor(workspaceId) && process.env.ANTHROPIC_API_KEY) {
    const legacy = await import('./anthropic.legacy.js');
    return legacy.extractLead({ workspaceId, transcript, meta });
  }
  const ai = geminiClient(workspaceId);
  const prompt = `Extract structured lead data from this call transcript. Return ONLY a JSON object (no markdown fences) matching this schema exactly:
{"summary":string,"intent":"hot"|"warm"|"cold","score":integer 0-100,"contact_name":string|null,"company":string|null,"budget_bdt":number|null,"timeline":string|null,"objections":string[],"next_action":string|null,"consent_given":boolean}

Caller meta: ${JSON.stringify(meta)}
Transcript:
"""${String(transcript).slice(0, 24000)}"""`;
  const res = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      maxOutputTokens: 800,
      temperature: 0.1,
      // Native structured output — no fragile JSON parsing for the common case.
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING' },
          intent: { type: 'STRING', enum: ['hot', 'warm', 'cold'] },
          score: { type: 'INTEGER' },
          contact_name: { type: 'STRING', nullable: true },
          company: { type: 'STRING', nullable: true },
          budget_bdt: { type: 'NUMBER', nullable: true },
          timeline: { type: 'STRING', nullable: true },
          objections: { type: 'ARRAY', items: { type: 'STRING' } },
          next_action: { type: 'STRING', nullable: true },
          consent_given: { type: 'BOOLEAN' },
        },
      },
    },
  });
  trackUsage(workspaceId, res.usageMetadata);
  const raw = res.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = ExtractionSchema.parse(JSON.parse(jsonMatch ? jsonMatch[0] : '{}'));
  return parsed;
}

// Quick connectivity check used by GET /api/gemini/test and boot logging.
export async function testConnection(workspaceId) {
  const ai = geminiClient(workspaceId);
  const res = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
    config: { maxOutputTokens: 5 },
  });
  return { ok: true, model: GEMINI_MODEL, echo: (res.text || '').trim() };
}
