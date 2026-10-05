import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let db;

export function getDb() {
  if (db) return db;
  const url = process.env.DATABASE_URL || 'sqlite://./data/app.db';
  if (!url.startsWith('sqlite://')) {
    // Postgres mode is documented in README; this starter ships SQLite.
    throw new Error('This starter supports sqlite:// URLs. See README for the Neon/Supabase migration path.');
  }
  const file = url.replace('sqlite://', '');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function id(prefix = '') {
  return prefix + crypto.randomBytes(12).toString('hex');
}

export function audit({ workspace_id = null, user_id = null, action, ip = null, meta = null }) {
  getDb().prepare(
    `INSERT INTO audit_log (id, workspace_id, user_id, action, ip, meta) VALUES (?,?,?,?,?,?)`
  ).run(id('aud_'), workspace_id, user_id, action, ip, meta ? JSON.stringify(meta) : null);
}
