// PowerTrace mock server. Owner: lead. An in-memory implementation of CONTRACT.md (REST + Socket.IO)
// so /screen, /join and /bot can be built before the real MongoDB backend is live.
// The real backend does the graph work with $graphLookup; here it's data/lib/graph.js over plain arrays.
import fs from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { getDemoNodes } from '../data/demo-building.js';
import { indexNodes, downstream, upstream, deenergised, boardLoadsKW, boardLoadPercents } from '../data/lib/graph.js';

const PORT = Number(process.env.PORT) || 3000;
const SITE_NAMES = ['demo', 'hospital'];
const MAX_EVENTS = 50_000;

// --- Optional modules from /data: the synthetic hospital and the cable-schedule parser ---
let generateHospital = null;
let parseSchedule = null;
try {
  ({ generateHospital } = await import('../data/lib/hospital.js'));
} catch (err) {
  console.warn(`[mock] data/lib/hospital.js not loaded (${err.message}); the hospital site starts empty`);
}
try {
  ({ parseSchedule } = await import('../data/lib/schedule.js'));
} catch (err) {
  console.warn(`[mock] data/lib/schedule.js not loaded (${err.message}); POST /api/import will return 501`);
}

async function freshHospital() {
  if (typeof generateHospital !== 'function') return { nodes: [], events: [] };
  try {
    const { nodes = [], events = [] } = await generateHospital({ now: new Date() });
    return { nodes, events: events.map((e) => ({ ...e, ts: new Date(e.ts) })) };
  } catch (err) {
    console.warn(`[mock] generateHospital() failed (${err.message}); the hospital site starts empty`);
    return { nodes: [], events: [] };
  }
}

// --- State: everything lives in memory. Restart or POST /api/reset to start over. ---
const sites = {
  demo: { nodes: getDemoNodes(), events: [] },
  hospital: await freshHospital(),
};

// --- Server ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/csv', limit: '5mb' }));
app.use((req, res, next) => {
  const t0 = performance.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`));
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- Helpers ---
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const badRequest = (message) => new ApiError(400, 'BAD_REQUEST', message);
const notFound = (message) => new ApiError(404, 'NOT_FOUND', message);
const conflict = (code, message) => new ApiError(409, code, message);

const round2 = (x) => Math.round(x * 100) / 100;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const byId = (a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0); // binary order, like MongoDB

function siteOf(req) {
  const name = req.query.site ?? 'demo';
  if (!SITE_NAMES.includes(name)) throw badRequest(`Unknown site "${name}" (expected demo or hospital)`);
  return { name, site: sites[name] };
}

function getNode(site, id) {
  const node = site.nodes.find((n) => n._id === id);
  if (!node) throw notFound(`Unknown node ${id}`);
  return node;
}

function getBoard(site, id) {
  const node = getNode(site, id);
  if (node.type !== 'board') throw notFound(`${id} is not a board`);
  return node;
}

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function intParam(value, name) {
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isInteger(n)) throw badRequest(`${name} must be an integer`);
  return n;
}

const isEnergised = (site, id) => !deenergised(site.nodes).has(id);

// Wraps a handler: ApiErrors become { error, code } responses, and a rejected mutation
// is also pushed to the caller's socket (X-Socket-Id) as `rejected`.
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!(err instanceof ApiError)) return next(err);
    res.status(err.status).json({ error: err.message, code: err.code });
    const socketId = req.get('X-Socket-Id');
    if (req.method === 'POST' && socketId) {
      io.to(socketId).emit('rejected', { reason: err.message, code: err.code, nodeId: req.params.id ?? null });
    }
  }
};

// Appends to the site's audit trail; broadcast as `event` for the demo site only.
function record(req, siteName, { action, nodeId, from, to, level }) {
  const event = {
    _id: randomBytes(12).toString('hex'),
    ts: new Date(),
    who: req.get('X-Who') || 'anonymous',
    action,
    nodeId,
    from,
    to,
    level,
  };
  const { events } = sites[siteName];
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (siteName === 'demo') io.emit('event', event);
  return event;
}

// `node:changed` per changed node, then the recomputed `loads` (demo site only, per the contract).
function nodesChanged(siteName, nodes) {
  if (siteName !== 'demo') return;
  for (const node of nodes) io.emit('node:changed', { node: { ...node } });
  io.emit('loads', boardLoadPercents(sites.demo.nodes));
}

// --- REST (CONTRACT.md section 2) ---
const api = express.Router();

api.get('/health', (req, res) => res.json({ ok: true, db: 'connected', sites: SITE_NAMES }));

api.get('/tree', route((req, res) => {
  const { name, site } = siteOf(req);
  const idx = indexNodes(site.nodes);
  let nodes = site.nodes;
  let loads = boardLoadPercents(site.nodes, idx);
  let dead = [...deenergised(site.nodes, idx)];
  if (req.query.level !== undefined) {
    const level = intParam(req.query.level, 'level');
    nodes = nodes.filter((n) => n.level === level);
    const ids = new Set(nodes.map((n) => n._id));
    loads = Object.fromEntries(Object.entries(loads).filter(([id]) => ids.has(id)));
    dead = dead.filter((id) => ids.has(id));
  }
  res.json({ site: name, nodes, loads, deenergised: dead });
}));

api.get('/nodes/:id', route((req, res) => {
  const { site } = siteOf(req);
  const node = getNode(site, req.params.id);
  res.json({ node, energised: isEnergised(site, node._id) });
}));

api.get('/boards', route((req, res) => {
  const { site } = siteOf(req);
  const pct = boardLoadPercents(site.nodes);
  const boards = site.nodes
    .filter((n) => n.type === 'board')
    .sort((a, b) => a.level - b.level || byId(a, b))
    .map(({ _id, name, level, phases, voltage, capacityKW, tripped }) => (
      { _id, name, level, phases, voltage, capacityKW, tripped, loadPct: pct[_id] }
    ));
  res.json({ boards });
}));

// Claiming is a demo-site feature: ?site is ignored.
api.post('/claim', route((req, res) => {
  const site = sites.demo;
  const claimer = req.get('X-Socket-Id') || `client-${randomBytes(4).toString('hex')}`;
  const equipment = site.nodes.filter((n) => n.type === 'equipment');
  if (!equipment.length) throw notFound('The demo site has no equipment to claim');
  const { preferId } = body(req);
  const unclaimed = equipment.filter((n) => !n.claimedBy);
  const node = equipment.find((n) => n._id === preferId) ?? pick(unclaimed.length ? unclaimed : equipment);
  const from = node.claimedBy;
  node.claimedBy = claimer;
  nodesChanged('demo', [node]);
  record(req, 'demo', { action: 'claim', nodeId: node._id, from, to: claimer, level: node.level });
  res.json({ node, energised: isEnergised(site, node._id) });
}));

api.post('/nodes/:id/toggle', route((req, res) => {
  const { name, site } = siteOf(req);
  const node = getNode(site, req.params.id);
  if (node.type !== 'equipment') throw badRequest(`${node._id} is a board: use POST /api/boards/${node._id}/trip`);
  const { on } = body(req);
  if (on !== undefined && typeof on !== 'boolean') throw badRequest('"on" must be true or false');
  const before = node.on;
  node.on = on ?? !node.on;
  nodesChanged(name, [node]);
  record(req, name, { action: 'toggle', nodeId: node._id, from: before ? 'on' : 'off', to: node.on ? 'on' : 'off', level: node.level });
  res.json({ node });
}));

// Validation order: NOT_FOUND -> NOT_A_BOARD -> CIRCULAR_FEED -> PHASE_MISMATCH -> OVERLOAD.
api.post('/nodes/:id/rewire', route((req, res) => {
  const { name, site } = siteOf(req);
  const node = getNode(site, req.params.id);
  const { parentId } = body(req);
  if (typeof parentId !== 'string' || !parentId) throw badRequest('Body must be { "parentId": "<board id>" }');
  const target = getNode(site, parentId);
  if (target.type !== 'board') throw conflict('NOT_A_BOARD', `Rejected: ${target._id} is not a board`);

  const idx = indexNodes(site.nodes);
  if (target._id === node._id) {
    throw conflict('CIRCULAR_FEED', `Rejected: circular feed (${node._id} cannot feed itself)`);
  }
  if (downstream(site.nodes, node._id, idx).some((d) => d.node._id === target._id)) {
    throw conflict('CIRCULAR_FEED', `Rejected: circular feed (${target._id} is downstream of ${node._id})`);
  }
  if (node.phases === 3 && target.phases === 1) {
    throw conflict('PHASE_MISMATCH', `Rejected: ${target._id} is single-phase`);
  }

  // Simulate the move. A board is overloaded by it if the move raises its load and leaves it over 100%;
  // boards whose load the move doesn't change (common ancestors) are left alone.
  const moved = site.nodes.map((n) => (n === node ? { ...n, parentId: target._id } : n));
  const before = boardLoadsKW(site.nodes, idx);
  const after = boardLoadsKW(moved);
  for (const id of [target._id, ...upstream(moved, target._id)]) {
    const pct = Math.round((after[id] / idx.byId.get(id).capacityKW) * 100);
    if (pct > 100 && after[id] > before[id] + 1e-9) {
      throw conflict('OVERLOAD', `Rejected: ${id} would be at ${pct}%`);
    }
  }

  const from = node.parentId;
  node.parentId = target._id;
  nodesChanged(name, [node]);
  record(req, name, { action: 'rewire', nodeId: node._id, from, to: target._id, level: node.level });
  res.json({ node, from, to: target._id });
}));

api.post('/nodes/:id/load', route((req, res) => {
  const { name, site } = siteOf(req);
  const node = getNode(site, req.params.id);
  if (node.type !== 'equipment') throw badRequest(`${node._id} is a board: load is set on equipment`);
  const { deltaKW } = body(req);
  if (typeof deltaKW !== 'number' || !Number.isFinite(deltaKW) || deltaKW < -50 || deltaKW > 50) {
    throw badRequest('deltaKW must be a number between -50 and 50');
  }
  const before = node.loadKW;
  node.loadKW = Math.max(0, round2(node.loadKW + deltaKW));
  nodesChanged(name, [node]);
  record(req, name, { action: 'load', nodeId: node._id, from: before, to: node.loadKW, level: node.level });
  res.json({ node });
}));

api.post('/boards/:id/trip', route((req, res) => {
  const { name, site } = siteOf(req);
  const board = getBoard(site, req.params.id);
  const { tripped } = body(req);
  if (tripped !== undefined && typeof tripped !== 'boolean') throw badRequest('"tripped" must be true or false');
  const before = board.tripped;
  board.tripped = tripped ?? !board.tripped;
  const affected = downstream(site.nodes, board._id).map((d) => d.node._id);
  nodesChanged(name, [board]);
  record(req, name, { action: board.tripped ? 'trip' : 'reset', nodeId: board._id, from: before, to: board.tripped, level: board.level });
  if (name === 'demo') io.emit('trip', { boardId: board._id, tripped: board.tripped, affected });
  res.json({ boardId: board._id, tripped: board.tripped, affected });
}));

api.get('/trace/down/:id', route((req, res) => {
  const { site } = siteOf(req);
  const t0 = performance.now();
  const node = getNode(site, req.params.id);
  const result = downstream(site.nodes, node._id).map(({ node: n, depth }) => (
    { _id: n._id, type: n.type, parentId: n.parentId, depth }
  ));
  res.json({ id: node._id, downstream: result, queryMs: Math.round(performance.now() - t0) });
}));

api.get('/trace/up/:id', route((req, res) => {
  const { site } = siteOf(req);
  const t0 = performance.now();
  const node = getNode(site, req.params.id);
  const path = upstream(site.nodes, node._id);
  res.json({ id: node._id, path, queryMs: Math.round(performance.now() - t0) });
}));

api.get('/impact/:id', route((req, res) => {
  const { name, site } = siteOf(req);
  const t0 = performance.now();
  const board = getBoard(site, req.params.id);
  const down = downstream(site.nodes, board._id);
  const equipment = down.map((d) => d.node).filter((n) => n.type === 'equipment');
  const critical = equipment
    .filter((n) => n.critical)
    .map(({ _id, name: label, kind, parentId, level, loadKW }) => ({ _id, name: label, kind, parentId, level, loadKW }));
  const affected = down.map(({ node: n, depth }) => {
    const isEquipment = n.type === 'equipment';
    return {
      _id: n._id, type: n.type, name: n.name, kind: n.kind, parentId: n.parentId, level: n.level, depth,
      critical: isEquipment && !!n.critical, loadKW: isEquipment ? n.loadKW : 0,
    };
  });
  res.json({
    boardId: board._id,
    site: name,
    counts: { total: down.length, boards: down.length - equipment.length, equipment: equipment.length, critical: critical.length },
    totalKW: round2(equipment.filter((n) => n.on).reduce((sum, n) => sum + n.loadKW, 0)),
    critical,
    affected,
    queryMs: Math.round(performance.now() - t0),
  });
}));

api.post('/import', route(async (req, res) => {
  const { name, site } = siteOf(req);
  if (typeof parseSchedule !== 'function') {
    throw new ApiError(501, 'NOT_IMPLEMENTED', 'CSV import is not available in the mock: data/lib/schedule.js is missing or failed to load');
  }
  if (typeof req.body !== 'string' || !req.body.trim()) {
    throw badRequest('Send the cable schedule CSV as the raw request body with Content-Type: text/csv');
  }
  const t0 = performance.now();
  const replace = req.query.replace === 'true';
  const existingIds = replace ? new Set() : new Set(site.nodes.map((n) => n._id));
  const { total, valid, rejected } = await parseSchedule(req.body, { existingIds });
  if (replace) site.nodes = [];
  for (const node of valid) site.nodes.push(node);
  record(req, name, { action: 'import', nodeId: null, from: null, to: `${valid.length} rows`, level: null });
  io.emit('tree:reload', { site: name });
  res.json({ total, imported: valid.length, rejected, ms: Math.round(performance.now() - t0) });
}));

api.get('/history', route((req, res) => {
  const { site } = siteOf(req);
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  if (!(days > 0)) throw badRequest('days must be a positive number');
  const level = req.query.level === undefined ? undefined : intParam(req.query.level, 'level');
  const since = Date.now() - days * 86_400_000;
  const events = site.events.filter((e) => e.ts.getTime() >= since && (level === undefined || e.level === level));

  const countBy = (key, keyOf) => {
    const counts = new Map();
    for (const e of events) counts.set(keyOf(e), (counts.get(keyOf(e)) ?? 0) + 1);
    return [...counts].map(([k, count]) => ({ [key]: k, count }));
  };
  const byCount = (key) => (a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key]));
  res.json({
    byDay: countBy('day', (e) => e.ts.toISOString().slice(0, 10)).sort((a, b) => a.day.localeCompare(b.day)),
    byWho: countBy('who', (e) => e.who).sort(byCount('who')),
    byAction: countBy('action', (e) => e.action).sort(byCount('action')),
    recent: [...events].sort((a, b) => b.ts - a.ts).slice(0, 50),
  });
}));

api.post('/reset', route((req, res) => {
  const { name } = siteOf(req);
  if (name !== 'demo') throw badRequest('Reset only re-seeds the demo site');
  const old = sites.demo.nodes;
  const wasTripped = old.filter((n) => n.type === 'board' && n.tripped);
  const restored = wasTripped.map((b) => ({ boardId: b._id, tripped: false, affected: downstream(old, b._id).map((d) => d.node._id) }));
  sites.demo = { nodes: getDemoNodes(), events: [] };
  io.emit('tree:reload', { site: 'demo' });
  for (const trip of restored) io.emit('trip', trip); // so phones that lost power show "Power restored"
  nodesChanged('demo', sites.demo.nodes);
  res.json({ ok: true, nodes: sites.demo.nodes.length });
}));

api.use((req, res) => res.status(404).json({ error: `No route ${req.method} /api${req.path}`, code: 'NOT_FOUND' }));
app.use('/api', api);

// --- Static pages: phones at /join, the built screen (if any) at / ---
const joinDir = fileURLToPath(new URL('../join', import.meta.url));
const screenDist = fileURLToPath(new URL('../screen/dist', import.meta.url));
const hasScreen = fs.existsSync(screenDist);
app.use('/join', express.static(joinDir));
if (hasScreen) {
  app.use(express.static(screenDist));
  app.get(/^\/(?!api|socket\.io|join).*/, (req, res) => res.sendFile(`${screenDist}/index.html`));
} else {
  app.get('/', (req, res) => res.type('text').send('PowerTrace mock: API at /api, phones at /join. Run the screen with `npm run screen`.'));
}

// Body-parser errors (bad JSON, CSV over 5 MB) and anything unexpected, in the contract's error shape.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json(status >= 500
    ? { error: 'Internal mock server error', code: 'INTERNAL' }
    : { error: err.message, code: 'BAD_REQUEST' });
});

// --- Socket.IO (CONTRACT.md section 3): clients only listen; a phone's claim is released on disconnect ---
io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    const released = sites.demo.nodes.filter((n) => n.claimedBy === socket.id);
    for (const n of released) n.claimedBy = null;
    if (released.length) nodesChanged('demo', released);
  });
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `[mock] port ${PORT} is already in use (set PORT=...)` : err);
  process.exit(1);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nPowerTrace MOCK (in-memory, no MongoDB) on ${url}`);
  console.log(`  phones:   ${url}/join`);
  console.log(`  screen:   ${hasScreen ? `${url}/ (screen/dist)` : 'not built here; run the Vite dev server (npm run screen)'}`);
  console.log(`  demo:     ${sites.demo.nodes.length} nodes`);
  console.log(`  hospital: ${sites.hospital.nodes.length} nodes, ${sites.hospital.events.length} events`);
  console.log(`  import:   ${parseSchedule ? 'enabled' : 'disabled (data/lib/schedule.js missing)'}\n`);
});
