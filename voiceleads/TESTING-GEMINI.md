# Testing VoiceLeads with a FREE Google Gemini key (no Anthropic needed)

The whole "brain" of the platform — live conversation + post-call lead extraction —
now runs on **Gemini 2.5 Flash**, which has a genuinely free tier.

## Step 0 — get your free key (2 minutes)
1. Go to **https://aistudio.google.com/apikey**
2. Sign in with any Google account → *Create API key* → copy it (`AIza...`)
3. Free limits for `gemini-2.5-flash`: ~10 requests/min, ~250/day — plenty for testing.

## Step 1 — put the key in .env
```bash
cd voiceleads
# edit .env and set:
#   GEMINI_API_KEY=AIza...your-key-here
npm run dev        # or: npm start   (http://localhost:3100)
```

## Step 2 — verify the key works (3 ways, easiest first)

**A. Built-in test endpoint** (recommended):
```bash
# sign up in the browser at http://localhost:3100 , open DevTools→Network,
# copy your workspace id (starts with ws_), then:
curl -b "sid=YOUR_SESSION_COOKIE" http://localhost:3100/api/ws_YOUR_ID/gemini/test
# expect: {"ok":true,"model":"gemini-2.5-flash","echo":"OK"}
```

**B. Browser demo call**: the web UI's "Demo Call" panel is a WebSocket chat that
runs every reply through Gemini with the real sales system prompt. Talk to it —
ask "are you an AI?" (it must answer honestly), try to book a demo.

**C. Raw curl to Google** (sanity-check the key itself, no app involved):
```bash
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GEMINI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"contents":[{"parts":[{"text":"Say OK"}]}],"config":{"maxOutputTokens":5}}'
```

## Step 3 — test the FULL pipeline without a phone line (mock carrier)
With no Vapi/Twilio keys set, `activeCarrier()` returns `mock`, so campaigns dial
a simulated call and then run the **real** Gemini extraction path:

```bash
# 1. signup → note workspaceId from the response
# 2. add a consented lead
curl -s -b cookies.txt -X POST localhost:3100/api/{WS}/leads \
  -H 'content-type: application/json' -H 'x-requested-with: fetch' \
  -d '{"phone":"+8801700000001","name":"Rahim Uddin","company":"Rahim Traders","consent":true}'
# 3. create + start campaign → response now includes "extraction": {...}
curl -s -b cookies.txt -X POST localhost:3100/api/{WS}/campaigns \
  -H 'content-type: application/json' -H 'x-requested-with: fetch' \
  -d '{"name":"Oct Outreach","goal_prompt":"Introduce VoiceLeads, book a demo"}'
curl -s -b cookies.txt -X POST localhost:3100/api/{WS}/campaigns/{CID}/start -H 'x-requested-with: fetch'
# 4. check quota metering
curl -s -b cookies.txt localhost:3100/api/{WS}/usage
```
Expected `extraction` JSON: `{summary, intent:"hot|warm|cold", score, contact_name, budget_bdt, timeline, objections[], next_action, consent_given}` — written by Gemini, saved onto the lead row (visible via GET /leads).

## Step 4 — bKash billing (sandbox, still no real money)
1. Register at **https://developer.bka.sh** → create app → get App Key/Secret/ID Token
2. Set `BKASH_BASE_URL=https://tokenized.sandbox.bka.sh` + sandbox merchant creds from their docs
3. Use the **test card/number** from bKash sandbox docs in the checkout flow
4. When ready for production: ask bKash support to enable the **Agreement (auto-debit)**
   product on your merchant account — that's what powers recurring monthly charges.

## Step 5 — adding a REAL phone number (the missing piece)
Your Gemini + ElevenLabs keys give brain + voice but **no telephone number**. Pick one:

| Option | How you get a number | Effort |
|---|---|---|
| **Vapi.ai (recommended)** | Dashboard → Phone Numbers → buy a number (+1 US for testing; BD numbers via Twilio sync) | Copy `VAPI_API_KEY` + `VAPI_PHONE_NUMBER_ID` into .env. Done — the code already calls Vapi with `model.provider:"google"` |
| **ElevenLabs Agents** | app.elevenlabs.io → Agents → Telephony → import a Twilio number | Set `ELEVENLABS_AGENT_ID`; webhook → `$BASE_URL/calls/webhook/elevenlabs` |
| **Twilio DIY** | Buy a number in Twilio console (~$1/mo; BD DDI via support) | Set the 3 TWILIO_* vars; configure the voice webhook URL to `$BASE_URL/calls/twilio/voice` |

For Bangladeshi caller-ID you'll ultimately want a local number — Twilio supports BD
numbers for outbound CLI; test internationally first with a cheap US/UK number.

## Troubleshooting
- `API_KEY_INVALID` → wrong/pasted-incomplete key.
- `429 RESOURCE_EXHAUSTED` → free-tier rate limit (10 RPM); slow down or add a paid key.
- Extraction returns null but no crash → check `server.log` ("extraction failed ...");
  minutes are still metered even if Gemini errors out (by design).
- Demo call WS closes instantly (4401) → you're not logged in (cookie expired).
