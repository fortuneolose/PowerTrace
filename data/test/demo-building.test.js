// Invariants for the demo building and the in-memory graph helpers. Run: npm test (in /data)
import test from 'node:test';
import assert from 'node:assert/strict';
import { demoNodes, getDemoNodes } from '../demo-building.js';
import { downstream, upstream, deenergised, boardLoadsKW, boardLoadPercents } from '../lib/graph.js';

const byId = new Map(demoNodes.map((n) => [n._id, n]));

test('60 nodes: 9 boards, 51 equipment, unique tags', () => {
  assert.equal(demoNodes.length, 60);
  assert.equal(demoNodes.filter((n) => n.type === 'board').length, 9);
  assert.equal(new Set(demoNodes.map((n) => n._id)).size, 60);
});

test('every node matches the CONTRACT.md shape', () => {
  for (const n of demoNodes) {
    for (const f of ['_id', 'type', 'kind', 'name', 'level', 'voltage', 'phases']) assert.ok(n[f] !== undefined, `${n._id} missing ${f}`);
    assert.ok(['board', 'equipment'].includes(n.type));
    assert.ok(Number.isInteger(n.level) && n.level >= 0);
    assert.ok([230, 400].includes(n.voltage));
    assert.ok([1, 3].includes(n.phases));
    assert.equal(n.voltage, n.phases === 3 ? 400 : 230, `${n._id} voltage/phases mismatch`);
    if (n.type === 'board') {
      assert.ok(n.capacityKW > 0);
      assert.equal(n.tripped, false);
    } else {
      assert.ok(n.ratedKW > 0);
      assert.equal(n.loadKW, n.ratedKW);
      assert.equal(typeof n.on, 'boolean');
      assert.equal(typeof n.critical, 'boolean');
      assert.equal(n.claimedBy, null);
    }
  }
});

test('one root (MSB); every parent exists and is a board; no single-phase board feeds 3-phase kit', () => {
  assert.deepEqual(demoNodes.filter((n) => n.parentId === null).map((n) => n._id), ['MSB']);
  for (const n of demoNodes) {
    if (n.parentId === null) continue;
    const p = byId.get(n.parentId);
    assert.ok(p, `${n._id}: unknown parent ${n.parentId}`);
    assert.equal(p.type, 'board', `${n._id}: parent ${p._id} is not a board`);
    assert.ok(!(p.phases === 1 && n.phases === 3), `${n._id}: 3-phase on single-phase ${p._id}`);
  }
});

test('no cycles: every node reaches MSB', () => {
  for (const n of demoNodes) {
    if (n._id === 'MSB') continue;
    assert.equal(upstream(demoNodes, n._id).at(-1), 'MSB', n._id);
  }
});

test('demo beats: AHU-07, DB-L2-02 single-phase, DB-L3-01 at 67%, SMSB-B trips 28', () => {
  const ahu = byId.get('AHU-07');
  assert.equal(ahu.parentId, 'DB-L3-01');
  assert.equal(ahu.ratedKW, 15);
  assert.equal(ahu.phases, 3);
  assert.equal(byId.get('DB-L2-02').phases, 1);
  assert.deepEqual(upstream(demoNodes, 'AHU-07'), ['DB-L3-01', 'SMSB-B', 'MSB']);
  const pct = boardLoadPercents(demoNodes);
  assert.equal(pct['DB-L3-01'], 67);
  for (const v of Object.values(pct)) assert.ok(v < 80, 'every board starts green');
  assert.equal(downstream(demoNodes, 'SMSB-B').length, 28);
});

test('loads: tripping a board zeroes it and drops the boards above it', () => {
  const nodes = getDemoNodes();
  const before = boardLoadsKW(nodes);
  nodes.find((n) => n._id === 'DB-L3-01').tripped = true;
  const after = boardLoadsKW(nodes);
  assert.equal(after['DB-L3-01'], 0);
  assert.ok(Math.abs(before['SMSB-B'] - after['SMSB-B'] - before['DB-L3-01']) < 1e-9);
  assert.equal(deenergised(nodes).size, 1 + 9);
});

test('loads: switched-off equipment does not count; getDemoNodes returns copies', () => {
  const nodes = getDemoNodes();
  const before = boardLoadsKW(nodes)['DB-L3-01'];
  nodes.find((n) => n._id === 'AHU-07').on = false;
  assert.ok(Math.abs(boardLoadsKW(nodes)['DB-L3-01'] - (before - 15)) < 1e-9);
  assert.equal(byId.get('AHU-07').on, true, 'the shared demoNodes array was mutated');
});
