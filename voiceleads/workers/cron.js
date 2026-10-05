// Cron worker: (1) capture bKash agreement-based renewals, (2) pace outbound dialing.
// Run as its own process on the host: `node workers/cron.js` (or a systemd timer / cron entry).
import { getDb, id } from '../src/lib/db.js';
import { captureRenewals } from '../src/lib/bkash.js';
import { dialOutbound, activeCarrier } from '../src/lib/telephony.js';

const TICK_MS = 60 * 1000;

async function tick() {
  // --- renewals: safe to run every hour; captures only due subscriptions ---
  try {
    const res = await captureRenewals();
    if (res.length) console.log('[renewals]', JSON.stringify(res));
  } catch (e) { console.error('[renewals]', e.message); }

  // --- campaign dialer: quiet hours 9:00-20:00 Asia/Dhaka (UTC+6) -----------
  const hourDhaka = new Date(Date.now() + 6 * 3600e3).getUTCHours();
  if (hourDhaka < 9 || hourDhaka >= 20) return;
  const db = getDb();
  const running = db.prepare(`SELECT c.*, 
      (SELECT COUNT(*) FROM calls x WHERE x.campaign_id=c.id AND x.started_at > ?) called_today
    FROM campaigns c WHERE c.status='running'`).all(dayStartMs());
  for (const camp of running) {
    const minsToday = db.prepare(`SELECT COALESCE(SUM(c.duration_sec),0)/60 m FROM calls c
      WHERE c.campaign_id=? AND c.started_at > ?`).get(camp.id, dayStartMs()).m;
    if (minsToday >= camp.max_minutes_per_day) {
      db.prepare(`UPDATE campaigns SET status='paused' WHERE id=?`).run(camp.id); continue;
    }
    const activeNow = db.prepare(`SELECT COUNT(*) n FROM calls WHERE campaign_id=? AND status IN ('queued','ringing','in_progress')`)
      .get(camp.id).n;
    const slots = Math.min(2 - activeNow, 1);
    for (let i = 0; i < slots; i++) {
      const lead = db.prepare(`SELECT l.* FROM leads l
        LEFT JOIN calls c ON c.lead_id=l.id AND c.campaign_id=?
        WHERE l.workspace_id=? AND l.intent IS NULL AND l.consented_at IS NOT NULL AND c.id IS NULL
        LIMIT 1 OFFSET ?`).get(camp.id, camp.workspace_id, i);
      if (!lead) break;
      try { await dialOutbound({ workspaceId: camp.workspace_id, campaignId: camp.id, leadId: lead.id, toNumber: lead.phone }); }
      catch (e) { console.error('[dial]', e.message); }
    }
  }
}

function dayStartMs() { const d = new Date(); d.setUTCHours(3, 0, 0, 0); return d.getTime(); } // 09:00 Dhaka ≈ 03:00 UTC

tick();
setInterval(tick, TICK_MS);
console.log('worker started (carrier=' + activeCarrier() + ')');
