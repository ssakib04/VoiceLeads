// VoiceLeads server — hardened Express app.
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import path from 'node:path';

import { attachUser, parseCookies } from './src/lib/auth.js';
import { getDb } from './src/lib/db.js';
import { authRoutes } from './src/routes/auth.js';
import { billingRoutes } from './src/routes/billing.js';
import { workspaceRoutes } from './src/routes/workspaces.js';
import { callRoutes } from './src/routes/callbacks.js';
import { attachRealtime } from './src/lib/telephony.js';

const app = express();
app.set('trust proxy', 1); // behind Fly/Railway/Nginx reverse proxy

// ---------- security middleware ----------
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],   // inline kept for the tiny demo UI; move to nonces in prod
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'wss:', 'https:'],
      mediaSrc: ["'self'", 'blob:'],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
// CSRF strategy: SameSite=Lax cookie blocks cross-site POSTs at the browser level.
// Defense-in-depth below additionally requires that cookie-bearing state-changing
// requests either come from a same-origin browser context (Sec-Fetch-Site) or carry
// an explicit X-Requested-With header (set by our front-end for older browsers).
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
app.use((req, res, next) => {
  if (SAFE_METHODS.includes(req.method)) return next();
  if (!req.headers.cookie) return next();                 // no session cookie => no CSRF surface
  const sfs = req.headers['sec-fetch-site'];
  if (sfs === 'same-origin' || sfs === 'none') return next();
  if (req.headers['x-requested-with'] === 'fetch') return next();
  if (!sfs && process.env.NODE_ENV !== 'production') return next(); // curl/dev convenience
  return res.status(403).json({ error: 'csrf blocked' });
});
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false }));
app.use(attachUser);

// ---------- routes ----------
app.get('/healthz', (_req, res) => res.json({ ok: true, db: !!getDb() }));
app.use('/auth', authRoutes());
app.use('/billing', billingRoutes());
app.use('/api', workspaceRoutes());
app.use('/calls', callRoutes());
app.use(express.static('public', { index: 'index.html', maxAge: '1h' }));
app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => {            // never leak stack traces
  console.error(err);
  res.status(err.status === 400 || err.name === 'ZodError' ? 422 : 500)
     .json({ error: err.name === 'ZodError' ? 'invalid input' : 'server error' });
});

// ---------- websocket realtime (demo "call" + live transcripts) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/realtime' });
attachRealtime(wss, async (req) => {
  const token = parseCookies(req.headers.cookie || '').sid;
  if (!token) return null;
  const row = getDb().prepare(`SELECT s.expires_at, m.workspace_id FROM sessions s
    JOIN workspace_members m ON m.user_id = s.user_id WHERE s.id=?`).get(token);
  return row && row.expires_at > Date.now() ? row.workspace_id : null;
});

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV === 'production' && !process.env.BASE_URL?.startsWith('https://'))
  console.warn('WARNING: production without HTTPS BASE_URL — bKash callbacks & secure cookies will fail');
server.listen(port, () => console.log(`VoiceLeads listening on :${port}`));
