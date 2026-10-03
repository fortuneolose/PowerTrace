// Graph queries. Everything recursive runs inside MongoDB with $graphLookup over `parentId`;
// nothing here walks the tree in JavaScript.

// Everything fed from the current document (children, grandchildren, ...).
export const DOWN = (as, extra = {}) => ({
  $graphLookup: { from: 'nodes', startWith: '$_id', connectFromField: '_id', connectToField: 'parentId', as, ...extra },
});

// The feed path from the current document back to the main switchboard.
export const UP = (as, extra = {}) => ({
  $graphLookup: { from: 'nodes', startWith: '$parentId', connectFromField: 'parentId', connectToField: '_id', as, ...extra },
});

// Stop the walk at tripped boards: nothing below a tripped board draws power.
const ENERGISED_ONLY = { restrictSearchWithMatch: { tripped: { $ne: true } } };

// Sum of loadKW over switched-on equipment in an array field of looked-up nodes.
const sumOnLoad = (field) => ({
  $sum: {
    $map: {
      input: { $filter: { input: field, cond: { $and: [{ $eq: ['$$this.type', 'equipment'] }, { $eq: ['$$this.on', true] }] } } },
      in: '$$this.loadKW',
    },
  },
});

// Every node downstream of `id`, nearest first, with $graphLookup depth (0 = direct child).
export async function downstreamOf(nodes, id, project = null) {
  const pipeline = [
    { $match: { _id: id } },
    DOWN('down', { depthField: 'depth' }),
    { $unwind: '$down' },
    { $replaceRoot: { newRoot: '$down' } },
    { $sort: { depth: 1, _id: 1 } },
  ];
  if (project) pipeline.push({ $project: project });
  return nodes.aggregate(pipeline).toArray();
}

// Boards upstream of `id`, nearest first (not including `id`).
export async function upstreamOf(nodes, id) {
  return nodes.aggregate([
    { $match: { _id: id } },
    UP('up', { depthField: 'depth' }),
    { $unwind: '$up' },
    { $replaceRoot: { newRoot: '$up' } },
    { $sort: { depth: 1 } },
  ]).toArray();
}

// Ids of de-energised nodes: tripped boards and everything below them.
export async function deenergisedIds(nodes) {
  const rows = await nodes.aggregate([
    { $match: { type: 'board', tripped: true } },
    DOWN('down'),
    { $project: { ids: { $concatArrays: [['$_id'], '$down._id'] } } },
  ]).toArray();
  return new Set(rows.flatMap((r) => r.ids));
}

// A node is energised unless it, or any board upstream of it, is tripped.
export async function isEnergised(nodes, node) {
  if (node.type === 'board' && node.tripped) return false;
  const up = await upstreamOf(nodes, node._id);
  return !up.some((b) => b.tripped);
}

// Live load of every board: switched-on, energised equipment downstream.
// Returns { kw: {id: kW}, pct: {id: %}, capacity: {id: kW}, dead: Set }.
export async function boardLoads(nodes) {
  const [rows, dead] = await Promise.all([
    nodes.aggregate([
      { $match: { type: 'board' } },
      DOWN('down', ENERGISED_ONLY),
      { $project: { capacityKW: 1, loadKW: sumOnLoad('$down') } },
    ]).toArray(),
    deenergisedIds(nodes),
  ]);
  const kw = {};
  const pct = {};
  const capacity = {};
  for (const r of rows) {
    kw[r._id] = dead.has(r._id) ? 0 : r.loadKW;
    capacity[r._id] = r.capacityKW;
    pct[r._id] = Math.round((kw[r._id] / r.capacityKW) * 100);
  }
  return { kw, pct, capacity, dead };
}

// Load a node adds to whatever feeds it (equipment: its draw if on; board: its energised subtree).
export async function contributionKW(nodes, node) {
  if (node.type === 'equipment') return node.on ? node.loadKW : 0;
  if (node.tripped) return 0;
  const [row] = await nodes.aggregate([
    { $match: { _id: node._id } },
    DOWN('down', ENERGISED_ONLY),
    { $project: { loadKW: sumOnLoad('$down') } },
  ]).toArray();
  return row?.loadKW ?? 0;
}

// Longest executionTimeMillis(Estimate) anywhere in an explain() document.
export function explainMillis(explain) {
  let best = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'executionTimeMillis' || k === 'executionTimeMillisEstimate') && v != null && Number.isFinite(Number(v))) {
        best = Math.max(best ?? 0, Number(v));
      } else if (typeof v === 'object') {
        walk(v);
      }
    }
  };
  walk(explain);
  return best;
}
