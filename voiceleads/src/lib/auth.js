// Session-cookie auth + workspace RBAC middleware.
// Sessions are opaque random tokens stored server-side (DB) — no JWT state problem,
// instant revocation on logout/password change. Cookies: HttpOnly, SameSite=Lax, Secure in prod.
import crypto from 'node:crypto';
import { getDb, id } from './db.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)`)
    .run(token, userId, Date.now() + SESSION_TTL_MS);
  return token;
}

export function destroySession(token) {
  if (token) getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(token);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// Express middleware: attaches req.user when a valid session cookie exists.
export function attachUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie || '').sid;
  req.user = null;
  if (token) {
    const row = getDb().prepare(
      `SELECT s.expires_at, u.id, u.email, u.name FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(token);
    if (row && row.expires_at > Date.now()) req.user = { ...row, token };
    else if (row) destroySession(token);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Super-admin bootstrap endpoint guard (optional ops tooling).
export function requireAdminToken(req, res, next) {
  const t = process.env.ADMIN_TOKEN;
  if (!t || req.headers['x-admin-token'] !== t) return res.status(403).json({ error: 'forbidden' });
  next();
}

export function roleIn(workspaceId, userId) {
  return getDb().prepare(
    `SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?`).get(workspaceId, userId)?.role || null;
}

// Resolves :wsId from the route and enforces membership. minRole: member|admin|owner
const RANK = { member: 1, admin: 2, owner: 3 };
export function requireWorkspace(minRole = 'member') {
  return (req, res, next) => {
    const wsId = req.params.wsId || req.body.workspace_id;
    const role = req.user ? roleIn(wsId, req.user.id) : null;
    if (!role || RANK[role] < RANK[minRole]) return res.status(403).json({ error: 'forbidden' });
    req.workspaceId = wsId;
    req.role = role;
    next();
  };
}
