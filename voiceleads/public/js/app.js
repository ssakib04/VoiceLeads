// Vanilla JS front-end. Same-origin fetches only (CSRF guard relies on Sec-Fetch-Site).
const $ = s => document.querySelector(s);
let WS = null, wsSocket = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}

async function boot() {
  try {
    const me = await api('/auth/me');
    if (!me.workspaces?.length) throw 0;
    WS = me.workspaces[0].id;
    $('#site').style.display = 'none'; $('#app').style.display = 'block';
    $('#navArea').innerHTML = `<span class="mut">${me.email}</span>`;
    loadPlans(); tab('dash');
  } catch { /* landing page */ }
}
boot();

function showAuth() { $('#auth').style.display = 'block'; $('#auth').scrollIntoView(); }

async function login(isLogin) {
  try {
    await api(`/auth/${isLogin ? 'login' : 'signup'}`, { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#pw').value }) });
    location.reload();
  } catch (e) { $('#authMsg').textContent = e.message; }
}
async function logout() { await api('/auth/logout', { method: 'POST' }); location.reload(); }

function tab(t) {
  ['dash', 'leads', 'camp', 'bill', 'demo'].forEach(x => $('#t-' + x).style.display = x === t ? 'block' : 'none');
  if (t === 'dash') dash(); if (t === 'leads') leads(); if (t === 'camp') camps(); if (t === 'bill') bill(); if (t === 'demo') demoWs();
}

async function dash() {
  const [u, calls] = await Promise.all([api(`/api/${WS}/usage`), api(`/api/${WS}/calls`)]);
  $('#dashOut').textContent = `Minutes used totals: ${JSON.stringify(u.totals)}\nHot leads: ${u.hotLeads}\nRecent calls:\n` +
    calls.slice(0, 8).map(c => `  ${c.direction} ${c.to_number || ''} ${c.status} ${c.duration_sec}s ${c.summary || ''}`).join('\n');
}

async function leads() {
  const rows = await api(`/api/${WS}/leads`);
  $('#leadTable tbody').innerHTML = rows.map(l =>
    `<tr><td>${esc(l.phone)}</td><td>${esc(l.name || '')}</td><td>${l.score ?? ''}</td>
     <td>${l.intent ? `<span class="tag ${l.intent}">${l.intent}</span>` : ''}</td>
     <td>${esc((l.custom && l.custom.next_action) || '')}</td></tr>`).join('');
}

async function addLead() {
  await api(`/api/${WS}/leads`, { method: 'POST', body: JSON.stringify({ phone: $('#lphone').value, name: $('#lname').value, consent: $('#lconsent').checked }) });
  leads();
}
function exportLeads() { window.open(`/api/${WS}/leads/export`); }

async function camps() {
  const rows = await api(`/api/${WS}/campaigns`);
  $('#campTable tbody').innerHTML = rows.map(c => `<tr><td>${esc(c.name)}</td><td>${c.status}</td><td>${esc(c.goal_prompt.slice(0, 80))}</td></tr>`).join('');
  window._camps = rows;
}
async function createCamp() {
  await api(`/api/${WS}/campaigns`, { method: 'POST', body: JSON.stringify({ name: $('#cname').value, goal_prompt: $('#cgoal').value }) });
  camps();
}
async function startCamp() {
  const c = (window._camps || []).find(x => x.status !== 'completed');
  if (!c) return alert('create a campaign first');
  const r = await api(`/api/${WS}/campaigns/${c.id}/start`, { method: 'POST' });
  alert(JSON.stringify(r)); leads(); camps(); dash();
}

async function loadPlans() {
  const plans = await api('/billing/plans');
  $('#pricing').innerHTML = plans.map(p => `<div class="card"><h3>${p.name}</h3>
    <div class="price">৳${p.amount_bdt}<small>/month · ${p.included_minutes} call minutes</small></div>
    <button class="btn" onclick="showAuth()">Choose ${p.name}</button></div>`).join('');
  $('#planSel').innerHTML = plans.map(p => `<option value="${p.id}">${p.name} — ৳${p.amount_bdt}/mo</option>`).join('');
}

async function bill() {
  const s = await api(`/billing/status?workspace_id=${WS}`);
  renderBill(s);
}
function renderBill(s) {
  const sub = s.subscription;
  $('#billState').innerHTML = sub
    ? `Plan: <b>${sub.plan_name}</b> · status: <b>${sub.status}</b> · renews: ${sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString() : '-'} · mandate: ${sub.bkash_agreement_id ? '✅ enabled' : 'not set'}`
    : 'No subscription yet.';
  window._sub = sub;
}
async function checkout() {
  const r = await api('/billing/checkout', { method: 'POST', body: JSON.stringify({ workspace_id: WS, plan_id: $('#planSel').value }) });
  window._subId = r.subscriptionId; alert('Pending subscription created: ' + r.subscriptionId + '\nNow click "Pay first month".');
}
async function payNow() {
  const subId = window._subId || window._sub?.id; if (!subId) return alert('click Subscribe first');
  try {
    const r = await api('/billing/bkash/payment-url', { method: 'POST', body: JSON.stringify({ workspace_id: WS, subscription_id: subId }) });
    if (r.url) location.href = r.url; else alert('bKash sandbox not configured: ' + JSON.stringify(r));
  } catch (e) { alert(e.message + '\n(If BKASH_* env vars are empty this is expected.)'); }
}
async function autoRenew() {
  const subId = window._subId || window._sub?.id; if (!subId) return alert('subscribe first');
  const r = await api('/billing/bkash/agreement-url', { method: 'POST', body: JSON.stringify({ workspace_id: WS, subscription_id: subId }) });
  if (r.url) location.href = r.url; else alert(JSON.stringify(r));
}
async function cancelSub() { await api(`/billing/cancel?workspace_id=${WS}`, { method: 'POST', body: JSON.stringify({ workspace_id: WS }) }); bill(); }

function demoWs() {
  if (wsSocket) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  wsSocket = new WebSocket(`${proto}://${location.host}/realtime`);
  wsSocket.onmessage = ev => {
    const m = JSON.parse(ev.data);
    $('#log').innerHTML += `<div class="ai">🤖 ${esc(m.text || JSON.stringify(m))}</div>`;
    $('#log').scrollTop = 1e9;
  };
  wsSocket.onclose = () => { wsSocket = null; $('#log').innerHTML += '<div class="mut">connection closed</div>'; };
}
function say() {
  const v = $('#sayIn').value.trim(); if (!v || !wsSocket) return;
  $('#log').innerHTML += `<div class="me">👤 ${esc(v)}</div>`;
  wsSocket.send(JSON.stringify({ type: 'say', text: v }));
  $('#sayIn').value = '';
}
$('#sayIn')?.addEventListener('keydown', e => e.key === 'Enter' && say());

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
