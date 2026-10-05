// Anthropic Claude: conversation brain + post-call lead extraction.
// Keys come from env (platform key) or per-workspace encrypted credentials.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getDb } from './db.js';
import { decryptSecret } from './crypto.js';

export function anthropicClient(workspaceId) {
  let key = process.env.ANTHROPIC_API_KEY;
  if (workspaceId) {
    const row = getDb().prepare(`SELECT secret_enc FROM credentials WHERE workspace_id=? AND provider='anthropic'`)
      .get(workspaceId);
    if (row) key = decryptSecret(row.secret_enc);
  }
  if (!key) throw new Error('No Anthropic API key configured');
  return new Anthropic({ apiKey: key });
}

export const SYSTEM_PROMPT = `You are a polite, concise Bangladeshi phone sales assistant.
Rules:
- Speak naturally for voice (short sentences, no markdown, no lists).
- Never fabricate prices, legal claims, or availability.
- If asked whether you are an AI, answer honestly.
- Always obtain explicit consent before continuing a sales conversation.
- Goal: qualify interest, capture name/company/timeline/budget, book a demo or follow-up.
- End calls gracefully when goal met or the caller is not interested.`;

export async function reply({ workspaceId, messages, model = 'claude-sonnet-4-5' }) {
  const client = anthropicClient(workspaceId);
  const msg = await client.messages.create({
    model, max_tokens: 300, system: SYSTEM_PROMPT, messages,
  });
  const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
  trackUsage(workspaceId, msg.usage);
  return text;
}

function trackUsage(workspaceId, usage) {
  if (!workspaceId || !usage) return;
  getDb().prepare(`INSERT INTO usage_events (id, workspace_id, type, qty, cost_cents) VALUES (?,?,?,?,?)`)
    .run('use_' + Math.random().toString(16).slice(2, 14), workspaceId, 'llm_token',
         (usage.input_tokens || 0) + (usage.output_tokens || 0), 0);
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
export async function extractLead({ workspaceId, transcript, meta = {} }) {
  const client = anthropicClient(workspaceId);
  const prompt = `Extract structured lead data from this call transcript. Return strict JSON matching the schema.
Caller meta: ${JSON.stringify(meta)}
Transcript:
"""${transcript.slice(0, 24000)}"""
Schema: ${JSON.stringify(ExtractionSchema.shape)}`;
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  trackUsage(workspaceId, msg.usage);
  const raw = msg.content.map(c => c.text || '').join('');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = ExtractionSchema.parse(JSON.parse(jsonMatch ? jsonMatch[0] : '{}'));
  return parsed;
}
