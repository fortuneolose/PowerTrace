// Layout for the demo building. dagre places the boards top-down; each board's equipment is
// stacked in a column underneath it, like the ways on a panel schedule, so 50+ items fit on a
// projector without shrinking the text to nothing.
import dagre from '@dagrejs/dagre';

export const BOARD_W = 184;
export const BOARD_H = 84;
export const EQ_W = 168;
export const EQ_H = 32;
export const EQ_GAP = 6;
export const BUS_INSET = 18; // room on the left of a column for the bus bar
export const BUS_DROP = 22;  // how far below a board the horizontal bus runs
const RANK_GAP = 64;
const COLUMN_TOP = BUS_DROP + 20;

const byTag = (a, b) => a._id.localeCompare(b._id, undefined, { numeric: true });

// Returns { [id]: { x, y } } top-left positions for React Flow.
export function layout(nodes) {
  const boards = nodes.filter((n) => n.type === 'board').sort(byTag);
  const boardIds = new Set(boards.map((b) => b._id));
  const items = new Map();
  for (const n of nodes) {
    if (n.type !== 'equipment' || !boardIds.has(n.parentId)) continue;
    if (!items.has(n.parentId)) items.set(n.parentId, []);
    items.get(n.parentId).push(n);
  }
  for (const list of items.values()) list.sort(byTag);

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: RANK_GAP });
  g.setDefaultEdgeLabel(() => ({}));
  for (const b of boards) g.setNode(b._id, { width: BOARD_W, height: BOARD_H });
  for (const b of boards) {
    if (b.parentId && boardIds.has(b.parentId)) g.setEdge(b.parentId, b._id);
    // A board's equipment column is a pseudo-node in the next rank, so dagre leaves room for it
    // beside any child boards.
    if (items.has(b._id)) {
      g.setNode(`col:${b._id}`, { width: EQ_W + BUS_INSET, height: EQ_H });
      g.setEdge(b._id, `col:${b._id}`);
    }
  }
  dagre.layout(g);

  // dagre's x, our own y: boards by depth, columns hanging from their board.
  const depth = (b) => {
    let d = 0;
    for (let cur = b; cur.parentId && boardIds.has(cur.parentId) && d < 50; d++) {
      cur = boards.find((x) => x._id === cur.parentId);
    }
    return d;
  };
  const pos = {};
  for (const b of boards) {
    pos[b._id] = { x: g.node(b._id).x - BOARD_W / 2, y: depth(b) * (BOARD_H + RANK_GAP) };
  }
  for (const [boardId, list] of items) {
    const col = g.node(`col:${boardId}`);
    const left = col.x - (EQ_W + BUS_INSET) / 2 + BUS_INSET;
    const top = pos[boardId].y + BOARD_H + COLUMN_TOP;
    list.forEach((n, i) => { pos[n._id] = { x: left, y: top + i * (EQ_H + EQ_GAP) }; });
  }
  return pos;
}

// --- Local graph helpers. The authoritative answers come from MongoDB; these only drive visuals
// (which nodes are dark, how far down the fault ripple is) between server events. ---

export function deadSet(nodes) {
  const out = new Set();
  for (const n of Object.values(nodes)) {
    for (let cur = n, guard = 0; cur && guard < 50; cur = nodes[cur.parentId], guard++) {
      if (cur.type === 'board' && cur.tripped) { out.add(n._id); break; }
    }
  }
  return out;
}

// Steps from `origin` down to `id`, or null if `id` isn't below it. origin itself is 0.
export function depthBelow(nodes, id, origin) {
  for (let cur = nodes[id], d = 0; cur && d < 50; cur = nodes[cur.parentId], d++) {
    if (cur._id === origin) return d;
  }
  return null;
}

export function feedPath(nodes, id) {
  const path = [];
  for (let cur = nodes[nodes[id]?.parentId]; cur && path.length < 50; cur = nodes[cur.parentId]) path.push(cur._id);
  return path;
}

export const loadBand = (pct) => (pct > 100 ? 'red' : pct >= 80 ? 'amber' : 'green');
