# Deploying VoiceLeads — hosting + database guide (beginner-friendly)

## The 30-second version
1. Push this folder to a **private GitHub repo**.
2. Create a free account on **Railway** (railway.com) or **Render** (render.com).
3. "New Project → Deploy from GitHub repo" → it reads `railway.json` / `render.yaml` automatically.
4. Paste environment variables (below) into the host's dashboard → deploy → you get an HTTPS URL.
5. Put that URL in bKash developer portal as your callback base. Done.

## Which host?
| Host | Cost | Why |
|---|---|---|
| **Railway** | ~$5–10/mo usage-based | Easiest: one click, auto-HTTPS, volumes for SQLite, cron service support. Uses `railway.json` + `Procfile` already in this repo. |
| **Render** | Free web tier (sleeps) / $7 mo | Uses `render.yaml` already in repo — deploys web + worker as two services. Free tier sleeps = missed callbacks; fine for demo only. |
| **Fly.io** | ~$2–5/mo | Great value, uses `flyctl`; run two apps (`voiceleads-web`, `voiceleads-cron`). |
| VPS (Hetzner/DigitalOcean $4–6/mo) + Docker/Nginx | Cheapest at scale | Only if you're comfortable administering Linux. |

⚠️ **Do NOT use serverless (Vercel/Netlify functions)** for this app: persistent WebSocket
demo calls, background dialer, and webhook reliability need a long-running Node process.

## Database choice
- **Now (testing): SQLite** — zero config, file at `data/app.db`. On Railway attach a
  **Volume** mounted at `/data` so the file survives restarts. Back up by copying the file.
- **When paying customers arrive: managed Postgres** — **Neon** (neon.tech, free tier,
  Singapore region) or **Supabase**. Steps: create project → copy connection string →
  set `DATABASE_URL=postgres://...` → port `db/migrations/001_init.sql` (already standard
  SQL; only tweak `datetime('now')` → `now()`). ~1 hour of work, do it before launch.
- Never put the DB file in a public folder; never expose Postgres publicly without SSL.

## Environment variables for production
Generate secrets first:
```bash
node -e "const c=require('crypto');for(const k of ['SESSION_SECRET','WEBHOOK_SECRET','AES_KEY'])console.log(k+'='+c.randomBytes(32).toString('hex'))"
```
Set in the host dashboard (never commit them):
```
NODE_ENV=production
BASE_URL=https://your-app.up.railway.app   # exact public URL, https required
PORT=8080                                   # Railway injects PORT automatically
SESSION_SECRET / WEBHOOK_SECRET / AES_KEY   # from command above
DATABASE_URL=sqlite://./data/app.db         # later: postgres://...
GEMINI_API_KEY=AIza...                      # switch to a PAID key for production volume
BKASH_APP_KEY / BKASH_APP_SECRET / BKASH_ID_TOKEN
BKASH_BASE_URL=https://tokenized.pay.bka.sh
ELEVENLABS_API_KEY=sk_...
VAPI_API_KEY / VAPI_PHONE_NUMBER_ID         # when you add the phone line
```
**Rotate AES_KEY only before first keys are stored** — changing it later invalidates
encrypted workspace credentials.

## Railway: exact steps
1. railway.com → New Project → **Deploy from GitHub repo** → pick `voiceleads`.
2. It builds with Nixpacks and runs `npm run migrate && npm run seed && node server.js`
   (from `railway.json`). Add env vars in Service → Variables.
3. Settings → Volume → mount at `/data` (keeps SQLite across deploys).
4. Public Networking → generate domain (or attach custom domain).
5. Add a **second service** in the same project: same repo, start command
   `node workers/cron.js` (the billing/dialer worker). No public port needed.

## Render: exact steps
Blueprint is pre-configured (`render.yaml`): connect the repo as a **Blueprint** and it
creates `voiceleads-web` + `voiceleads-cron` automatically. Fill the secret env vars when
prompted. Note: the free web tier spins down when idle — upgrade before real customers.

## After deploying — go-live checklist
- [ ] `curl https://YOUR_URL/healthz` → `{"ok":true,"db":true}`
- [ ] Sign up through the UI on the live URL; confirm trial workspace created
- [ ] GET `/api/{WS}/gemini/test` returns `{"ok":true,...}` (use a paid Gemini key now)
- [ ] Run a full bKash **sandbox** payment round-trip
- [ ] Register callback URLs in bKash portal: `https://YOUR_URL/billing/bkash/callback/{payment|agreement|refund}`
- [ ] Switch `BKASH_BASE_URL` to production endpoint once bKash approves your merchant app
- [ ] Buy/attach phone number (Vapi or Twilio), place one test call to your own mobile
- [ ] Set up backups: Railway volumes snapshot / Neon PITR; enable error monitoring (e.g. Sentry free tier)
- [ ] HTTPS-only cookies confirmed (login works over TLS); rate limits live behind proxy (`trust proxy` already set)
