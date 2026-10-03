// Invariants for the hospital dataset and the messy cable schedule. Run: npm test (in /data)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateHospital } from '../lib/hospital.js';
import { parseSchedule } from '../lib/schedule.js';
import { indexNodes, downstream, upstream, boardLoadPercents } from '../lib/graph.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const { nodes, events } = generateHospital({ now: NOW });
const idx = indexNodes(nodes);
const boards = nodes.filter((n) => n.type === 'board');
const equipment = nodes.filter((n) => n.type === 'equipment');

const csv = fs.readFileSync(new URL('../messy-schedule.csv', import.meta.url), 'utf8');
const expected = JSON.parse(fs.readFileSync(new URL('../messy-schedule.expected.json', import.meta.url), 'utf8'));

test('size: ~300 boards, ~4,000 equipment, ~5% critical, unique tags', () => {
  assert.equal(boards.length, 289);
  assert.equal(equipment.length, 3968);
  assert.equal(idx.byId.size, nodes.length);
  const critical = equipment.filter((n) => n.critical).length / equipment.length;
  assert.ok(critical > 0.04 && critical < 0.06, `critical share ${critical}`);
});

test('every node matches the CONTRACT.md shape', () => {
  for (const n of nodes) {
    assert.ok(['board', 'equipment'].includes(n.type), n._id);
    assert.equal(typeof n.kind, 'string');
    assert.equal(typeof n.name, 'string');
    assert.ok(Number.isInteger(n.level) && n.level >= 0 && n.level <= 12, n._id);
    assert.equal(n.voltage, n.phases === 3 ? 400 : 230, `${n._id} voltage/phases`);
    if (n.type === 'board') {
      assert.ok(n.capacityKW > 0, n._id);
      assert.equal(n.tripped, false);
    } else {
      assert.ok(n.ratedKW > 0, n._id);
      assert.equal(n.loadKW, n.ratedKW);
      assert.equal(n.on, true);
      assert.equal(typeof n.critical, 'boolean');
      assert.equal(n.claimedBy, null);
    }
  }
});

test('graph: single MSB root, parents are boards, phases compatible, everything reaches MSB', () => {
  assert.deepEqual(nodes.filter((n) => n.parentId === null).map((n) => n._id), ['MSB']);
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const p = idx.byId.get(n.parentId);
    assert.ok(p && p.type === 'board', `${n._id}: bad parent ${n.parentId}`);
    assert.ok(!(p.phases === 1 && n.phases === 3), `${n._id}: 3-phase on single-phase ${p._id}`);
    assert.equal(upstream(nodes, n._id, idx).at(-1), 'MSB', `${n._id} does not reach MSB`);
  }
});

test('loads: exactly 3 overloaded leaf boards, none under DB-L5-02, nothing upstream over 100%', () => {
  const pct = boardLoadPercents(nodes, idx);
  const over = Object.keys(pct).filter((id) => pct[id] > 100).sort();
  assert.deepEqual(over, ['DB-L11-04C', 'DB-L2-02A', 'DB-L3-03C']);
  for (const id of over) {
    assert.equal((idx.children.get(id) ?? []).filter((c) => c.type === 'board').length, 0, `${id} is not a leaf`);
    assert.ok(!upstream(nodes, id, idx).includes('DB-L5-02'));
  }
});

test('shutdown demo: isolating DB-L5-02 affects 70 nodes with theatre lights and emergency lighting flagged', () => {
  const affected = downstream(nodes, 'DB-L5-02', idx).map((d) => d.node);
  assert.equal(affected.length, 70);
  assert.equal(affected.filter((n) => n.type === 'board').length, 4);
  const critical = affected.filter((n) => n.critical).map((n) => n._id);
  assert.equal(critical.length, 15);
  for (const id of ['THL-L5-001', 'THL-L5-002', 'THL-L5-003', 'THL-L5-004', 'EM-L5-002', 'EM-L5-003']) {
    assert.ok(critical.includes(id), `${id} should be flagged`);
  }
  assert.equal(idx.byId.get('THL-L5-003').parentId, 'DB-L5-02C');
});

test('events: a week of history before now, referencing real nodes on the right level, Level 5 busiest', () => {
  assert.ok(events.length > 1000 && events.length < 1600, `${events.length} events`);
  const weekAgo = NOW - 7 * 24 * 3600 * 1000;
  const perLevel = {};
  for (const e of events) {
    const ts = new Date(e.ts).getTime();
    assert.ok(ts >= weekAgo && ts <= NOW, `event outside the week: ${e.ts}`);
    const n = idx.byId.get(e.nodeId);
    assert.ok(n, `unknown node ${e.nodeId}`);
    assert.equal(e.level, n.level);
    assert.ok(['rewire', 'toggle', 'load', 'trip', 'reset'].includes(e.action), e.action);
    perLevel[e.level] = (perLevel[e.level] ?? 0) + 1;
  }
  const busiest = Object.entries(perLevel).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(busiest, '5');
});

test('deterministic: same seed and now give identical output', () => {
  assert.deepEqual(generateHospital({ now: NOW }), generateHospital({ now: NOW }));
});

test('messy CSV import matches messy-schedule.expected.json exactly', () => {
  const { total, valid, rejected } = parseSchedule(csv);
  assert.equal(total, expected.total);
  assert.equal(valid.length, expected.imported);
  assert.deepEqual(
    rejected.map(({ row, tag, code }) => ({ row, tag, code })),
    expected.rejected.map(({ row, tag, code }) => ({ row, tag, code })),
  );
  assert.deepEqual(expected.byCode, {
    MISSING_RATING: 6, DUPLICATE_TAG: 5, INVALID_VOLTAGE: 3, UNKNOWN_TYPE: 2,
    PHASE_MISMATCH: 3, CIRCULAR_FEED: 3, UNKNOWN_FEEDER: 2,
  });
});

test('messy CSV round trip: imported rows are the seeded hospital minus the 12 broken rows', () => {
  const { valid } = parseSchedule(csv);
  assert.equal(valid.length, nodes.length - 12);
  for (const v of valid) assert.deepEqual(v, idx.byId.get(v._id), `${v._id} differs from the seed`);
  const imported = new Set(valid.map((v) => v._id));
  assert.ok(imported.has('DB-L5-02') && imported.has('THL-L5-003'), 'shutdown demo survives the import');
});

test('parseSchedule rejects a file with missing columns instead of guessing', () => {
  assert.throws(() => parseSchedule('tag,type\nX,board\n'), /missing column/);
});
