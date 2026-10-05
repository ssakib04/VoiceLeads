// Seed subscription plans (BDT/month). Tune pricing to your market.
import { getDb } from '../src/lib/db.js';
const db = getDb();
const plans = [
  ['starter', 'Starter', 1500, 100, 1],   // id, name, BDT/month, included call minutes, seats
  ['growth',  'Growth',  4500, 400, 3],
  ['scale',   'Scale',  12000, 1200, 10],
];
for (const [id, name, amount, minutes, seats] of plans) {
  db.prepare(`INSERT INTO plans (id,name,amount_bdt,included_minutes,included_seats,active)
    VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name, amount_bdt=excluded.amount_bdt,
    included_minutes=excluded.included_minutes, included_seats=excluded.included_seats`)
    .run(id, name, amount, minutes, seats);
}
console.log('plans seeded:', db.prepare('SELECT * FROM plans').all());
