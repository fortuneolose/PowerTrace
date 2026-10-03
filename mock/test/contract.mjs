// End-to-end contract test for /mock/server.js (REST + Socket.IO). Run via `npm test` in /mock, which starts the server for you.
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3999';
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function call(method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, type: res.headers.get('content-type') };
}

function connect() {
  const s = io(BASE, { transports: ['websocket'] });
  s.log = [];
  s.onAny((ev, payload) => s.log.push({ ev, payload }));
  return new Promise((resolve) => s.on('connect', () => resolve(s)));
}
async function waitFor(sock, mark, ev, pred = () => true, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = sock.log.slice(mark).find((e) => e.ev === ev && pred(e.payload));
    if (hit) return hit.payload;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

const s = await connect();
const H = { 'X-Socket-Id': s.id, 'X-Who': 'tester' };
let mark;

// health
let r = await call('GET', '/api/health');
check('health', r.status === 200 && eq(r.json, { ok: true, db: 'connected', sites: ['demo', 'hospital'] }), r.text);

// reset first so the run is repeatable
r = await call('POST', '/api/reset', { headers: H });
check('reset (initial) -> { ok: true, nodes: 60 }', r.status === 200 && eq(r.json, { ok: true, nodes: 60 }), r.text);

// tree
r = await call('GET', '/api/tree');
const tree0 = r.json;
check('tree: 60 nodes', tree0.site === 'demo' && tree0.nodes.length === 60, `${tree0.nodes?.length}`);
check('tree: loads for all 9 boards', Object.keys(tree0.loads).length === 9, JSON.stringify(tree0.loads));
check('tree: nothing de-energised', eq(tree0.deenergised, []));
console.log('      initial loads:', JSON.stringify(tree0.loads));

r = await call('GET', '/api/tree?level=3');
check('tree?level=3: only level-3 nodes', r.json.nodes.length > 0 && r.json.nodes.every((n) => n.level === 3), `${r.json.nodes.length}`);
check('tree?level=3: loads only for level-3 boards', eq(Object.keys(r.json.loads).sort(), ['DB-L3-01', 'DB-L3-02']), JSON.stringify(r.json.loads));
r = await call('GET', '/api/tree?site=bogus');
check('unknown site -> 400 BAD_REQUEST', r.status === 400 && r.json.code === 'BAD_REQUEST', r.text);
r = await call('GET', '/api/tree?level=abc');
check('tree?level=abc -> 400', r.status === 400 && r.json.code === 'BAD_REQUEST', r.text);

// nodes/:id
r = await call('GET', '/api/nodes/AHU-07');
check('nodes/AHU-07 -> node + energised', r.status === 200 && r.json.node._id === 'AHU-07' && r.json.energised === true, r.text);
r = await call('GET', '/api/nodes/NOPE');
check('nodes/NOPE -> 404 NOT_FOUND', r.status === 404 && r.json.code === 'NOT_FOUND' && typeof r.json.error === 'string', r.text);

// boards
r = await call('GET', '/api/boards');
const boards = r.json.boards;
check('boards: 9 boards with loadPct', boards.length === 9 && boards.every((b) => typeof b.loadPct === 'number'), r.text);
check('boards: ordered by level then id', eq(boards.map((b) => b._id), ['MSB', 'SMSB-A', 'SMSB-B', 'DB-L1-01', 'DB-L1-02', 'DB-L2-01', 'DB-L2-02', 'DB-L3-01', 'DB-L3-02']), boards.map((b) => b._id).join());
check('boards: contract fields', eq(Object.keys(boards[0]).sort(), ['_id', 'capacityKW', 'level', 'loadPct', 'name', 'phases', 'tripped', 'voltage']));

// claim
mark = s.log.length;
r = await call('POST', '/api/claim', { headers: H, body: {} });
check('claim -> equipment claimed by my socket', r.status === 200 && r.json.node.type === 'equipment' && r.json.node.claimedBy === s.id && r.json.energised === true, r.text);
check('claim -> socket event "claim"', !!(await waitFor(s, mark, 'event', (e) => e.action === 'claim' && e.to === s.id && e.from === null)));
r = await call('POST', '/api/claim', { headers: H, body: { preferId: 'AHU-07' } });
check('claim preferId AHU-07 honoured', r.status === 200 && r.json.node._id === 'AHU-07' && r.json.node.claimedBy === s.id, r.text);
r = await call('POST', '/api/claim', { body: {} });
check('claim without X-Socket-Id -> generated claimer id', r.status === 200 && typeof r.json.node.claimedBy === 'string' && r.json.node.claimedBy.length > 0, r.text);

// toggle
mark = s.log.length;
r = await call('POST', '/api/nodes/AHU-07/toggle', { headers: H });
check('toggle AHU-07 (empty body) -> off', r.status === 200 && r.json.node.on === false, r.text);
let nc = await waitFor(s, mark, 'node:changed', (p) => p.node._id === 'AHU-07' && p.node.on === false);
let loads = await waitFor(s, mark, 'loads', (p) => p['DB-L3-01'] < tree0.loads['DB-L3-01']);
let ev = await waitFor(s, mark, 'event', (e) => e.action === 'toggle');
check('toggle -> node:changed', !!nc);
check('toggle -> loads with DB-L3-01 lower', loads && loads['DB-L3-01'] < tree0.loads['DB-L3-01'], JSON.stringify(loads));
check('toggle -> event on->off, who=tester, level 3', ev && ev.from === 'on' && ev.to === 'off' && ev.who === 'tester' && ev.nodeId === 'AHU-07' && ev.level === 3 && typeof ev.ts === 'string', JSON.stringify(ev));
r = await call('POST', '/api/nodes/AHU-07/toggle', { headers: H, body: { on: true } });
check('toggle { on: true } -> on', r.status === 200 && r.json.node.on === true, r.text);
r = await call('POST', '/api/nodes/AHU-07/toggle', { headers: H, body: { on: 'yes' } });
check('toggle { on: "yes" } -> 400', r.status === 400 && r.json.code === 'BAD_REQUEST', r.text);
r = await call('POST', '/api/nodes/DB-L3-01/toggle', { headers: H });
check('toggle a board -> 400', r.status === 400, r.text);

// load
mark = s.log.length;
r = await call('POST', '/api/nodes/AHU-07/load', { headers: H, body: { deltaKW: 5 } });
check('load +5 on AHU-07 -> 20 kW', r.status === 200 && r.json.node.loadKW === 20, r.text);
nc = await waitFor(s, mark, 'node:changed', (p) => p.node._id === 'AHU-07' && p.node.loadKW === 20);
loads = await waitFor(s, mark, 'loads', (p) => p['DB-L3-01'] > tree0.loads['DB-L3-01']);
ev = await waitFor(s, mark, 'event', (e) => e.action === 'load');
check('load -> node:changed', !!nc);
check('load -> loads with DB-L3-01 higher than start', loads && loads['DB-L3-01'] > tree0.loads['DB-L3-01'], JSON.stringify(loads));
check('load -> event 15 -> 20 (numbers)', ev && ev.from === 15 && ev.to === 20, JSON.stringify(ev));
r = await call('POST', '/api/nodes/AHU-07/load', { headers: H, body: { deltaKW: 51 } });
check('load deltaKW 51 -> 400', r.status === 400 && r.json.code === 'BAD_REQUEST', r.text);
r = await call('POST', '/api/nodes/AHU-07/load', { headers: H, body: { deltaKW: '5' } });
check('load deltaKW "5" -> 400', r.status === 400, r.text);
r = await call('POST', '/api/nodes/LTG-L3-02/load', { headers: H, body: { deltaKW: -50 } });
check('load -50 on 1.2 kW item floors at 0', r.status === 200 && r.json.node.loadKW === 0, r.text);
await call('POST', '/api/nodes/LTG-L3-02/load', { headers: H, body: { deltaKW: 1.2 } });
for (let i = 0; i < 6; i++) await call('POST', '/api/nodes/AHU-07/load', { headers: H, body: { deltaKW: 5 } });
r = await call('GET', '/api/boards');
const l301 = r.json.boards.find((b) => b._id === 'DB-L3-01').loadPct;
check('load is never rejected for overload (DB-L3-01 > 100%)', l301 > 100, `${l301}%`);
await call('POST', '/api/nodes/AHU-07/load', { headers: H, body: { deltaKW: -30 } }); // back to 20 kW

// rewire rejections
mark = s.log.length;
r = await call('POST', '/api/nodes/AHU-07/rewire', { headers: H, body: { parentId: 'DB-L2-02' } });
check('rewire AHU-07 -> DB-L2-02 -> 409 PHASE_MISMATCH', r.status === 409 && eq(r.json, { error: 'Rejected: DB-L2-02 is single-phase', code: 'PHASE_MISMATCH' }), r.text);
const rej = await waitFor(s, mark, 'rejected', (p) => p.code === 'PHASE_MISMATCH');
check('rewire rejection -> socket "rejected" to caller', rej && eq(rej, { reason: 'Rejected: DB-L2-02 is single-phase', code: 'PHASE_MISMATCH', nodeId: 'AHU-07' }), JSON.stringify(rej));
r = await call('POST', '/api/nodes/SMSB-B/rewire', { headers: H, body: { parentId: 'DB-L3-01' } });
check('rewire SMSB-B -> DB-L3-01 -> 409 CIRCULAR_FEED', r.status === 409 && eq(r.json, { error: 'Rejected: circular feed (DB-L3-01 is downstream of SMSB-B)', code: 'CIRCULAR_FEED' }), r.text);
r = await call('POST', '/api/nodes/DB-L3-01/rewire', { headers: H, body: { parentId: 'DB-L3-01' } });
check('rewire onto itself -> 409 CIRCULAR_FEED', r.status === 409 && r.json.code === 'CIRCULAR_FEED', r.text);
r = await call('POST', '/api/nodes/AHU-07/rewire', { headers: H, body: { parentId: 'AHU-08' } });
check('rewire onto equipment -> 409 NOT_A_BOARD', r.status === 409 && r.json.code === 'NOT_A_BOARD', r.text);
r = await call('POST', '/api/nodes/AHU-07/rewire', { headers: H, body: { parentId: 'DB-NOPE' } });
check('rewire onto unknown board -> 404 NOT_FOUND', r.status === 404 && r.json.code === 'NOT_FOUND', r.text);
r = await call('POST', '/api/nodes/NOPE/rewire', { headers: H, body: { parentId: 'DB-L2-01' } });
check('rewire unknown node -> 404 NOT_FOUND', r.status === 404 && r.json.code === 'NOT_FOUND', r.text);
r = await call('POST', '/api/nodes/AHU-07/rewire', { headers: H, body: {} });
check('rewire without parentId -> 400', r.status === 400 && r.json.code === 'BAD_REQUEST', r.text);
r = await call('POST', '/api/nodes/SMSB-B/rewire', { headers: H, body: { parentId: 'DB-L2-02' } });
check('SMSB-B -> DB-L2-02 (circular AND phase) -> CIRCULAR_FEED wins', r.status === 409 && r.json.code === 'CIRCULAR_FEED', r.text);
r = await call('POST', '/api/nodes/CH-01/rewire', { headers: H, body: { parentId: 'DB-L3-01' } });
check('rewire CH-01 (45 kW) -> DB-L3-01 -> 409 OVERLOAD', r.status === 409 && r.json.code === 'OVERLOAD' && /^Rejected: DB-L3-01 would be at \d+%$/.test(r.json.error), r.text);
console.log('      overload message:', r.json.error);

// trip SMSB-B
mark = s.log.length;
r = await call('POST', '/api/boards/SMSB-B/trip', { headers: H, body: { tripped: true } });
check('trip SMSB-B -> affected 28', r.status === 200 && r.json.boardId === 'SMSB-B' && r.json.tripped === true && r.json.affected.length === 28 && !r.json.affected.includes('SMSB-B'), `${r.json.affected?.length}`);
const trip = await waitFor(s, mark, 'trip', (p) => p.boardId === 'SMSB-B' && p.tripped === true);
check('trip -> socket "trip" with 28 affected incl. AHU-07', trip && trip.affected.length === 28 && trip.affected.includes('AHU-07'));
ev = await waitFor(s, mark, 'event', (e) => e.action === 'trip');
check('trip -> event trip false->true', ev && ev.from === false && ev.to === true && ev.nodeId === 'SMSB-B', JSON.stringify(ev));
r = await call('GET', '/api/tree');
check('tree after trip: 29 de-energised (board + 28)', r.json.deenergised.length === 29 && r.json.deenergised.includes('SMSB-B'), `${r.json.deenergised.length}`);
check('tree after trip: SMSB-B and DB-L3-01 load 0', r.json.loads['SMSB-B'] === 0 && r.json.loads['DB-L3-01'] === 0, JSON.stringify(r.json.loads));
r = await call('GET', '/api/nodes/AHU-07');
check('AHU-07 energised:false after trip', r.json.energised === false);
mark = s.log.length;
r = await call('POST', '/api/boards/SMSB-B/trip', { headers: H });
check('trip empty body flips back (reset)', r.status === 200 && r.json.tripped === false && r.json.affected.length === 28, r.text);
check('reset -> socket trip tripped:false', !!(await waitFor(s, mark, 'trip', (p) => p.tripped === false)));
check('reset -> event reset true->false', !!(await waitFor(s, mark, 'event', (e) => e.action === 'reset' && e.from === true && e.to === false)));
r = await call('POST', '/api/boards/AHU-07/trip', { headers: H });
check('trip on equipment -> 404', r.status === 404 && r.json.code === 'NOT_FOUND', r.text);

// valid rewire
mark = s.log.length;
r = await call('POST', '/api/nodes/LTG-L3-01/rewire', { headers: { ...H, 'X-Who': 'phone:LTG-L3-01' }, body: { parentId: 'DB-L2-01' } });
check('rewire LTG-L3-01 -> DB-L2-01 succeeds', r.status === 200 && r.json.node.parentId === 'DB-L2-01' && r.json.from === 'DB-L3-01' && r.json.to === 'DB-L2-01', r.text);
ev = await waitFor(s, mark, 'event', (e) => e.action === 'rewire');
check('rewire -> event from/to + X-Who', ev && ev.from === 'DB-L3-01' && ev.to === 'DB-L2-01' && ev.who === 'phone:LTG-L3-01', JSON.stringify(ev));
check('rewire -> node:changed + loads', !!(await waitFor(s, mark, 'node:changed', (p) => p.node._id === 'LTG-L3-01')) && !!(await waitFor(s, mark, 'loads')));

// traces + impact
r = await call('GET', '/api/trace/up/AHU-07');
check('trace/up AHU-07 -> [DB-L3-01, SMSB-B, MSB]', eq(r.json.path, ['DB-L3-01', 'SMSB-B', 'MSB']) && typeof r.json.queryMs === 'number', r.text);
r = await call('GET', '/api/trace/down/SMSB-B');
const d0 = r.json.downstream.filter((d) => d.depth === 0).map((d) => d._id).sort();
check('trace/down SMSB-B -> 27 after the rewire, depth 0 = direct children', r.json.downstream.length === 27 && eq(d0, ['DB-L2-02', 'DB-L3-01', 'DB-L3-02', 'EV-02', 'LIFT-01']) && typeof r.json.queryMs === 'number', r.text.slice(0, 300));
check('trace/down item shape', eq(Object.keys(r.json.downstream[0]).sort(), ['_id', 'depth', 'parentId', 'type']));
r = await call('GET', '/api/trace/down/NOPE');
check('trace/down unknown -> 404', r.status === 404);
r = await call('GET', '/api/impact/DB-L1-02');
check('impact DB-L1-02 -> 9 equipment, 2 critical (EM-L1-01, FA-01)', r.status === 200 && r.json.site === 'demo' && eq(r.json.counts, { total: 9, boards: 0, equipment: 9, critical: 2 }) && eq(r.json.critical.map((c) => c._id).sort(), ['EM-L1-01', 'FA-01']), JSON.stringify(r.json?.counts));
check('impact totalKW = on items only (1.2+1+2.5+3+0.4+0.3+0.8 = 9.2)', r.json.totalKW === 9.2, `${r.json.totalKW}`);
check('impact affected has depth/critical/loadKW', r.json.affected.every((a) => 'depth' in a && 'critical' in a && 'loadKW' in a && 'name' in a && 'kind' in a));
r = await call('GET', '/api/impact/MSB');
check('impact MSB -> total 59', r.json.counts.total === 59 && r.json.counts.boards === 8, JSON.stringify(r.json.counts));
r = await call('GET', '/api/impact/AHU-07');
check('impact on equipment -> 404', r.status === 404, r.text);

// history
r = await call('GET', '/api/history');
const actions = r.json.byAction.map((a) => a.action).sort();
check('history byAction has claim/load/reset/rewire/toggle/trip', ['claim', 'load', 'reset', 'rewire', 'toggle', 'trip'].every((a) => actions.includes(a)), actions.join());
check('history byDay today', r.json.byDay.length === 1 && r.json.byDay[0].day === new Date().toISOString().slice(0, 10), JSON.stringify(r.json.byDay));
check('history byWho tester first', r.json.byWho[0].who === 'tester', JSON.stringify(r.json.byWho));
check('history recent <= 50, newest first', r.json.recent.length <= 50 && r.json.recent[0].action === 'rewire', `${r.json.recent.length} ${r.json.recent[0]?.action}`);
r = await call('GET', '/api/history?level=0');
check('history?level=0 -> only level-0 events (trip/reset on SMSB-B)', r.json.recent.length > 0 && r.json.recent.every((e) => e.level === 0), JSON.stringify(r.json.byAction));
r = await call('GET', '/api/history?days=0');
check('history?days=0 -> 400', r.status === 400);

// import
r = await call('POST', '/api/import?site=hospital&replace=true', { raw: 'tag,type\nX,board\n', headers: { ...H, 'Content-Type': 'text/csv' } });
console.log(`      import status ${r.status}: ${r.text.slice(0, 200)}`);
check('import of a CSV missing columns -> 400 BAD_REQUEST (schedule.js present) or 501 NOT_IMPLEMENTED (missing)', (r.status === 400 && r.json.code === 'BAD_REQUEST') || (r.status === 501 && r.json.code === 'NOT_IMPLEMENTED'), r.text);

// hospital
r = await call('GET', '/api/tree?site=hospital');
check('tree?site=hospital -> 200', r.status === 200 && r.json.site === 'hospital' && Array.isArray(r.json.nodes), r.text.slice(0, 200));
console.log(`      hospital: ${r.json.nodes.length} nodes`);

// misc
r = await fetch(`${BASE}/api/nodes/AHU-07/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
let j = await r.json();
check('malformed JSON -> 400 BAD_REQUEST JSON', r.status === 400 && j.code === 'BAD_REQUEST', JSON.stringify(j));
r = await call('GET', '/api/nope');
check('unknown API route -> 404 JSON', r.status === 404 && r.json.code === 'NOT_FOUND', r.text);
r = await call('GET', '/join');
check('GET /join -> HTML', r.status === 200 && /text\/html/.test(r.type) && /<html/i.test(r.text), `${r.status} ${r.type}`);
r = await call('GET', '/socket.io/socket.io.js');
check('GET /socket.io/socket.io.js -> client script', r.status === 200 && r.text.length > 1000);

// disconnect releases claims
const s2 = await connect();
r = await call('POST', '/api/claim', { headers: { 'X-Socket-Id': s2.id }, body: { preferId: 'PMP-03' } });
check('second socket claims PMP-03', r.json.node._id === 'PMP-03' && r.json.node.claimedBy === s2.id);
mark = s.log.length;
s2.disconnect();
check('disconnect -> node:changed with claimedBy null', !!(await waitFor(s, mark, 'node:changed', (p) => p.node._id === 'PMP-03' && p.node.claimedBy === null)));
r = await call('GET', '/api/nodes/PMP-03');
check('PMP-03 released', r.json.node.claimedBy === null);

// reset
await call('POST', '/api/boards/DB-L3-02/trip', { headers: H, body: { tripped: true } });
mark = s.log.length;
r = await call('POST', '/api/reset', { headers: H });
check('reset -> { ok: true, nodes: 60 }', r.status === 200 && eq(r.json, { ok: true, nodes: 60 }), r.text);
check('reset -> tree:reload { site: demo }', !!(await waitFor(s, mark, 'tree:reload', (p) => p.site === 'demo')));
check('reset -> trip restored for previously tripped DB-L3-02', !!(await waitFor(s, mark, 'trip', (p) => p.boardId === 'DB-L3-02' && p.tripped === false && p.affected.length === 7)));
r = await call('GET', '/api/tree');
check('tree after reset: 60 nodes, LTG-L3-01 back on DB-L3-01, loads as at start, no claims', r.json.nodes.length === 60 && r.json.nodes.find((n) => n._id === 'LTG-L3-01').parentId === 'DB-L3-01' && eq(r.json.loads, tree0.loads) && r.json.deenergised.length === 0 && r.json.nodes.every((n) => !n.claimedBy), JSON.stringify(r.json.loads));
r = await call('GET', '/api/history');
check('history empty after reset', r.json.recent.length === 0);
r = await call('POST', '/api/reset?site=hospital', { headers: H });
check('reset?site=hospital -> 400', r.status === 400, r.text);

s.disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
