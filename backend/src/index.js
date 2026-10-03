// PowerTrace backend. Owner: agent 4 (backend). Implements CONTRACT.md on MongoDB.
// Graph work ($graphLookup) lives in graph.js, change streams in realtime.js, CSV import in importer.js.
import fs from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { config } from './config.js';
import { connect, getDb, SITES } from './db.js';
import { ensureSchema } from './schema.js';
import { DOWN, downstreamOf, upstreamOf, isEnergised, boardLoads, contributionKW, explainMillis } from './graph.js';
import { createRealtime } from './realtime.js';
import { CsvError, prepare, importRows } from './importer.js';
import { getDemoNodes } from '../../data/demo-building.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));
app.use((req, res, next) => {
  const t0 = performance.now();
  res.on('finish', () => {
    if (req.originalUrl.startsWith('/api')) console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`);
  });
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const rt = createRealtime(io, () => getDb('demo'));

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
const elapsed = (t0) => Math.round(performance.now() - t0);

function siteOf(req) {
  const name = req.query.site ?? 'demo';
  if (!SITES.includes(name)) throw badRequest(`Unknown site "${name}" (expected demo or hospital)`);
  const db = getDb(name);
  return { name, db, nodes: db.collection('nodes'), events: db.collection('events') };
}

async function getNode(nodes, id) {
  const node = await nodes.findOne({ _id: id });
  if (!node) throw notFound(`Unknown node ${id}`);
  return node;
}

async function getBoard(nodes, id) {
  const node = await getNode(nodes, id);
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

// Wraps a handler: ApiErrors become { error, code }; MongoDB validator failures become 422;
// a rejected mutation is also pushed to the caller's socket (X-Socket-Id) as `rejected`.
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    let apiErr = err;
    if (!(err instanceof ApiError)) {
      if (err?.code === 121) apiErr = new ApiError(422, 'SCHEMA_VALIDATION', `Rejected by the schema validator: ${err.message}`);
      else if (err instanceof CsvError) apiErr = badRequest(err.message);
      else return next(err);
    }
    res.status(apiErr.status).json({ error: apiErr.message, code: apiErr.code });
    const socketId = req.get('X-Socket-Id');
    if (req.method === 'POST' && socketId) {
      io.to(socketId).emit('rejected', { reason: apiErr.message, code: apiErr.code, nodeId: req.params.id ?? null });
    }
  }
};

// Audit trail. On the demo site the change stream on `events` broadcasts it as `event`.
async function record(req, site, { action, nodeId, from, to, level }) {
  const event = { ts: new Date(), who: req.get('X-Who') || 'anonymous', action, nodeId, from, to, level };
  await site.events.insertOne(event);
  rt.eventRecorded(site.name, event);
  return event;
}

const update = (nodes, id, change) => nodes.findOneAndUpdate({ _id: id }, change, { returnDocument: 'after' });

// --- REST (CONTRACT.md section 2) ---
const api = express.Router();

api.get('/health', route(async (req, res) => {
  await getDb('demo').command({ ping: 1 });
  res.json({ ok: true, db: 'connected', sites: SITES });
}));

api.get('/tree', route(async (req, res) => {
  const site = siteOf(req);
  const filter = {};
  if (req.query.level !== undefined) filter.level = intParam(req.query.level, 'level');
  const [nodes, { pct, dead }] = await Promise.all([site.nodes.find(filter).toArray(), boardLoads(site.nodes)]);
  const ids = new Set(nodes.map((n) => n._id));
  const loads = Object.fromEntries(Object.entries(pct).filter(([id]) => ids.has(id)));
  res.json({ site: site.name, nodes, loads, deenergised: [...dead].filter((id) => ids.has(id)) });
}));

api.get('/nodes/:id', route(async (req, res) => {
  const site = siteOf(req);
  const node = await getNode(site.nodes, req.params.id);
  res.json({ node, energised: await isEnergised(site.nodes, node) });
}));

api.get('/boards', route(async (req, res) => {
  const site = siteOf(req);
  const [boards, { pct }] = await Promise.all([
    site.nodes.find({ type: 'board' }, { projection: { name: 1, level: 1, phases: 1, voltage: 1, capacityKW: 1, tripped: 1 } })
      .sort({ level: 1, _id: 1 }).toArray(),
    boardLoads(site.nodes),
  ]);
  res.json({ boards: boards.map((b) => ({ ...b, loadPct: pct[b._id] ?? 0 })) });
}));

// Claiming is a demo-site feature: ?site is ignored.
api.post('/claim', route(async (req, res) => {
  const site = { name: 'demo', nodes: getDb('demo').collection('nodes'), events: getDb('demo').collection('events') };
  const claimer = req.get('X-Socket-Id') || `client-${randomBytes(4).toString('hex')}`;
  const { preferId } = body(req);
  let node = null;
  if (typeof preferId === 'string' && preferId) node = await site.nodes.findOne({ _id: preferId, type: 'equipment' });
  if (!node) [node] = await site.nodes.aggregate([{ $match: { type: 'equipment', claimedBy: null } }, { $sample: { size: 1 } }]).toArray();
  if (!node) [node] = await site.nodes.aggregate([{ $match: { type: 'equipment' } }, { $sample: { size: 1 } }]).toArray();
  if (!node) throw notFound('The demo site has no equipment to claim');
  const updated = await update(site.nodes, node._id, { $set: { claimedBy: claimer } });
  rt.nodesChanged('demo', [updated]);
  await record(req, site, { action: 'claim', nodeId: node._id, from: node.claimedBy ?? null, to: claimer, level: node.level });
  res.json({ node: updated, energised: await isEnergised(site.nodes, updated) });
}));

// Never rejected for overload: piling load on until a board goes red is the point of the demo.
api.post('/nodes/:id/toggle', route(async (req, res) => {
  const site = siteOf(req);
  const node = await getNode(site.nodes, req.params.id);
  if (node.type !== 'equipment') throw badRequest(`${node._id} is a board: use POST /api/boards/${node._id}/trip`);
  const { on } = body(req);
  if (on !== undefined && typeof on !== 'boolean') throw badRequest('"on" must be true or false');
  const next = on ?? !node.on;
  const updated = await update(site.nodes, node._id, { $set: { on: next } });
  rt.nodesChanged(site.name, [updated]);
  await record(req, site, { action: 'toggle', nodeId: node._id, from: node.on ? 'on' : 'off', to: next ? 'on' : 'off', level: node.level });
  res.json({ node: updated });
}));

// Validation order: NOT_FOUND -> NOT_A_BOARD -> CIRCULAR_FEED -> PHASE_MISMATCH -> OVERLOAD.
api.post('/nodes/:id/rewire', route(async (req, res) => {
  const site = siteOf(req);
  const node = await getNode(site.nodes, req.params.id);
  const { parentId } = body(req);
  if (typeof parentId !== 'string' || !parentId) throw badRequest('Body must be { "parentId": "<board id>" }');
  const target = await getNode(site.nodes, parentId);
  if (target.type !== 'board') throw conflict('NOT_A_BOARD', `Rejected: ${target._id} is not a board`);

  // Circular feed: the new parent is the node itself, or somewhere downstream of it ($graphLookup).
  if (target._id === node._id) throw conflict('CIRCULAR_FEED', `Rejected: circular feed (${node._id} cannot feed itself)`);
  const [loop] = await site.nodes.aggregate([
    { $match: { _id: node._id } },
    DOWN('down'),
    { $project: { hit: { $in: [target._id, '$down._id'] } } },
  ]).toArray();
  if (loop?.hit) throw conflict('CIRCULAR_FEED', `Rejected: circular feed (${target._id} is downstream of ${node._id})`);

  if (node.phases === 3 && target.phases === 1) throw conflict('PHASE_MISMATCH', `Rejected: ${target._id} is single-phase`);

  // Overload: would the move push the target, or any board upstream of it, over 100%?
  // A board only counts if the move raises its load (common ancestors of old and new feeds don't change).
  const [newUp, oldUp, loads, c] = await Promise.all([
    upstreamOf(site.nodes, target._id),
    upstreamOf(site.nodes, node._id),
    boardLoads(site.nodes),
    contributionKW(site.nodes, node),
  ]);
  const newPath = [target, ...newUp];
  if (c > 0 && !newPath.some((b) => b.tripped)) {
    const oldIdx = new Map(oldUp.map((b, i) => [b._id, i]));
    const firstOldTrip = oldUp.findIndex((b) => b.tripped);
    for (const b of newPath) {
      const i = oldIdx.get(b._id);
      const alreadyCounted = i !== undefined && (firstOldTrip === -1 || firstOldTrip > i);
      if (alreadyCounted) continue;
      const after = (loads.kw[b._id] ?? 0) + c;
      const pct = Math.round((after / b.capacityKW) * 100);
      if (pct > 100) throw conflict('OVERLOAD', `Rejected: ${b._id} would be at ${pct}%`);
    }
  }

  const updated = await update(site.nodes, node._id, { $set: { parentId: target._id } });
  rt.nodesChanged(site.name, [updated]);
  await record(req, site, { action: 'rewire', nodeId: node._id, from: node.parentId, to: target._id, level: node.level });
  res.json({ node: updated, from: node.parentId, to: target._id });
}));

// Never rejected for overload (same reason as toggle). Atomic pipeline update, floored at 0.
api.post('/nodes/:id/load', route(async (req, res) => {
  const site = siteOf(req);
  const node = await getNode(site.nodes, req.params.id);
  if (node.type !== 'equipment') throw badRequest(`${node._id} is a board: load is set on equipment`);
  const { deltaKW } = body(req);
  if (typeof deltaKW !== 'number' || !Number.isFinite(deltaKW) || deltaKW < -50 || deltaKW > 50) {
    throw badRequest('deltaKW must be a number between -50 and 50');
  }
  const updated = await update(site.nodes, node._id, [
    { $set: { loadKW: { $max: [0, { $round: [{ $add: ['$loadKW', deltaKW] }, 2] }] } } },
  ]);
  rt.nodesChanged(site.name, [updated]);
  await record(req, site, { action: 'load', nodeId: node._id, from: node.loadKW, to: updated.loadKW, level: node.level });
  res.json({ node: updated });
}));

api.post('/boards/:id/trip', route(async (req, res) => {
  const site = siteOf(req);
  const board = await getBoard(site.nodes, req.params.id);
  const { tripped } = body(req);
  if (tripped !== undefined && typeof tripped !== 'boolean') throw badRequest('"tripped" must be true or false');
  const next = tripped ?? !board.tripped;
  const updated = await update(site.nodes, board._id, { $set: { tripped: next } });
  const affected = (await downstreamOf(site.nodes, board._id, { _id: 1 })).map((d) => d._id);
  if (site.name === 'demo') io.emit('trip', { boardId: board._id, tripped: next, affected });
  rt.nodesChanged(site.name, [updated]);
  await record(req, site, { action: next ? 'trip' : 'reset', nodeId: board._id, from: board.tripped, to: next, level: board.level });
  res.json({ boardId: board._id, tripped: next, affected });
}));

api.get('/trace/down/:id', route(async (req, res) => {
  const site = siteOf(req);
  const node = await getNode(site.nodes, req.params.id);
  const t0 = performance.now();
  const downstream = await downstreamOf(site.nodes, node._id, { _id: 1, type: 1, parentId: 1, depth: 1 });
  res.json({ id: node._id, downstream, queryMs: elapsed(t0) });
}));

api.get('/trace/up/:id', route(async (req, res) => {
  const site = siteOf(req);
  const node = await getNode(site.nodes, req.params.id);
  const t0 = performance.now();
  const path = (await upstreamOf(site.nodes, node._id)).map((b) => b._id);
  res.json({ id: node._id, path, queryMs: elapsed(t0) });
}));

// Planned-shutdown report: one $graphLookup + $facet; queryMs from explain("executionStats").
api.get('/impact/:id', route(async (req, res) => {
  const site = siteOf(req);
  const board = await getBoard(site.nodes, req.params.id);
  const isEquipment = { $eq: ['$type', 'equipment'] };
  const pipeline = [
    { $match: { _id: board._id } },
    DOWN('down', { depthField: 'depth' }),
    { $unwind: '$down' },
    { $replaceRoot: { newRoot: '$down' } },
    { $facet: {
      affected: [
        { $sort: { depth: 1, _id: 1 } },
        { $project: {
          _id: 1, type: 1, name: 1, kind: 1, parentId: 1, level: 1, depth: 1,
          critical: { $and: [isEquipment, { $eq: ['$critical', true] }] },
          loadKW: { $cond: [isEquipment, '$loadKW', 0] },
        } },
      ],
      critical: [
        { $match: { type: 'equipment', critical: true } },
        { $sort: { level: 1, _id: 1 } },
        { $project: { _id: 1, name: 1, kind: 1, parentId: 1, level: 1, loadKW: 1 } },
      ],
      stats: [
        { $group: {
          _id: null,
          total: { $sum: 1 },
          boards: { $sum: { $cond: [{ $eq: ['$type', 'board'] }, 1, 0] } },
          equipment: { $sum: { $cond: [isEquipment, 1, 0] } },
          critical: { $sum: { $cond: [{ $and: [isEquipment, { $eq: ['$critical', true] }] }, 1, 0] } },
          totalKW: { $sum: { $cond: [{ $and: [isEquipment, { $eq: ['$on', true] }] }, '$loadKW', 0] } },
        } },
      ],
    } },
  ];
  const t0 = performance.now();
  const [result] = await site.nodes.aggregate(pipeline).toArray();
  const wallMs = elapsed(t0);
  let queryMs = null;
  try {
    queryMs = explainMillis(await site.nodes.aggregate(pipeline).explain('executionStats'));
  } catch (err) {
    console.warn('[impact] explain failed:', err.message);
  }
  const stats = result?.stats?.[0] ?? { total: 0, boards: 0, equipment: 0, critical: 0, totalKW: 0 };
  res.json({
    boardId: board._id,
    site: site.name,
    counts: { total: stats.total, boards: stats.boards, equipment: stats.equipment, critical: stats.critical },
    totalKW: round2(stats.totalKW),
    critical: result?.critical ?? [],
    affected: result?.affected ?? [],
    queryMs: queryMs ?? wallMs,
  });
}));

api.post('/import', route(async (req, res) => {
  const site = siteOf(req);
  if (typeof req.body !== 'string' || !req.body.trim()) {
    throw badRequest('Send the cable schedule CSV as the raw request body with Content-Type: text/csv');
  }
  const t0 = performance.now();
  const prepared = prepare(req.body); // validates the header before anything is deleted
  const replace = req.query.replace === 'true';
  let existing = new Map();
  if (replace) {
    await site.nodes.deleteMany({});
  } else {
    const docs = await site.nodes.find({}, { projection: { type: 1, phases: 1, parentId: 1 } }).toArray();
    existing = new Map(docs.map((d) => [d._id, d]));
  }
  const { total, imported, rejected } = await importRows(site.nodes, prepared, existing);
  await record(req, site, { action: 'import', nodeId: null, from: null, to: `${imported} rows`, level: null });
  io.emit('tree:reload', { site: site.name });
  if (site.name === 'demo') rt.scheduleLoads();
  res.json({ total, imported, rejected, ms: elapsed(t0) });
}));

// Change history: one aggregation over `events` with $facet.
api.get('/history', route(async (req, res) => {
  const site = siteOf(req);
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  if (!(days > 0)) throw badRequest('days must be a positive number');
  const match = { ts: { $gte: new Date(Date.now() - days * 86_400_000) } };
  if (req.query.level !== undefined) match.level = intParam(req.query.level, 'level');
  const countBy = (field, key) => [
    { $group: { _id: field, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $project: { _id: 0, [key]: '$_id', count: 1 } },
  ];
  const [result] = await site.events.aggregate([
    { $match: match },
    { $facet: {
      byDay: [
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, day: '$_id', count: 1 } },
      ],
      byWho: countBy('$who', 'who'),
      byAction: countBy('$action', 'action'),
      recent: [{ $sort: { ts: -1, _id: -1 } }, { $limit: 50 }],
    } },
  ]).toArray();
  res.json(result);
}));

// Re-seed the demo building (between rehearsals and right before going on stage).
api.post('/reset', route(async (req, res) => {
  const site = siteOf(req);
  if (site.name !== 'demo') throw badRequest('Reset only re-seeds the demo site');
  const wasTripped = await site.nodes.aggregate([
    { $match: { type: 'board', tripped: true } },
    DOWN('down'),
    { $project: { affected: '$down._id' } },
  ]).toArray();
  const fresh = getDemoNodes();
  await site.nodes.deleteMany({});
  await site.events.deleteMany({});
  await site.nodes.insertMany(fresh);
  io.emit('tree:reload', { site: 'demo' });
  const { pct } = await boardLoads(site.nodes);
  io.emit('loads', pct);
  for (const t of wasTripped) io.emit('trip', { boardId: t._id, tripped: false, affected: t.affected });
  rt.nodesChanged('demo', fresh);
  res.json({ ok: true, nodes: fresh.length });
}));

api.use((req, res) => res.status(404).json({ error: `No route ${req.method} /api${req.path}`, code: 'NOT_FOUND' }));
app.use('/api', api);

// --- Static pages: phones at /join, the built screen at / ---
const joinDir = fileURLToPath(new URL('../../join', import.meta.url));
const screenDist = fileURLToPath(new URL('../../screen/dist', import.meta.url));
app.use('/join', express.static(joinDir));
if (fs.existsSync(screenDist)) {
  app.use(express.static(screenDist));
  app.get(/^\/(?!api|socket\.io|join).*/, (req, res) => res.sendFile(`${screenDist}/index.html`));
} else {
  app.get('/', (req, res) => res.type('text').send('PowerTrace backend: API at /api, phones at /join. Run the screen with `npm run screen`.'));
}

// Body-parser errors (bad JSON, CSV over 5 MB) and anything unexpected, in the contract's error shape.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json(status >= 500
    ? { error: 'Internal server error', code: 'INTERNAL' }
    : { error: err.message, code: 'BAD_REQUEST' });
});

// --- Socket.IO (CONTRACT.md section 3): clients only listen; a phone's claim is released on disconnect ---
io.on('connection', (socket) => {
  socket.on('disconnect', async () => {
    try {
      const nodes = getDb('demo').collection('nodes');
      if (rt.isDirect()) {
        const released = await nodes.find({ claimedBy: socket.id }).toArray();
        if (!released.length) return;
        await nodes.updateMany({ claimedBy: socket.id }, { $set: { claimedBy: null } });
        rt.nodesChanged('demo', released.map((n) => ({ ...n, claimedBy: null })));
      } else {
        await nodes.updateMany({ claimedBy: socket.id }, { $set: { claimedBy: null } }); // change stream broadcasts it
      }
    } catch (err) {
      console.error('[disconnect]', err.message);
    }
  });
});

export { app, io };

// --- Start ---
await connect();
for (const site of SITES) await ensureSchema(getDb(site));
const demoNodes = getDb('demo').collection('nodes');
if ((await demoNodes.countDocuments()) === 0) {
  await demoNodes.insertMany(getDemoNodes());
  console.log('Demo site was empty: seeded the 60-node demo building');
}
rt.start();

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use (set PORT=...)` : err);
  process.exit(1);
});
server.listen(config.port, () => {
  console.log(`PowerTrace backend on http://localhost:${config.port}  (phones: /join)`);
});
