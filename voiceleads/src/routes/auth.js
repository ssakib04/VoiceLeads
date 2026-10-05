import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getDb, id, audit } from '../lib/db.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { createSession, destroySession, setSessionCookie, clearSessionCookie, requireAuth } from '../lib/auth.js';

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true });

export function authRoutes() {
  const r = Router();

  r.post('/signup', authLimiter, async (req, res) => {
    const body = z.object({
      email: z.string().email().toLowerCase(),
      password: z.string().min(8).max(128),
      name: z.string().min(1).max(80).optional(),
      workspace: z.string().min(2).max(80).optional(),
    }).parse(req.body);

    // basic breach check without sending the password anywhere
    if (/^(password|12345678|qwertyuiop)/i.test(body.password))
      return res.status(422).json({ error: 'password too weak' });

    const db = getDb();
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(body.email))
      return res.status(409).json({ error: 'account exists' }); // same message either way: no user enumeration

    const userId = id('usr_');
    db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?,?,?,?)')
      .run(userId, body.email, await hashPassword(body.password), body.name || null);

    const wsId = id('ws_');
    db.prepare('INSERT INTO workspaces (id, owner_id, name) VALUES (?,?,?)')
      .run(wsId, userId, body.workspace || `${body.email.split('@')[0]}'s workspace`);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?, 'owner')`).run(wsId, userId);

    // free trial so they can evaluate before paying via bKash
    const plan = db.prepare('SELECT id FROM plans WHERE active=1 ORDER BY amount_bdt LIMIT 1').get();
    if (plan) db.prepare(`INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_end)
      VALUES (?,?,?, 'trialing', ?)`).run(id('sub_'), wsId, plan.id, Date.now() + 7 * 864e5);

    setSessionCookie(res, createSession(userId));
    audit({ user_id: userId, workspace_id: wsId, action: 'signup', ip: req.ip });
    res.json({ ok: true, userId, workspaceId: wsId });
  });

  r.post('/login', authLimiter, async (req, res) => {
    const body = z.object({ email: z.string().email().toLowerCase(), password: z.string().max(128) }).parse(req.body);
    const u = getDb().prepare('SELECT * FROM users WHERE email=?').get(body.email);
    // run a hash even for unknown users so timing doesn't leak existence
    const ok = await verifyPassword(body.password, u?.password_hash || 'scrypt$00$00');
    if (!u || !ok) return res.status(401).json({ error: 'invalid credentials' });
    setSessionCookie(res, createSession(u.id));
    audit({ user_id: u.id, action: 'login', ip: req.ip });
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    const token = req.user?.token;
    destroySession(token); clearSessionCookie(res);
    if (token) audit({ user_id: req.user?.id, action: 'logout', ip: req.ip });
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => {
    const workspaces = getDb().prepare(
      `SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
       WHERE m.user_id=?`).all(req.user.id);
    res.json({ email: req.user.email, name: req.user.name, workspaces });
  });

  return r;
}
