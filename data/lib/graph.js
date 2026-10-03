// In-memory graph helpers over an array of nodes. Used by the data scripts (to print loads)
// and by /mock. The real backend does this work in MongoDB with $graphLookup; that's the point.

export function indexNodes(nodes) {
  const byId = new Map();
  const children = new Map();
  for (const n of nodes) {
    byId.set(n._id, n);
    if (!children.has(n.parentId)) children.set(n.parentId, []);
    children.get(n.parentId).push(n);
  }
  return { byId, children };
}

// Everything below `id`, breadth first, with $graphLookup-style depth (0 = direct child).
export function downstream(nodes, id, idx = indexNodes(nodes)) {
  const out = [];
  const seen = new Set([id]);
  let frontier = [id];
  for (let depth = 0; frontier.length; depth++) {
    const next = [];
    for (const pid of frontier) {
      for (const child of idx.children.get(pid) ?? []) {
        if (seen.has(child._id)) continue;
        seen.add(child._id);
        out.push({ node: child, depth });
        next.push(child._id);
      }
    }
    frontier = next;
  }
  return out;
}

// Feed path from `id` up to the root, nearest first (not including `id`).
export function upstream(nodes, id, idx = indexNodes(nodes)) {
  const path = [];
  const seen = new Set([id]);
  let cur = idx.byId.get(id);
  while (cur && cur.parentId != null && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    path.push(cur.parentId);
    cur = idx.byId.get(cur.parentId);
  }
  return path;
}

// Ids of nodes that are de-energised: tripped boards and everything below them.
export function deenergised(nodes, idx = indexNodes(nodes)) {
  const dead = new Set();
  for (const n of nodes) {
    if (n.type === 'board' && n.tripped && !dead.has(n._id)) {
      dead.add(n._id);
      for (const { node } of downstream(nodes, n._id, idx)) dead.add(node._id);
    }
  }
  return dead;
}

// Live kW per board: switched-on, energised equipment downstream. Tripped boards are 0.
export function boardLoadsKW(nodes, idx = indexNodes(nodes)) {
  const dead = deenergised(nodes, idx);
  const memo = new Map();
  const load = (id) => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, 0); // guards against cycles
    let kw = 0;
    for (const c of idx.children.get(id) ?? []) {
      if (dead.has(c._id)) continue;
      if (c.type === 'equipment') kw += c.on ? c.loadKW : 0;
      else kw += load(c._id);
    }
    memo.set(id, kw);
    return kw;
  };
  const out = {};
  for (const n of nodes) {
    if (n.type === 'board') out[n._id] = dead.has(n._id) ? 0 : load(n._id);
  }
  return out;
}

// { [boardId]: percent } as sent on the `loads` socket event.
export function boardLoadPercents(nodes, idx = indexNodes(nodes)) {
  const kw = boardLoadsKW(nodes, idx);
  const out = {};
  for (const [id, v] of Object.entries(kw)) {
    out[id] = Math.round((v / idx.byId.get(id).capacityKW) * 100);
  }
  return out;
}
