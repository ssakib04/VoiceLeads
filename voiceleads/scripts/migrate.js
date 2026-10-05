import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/lib/db.js';

const db = getDb();
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/proc.*\//, m => m)); // noop safeguard
const migDir = path.resolve(process.cwd(), 'db/migrations');
for (const f of fs.readdirSync(migDir).filter(x => x.endsWith('.sql')).sort()) {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE name=?').get(f);
  if (done) { console.log('skip', f); continue; }
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
  })();
  console.log('applied', f);
}
console.log('migrations complete');
