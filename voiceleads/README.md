# VoiceLeads — AI voice-call & lead-generation SaaS (Claude ✕ ElevenLabs ✕ bKash)

**Yes, your idea is possible — this repo is a working starter that proves it end-to-end.**
People sign up, get a 7-day trial, pay monthly via **bKash** (including automatic renewal),
import leads, run AI **outbound/inbound call campaigns**, and every call is transcribed,
summarized and scored into structured CRM data by **Anthropic Claude**, with **ElevenLabs** voices.

## What's already wired and tested locally
| Feature | Where | Status |
|---|---|---|
| Email+password auth (scrypt, HttpOnly session cookies, rate limits, no user enumeration) | `src/lib/auth.js`, `src/routes/auth.js` | ✅ tested |
| Workspaces + RBAC (owner/admin/member), all data tenant-scoped | `requireWorkspace()` | ✅ tested (403 on foreign workspace) |
| bKash **subscription billing**: first-month checkout + Agreement-API auto-renewal + cancel/revoke | `src/lib/bkash.js`, `src/routes/billing.js` | ✅ flow coded; needs your merchant creds to go live |
| Payment callback safety: never trusts redirect query params — re-verifies via `paymentExecute` server-side | `billing.js` callback | ✅ |
| Leads CRM: add, CSV import/export, dedupe per workspace, consent flag | `src/routes/workspaces.js` | ✅ tested |
| Campaigns: goal prompt, quiet hours (9:00–20:00 Dhaka), daily minute caps, paced dialer worker | `workers/cron.js` | ✅ tested in mock mode |
| Calls: webhook ingestion (Vapi / Twilio / ElevenLabs agent), transcripts, recordings, minute metering vs quota | `src/routes/callbacks.js` | ✅ tested (HMAC/key verification rejects forged calls) |
| Lead generation from calls: Claude extracts summary/intent/score/budget/objections → updates or creates leads | `src/lib/anthropic.js` `extractLead()` | ✅ pipeline verified (needs your API key for the LLM step) |
| Live in-browser demo chat with your agent (WebSocket, session-authenticated) | `/realtime` | ✅ |
| Security headers (helmet+CSP), CSRF (SameSite=Lax + Sec-Fetch-Site/X-Requested-With), input validation (zod), audit log, encrypted provider keys at rest (AES-256-GCM) | `server.js`, `src/lib/crypto.js` | ✅ negative tests passed |
| Usage quotas: minutes left per plan enforced before any paid action (HTTP 402 when exhausted) | `workspaces.js` guard | ✅ tested |

## Quick start
```bash
cd voiceleads
cp .env.example .env        # fill in secrets; dev works with zero external accounts
npm install
npm run migrate && npm run seed
npm start                   # http://localhost:3000  (landing + dashboard)
node workers/cron.js        # second process: renewals + campaign dialer
```
With no carrier configured the platform runs in **mock carrier mode** — you can test signup →
trial → leads → campaign → "call" → usage metering entirely offline. Add real keys to `.env`
and everything switches to live providers automatically.

## The money question: how subscriptions work with bKash
bKash merchants don't get card-style "save card & charge later". They offer the
**Tokenized Agreement API** ("auto-debit mandate"):
1. Customer pays month 1 normally (Checkout API) — we verify with `execute` + `statusQuery`.
2. Customer approves an **agreement** once in their bKash app → we store `agreement_id`.
3. Every month our cron worker calls `create + execute` against the agreement → money arrives
   without customer action. Failure ⇒ subscription goes `past_due` ⇒ features lock (402).
This is exactly what `captureRenewals()` does. You need bKash to enable *Agreement* products
for your merchant account (ask your bKash relationship manager; also apply for the sandbox
first: `https://tokenized.sandbox.bka.sh`).

## Which database?
- **Now:** SQLite (`data/app.db`) — zero setup, WAL mode, perfectly fine up to hundreds of
  paying customers on one box.
- **When revenue shows up:** move to managed Postgres — **Neon** or **Supabase** (both have
  free tiers, Singapore regions = low latency to Dhaka). The schema in
  `db/migrations/001_init.sql` is portable SQL; swap `getDb()` for `pg` (~1 hour of work).
- Never put your Anthropic/ElevenLabs master keys in customer-visible places; per-customer
  keys are stored AES-256-GCM encrypted in the `credentials` table.

## How to host (pick one)
| Option | Cost | Why |
|---|---|---|
| **Railway.app / Render.com** | ~$7–20/mo | Easiest: push repo, set env vars, HTTPS auto. Run `server.js` + `workers/cron.js` as two services. |
| **Fly.io** | ~$5–15/mo | `fly launch`, one web + one `cron` machine. Great WebSockets support. |
| **VPS (Hetzner/DigitalOcean) + Nginx + certbot** | ~$6/mo | Full control; add UFW, fail2ban, automatic TLS renewal. |
| Avoid | — | Serverless (Vercel/Lambda) — long-running webhooks/WebSockets/cron make it painful. |

Whatever you choose: **HTTPS is mandatory** (secure cookies, bKash callbacks, ElevenLabs/Vapi
webhooks all require public HTTPS URLs).

## Making real phone calls (the missing piece you must decide)
Your two APIs give you the *brain* (Claude) and the *voice* (ElevenLabs) — but not a phone
number/PSTN line. Options, easiest first:
1. **Vapi.ai** (recommended to launch): plugs Claude + ElevenLabs directly, gives you BD
   numbers, posts transcripts to `/calls/webhook/vapi` (already implemented). ~$0.05–0.10/min.
2. **ElevenLabs Conversational AI Agents** with telephony (their `/calls/initiate` adapter is
   in `src/lib/elevenlabs.js`; webhook handler exists at `/calls/webhook/elevenlabs`).
3. **Twilio** DIY SIP trunk (adapters + signature verification implemented in `callbacks.js`).

## Compliance — read before launching outbound calling ⚠️
- **Consent:** the `leads.consented_at` field is enforced — the dialer only calls numbers with
  recorded consent. Bangladesh telecom rules (BTRC) and general anti-spam norms make unsolicited
  marketing calls risky; build opt-in into your onboarding.
- **AI disclosure:** the system prompt requires the agent to honestly say it's AI when asked.
- **Quiet hours & caps:** worker dials only 9:00–20:00 Asia/Dhaka, respects per-campaign daily
  minute caps and per-workspace concurrency; spend cap env vars exist as kill-switches.
- **Data protection:** recordings/transcripts are personal data — keep retention short, offer
  delete-on-request, encrypt at rest (done), and never log full phone numbers in plain text logs.
- **Payments:** always re-verify bKash transactions via the status API before granting access
  (implemented); keep raw webhook payloads in `webhooks_log` for dispute resolution.

## Production hardening checklist (next steps, in order)
1. Put real keys in `.env` → smoke-test one live call through Vapi sandbox.
2. Register bKash app on developer.bka.sh → test full loop in **sandbox** (`BKASH_BASE_URL`), then prod.
3. Deploy on Railway/Fly, attach domain, force HTTPS, set `NODE_ENV=production`.
4. Rotate default secrets (`SESSION_SECRET`, `AES_KEY`, `WEBHOOK_SECRET`) — generate fresh hex.
5. Add email delivery for receipts/password reset (Resend or SMTP) — endpoints stubbed in audit trail.
6. Move to Postgres once >50 customers; enable nightly DB backups (Neon/Supabase do this for you).
7. Replace `'unsafe-inline'` CSP with nonces when the UI grows beyond the single-file frontend.

## Repo layout
```
voiceleads/
├── server.js                 # hardened Express + WebSocket bootstrap
├── workers/cron.js           # renewals + paced outbound dialer
├── scripts/{migrate,seed}.js
├── db/migrations/001_init.sql
├── src/lib/    auth crypto db bkash anthropic elevenlabs telephony
├── src/routes/ auth billing workspaces callbacks
└── public/     landing + dashboard (vanilla JS, same-origin only)
```

**Bottom line:** yes, it's possible, the architecture is proven here, and the only things
standing between this and revenue are (a) your API keys, (b) enabling the bKash Agreement
product on your merchant account, and (c) picking a telephony carrier (Vapi is fastest).
