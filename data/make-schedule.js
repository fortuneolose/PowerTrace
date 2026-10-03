// Build data/messy-schedule.csv (the hospital as a messy cable schedule) and
// data/messy-schedule.expected.json (what a correct importer must return for it).
// Usage: npm run schedule (from the repo root). Deterministic: same seed, byte-identical output.
//
// The CSV is the seeded hospital (same seed) plus 24 deliberately bad rows and some benign mess:
//   broken equipment rows (12): 6 MISSING_RATING, 3 INVALID_VOLTAGE, 3 PHASE_MISMATCH
//   extra rows (12):            5 DUPLICATE_TAG, 2 UNKNOWN_TYPE, 2 UNKNOWN_FEEDER, 3 CIRCULAR_FEED
// so importing it with replace=true reproduces the seeded hospital minus the 12 broken equipment rows.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { generateHospital, SHUTDOWN_DEMO_BOARD } from './lib/hospital.js';
import { createRng, DEFAULT_SEED } from './lib/rng.js';
import { indexNodes, downstream } from './lib/graph.js';
import { SCHEDULE_COLUMNS, toScheduleRows, csvLine, parseSchedule, countByCode } from './lib/schedule.js';

const CSV_PATH = fileURLToPath(new URL('./messy-schedule.csv', import.meta.url));
const EXPECTED_PATH = fileURLToPath(new URL('./messy-schedule.expected.json', import.meta.url));

const seed = DEFAULT_SEED;
// `now` only shapes the change history, which the schedule doesn't use.
const { nodes, overloaded } = generateHospital({ seed, now: Date.UTC(2026, 9, 3) });
const idx = indexNodes(nodes);
const rng = createRng((seed + 1) >>> 0);
const rows = toScheduleRows(nodes, rng);
const rowOf = new Map(rows.map((r) => [r.tag, r]));

// ---------------------------------------------------------------------------------------------
// 1. Break 12 existing equipment rows (equipment has no children, so nothing cascades).
//    Never break critical items or anything under DB-L5-02 / the overloaded boards, so the demo
//    numbers survive an import of this file.
// ---------------------------------------------------------------------------------------------
const keep = new Set();
for (const id of [SHUTDOWN_DEMO_BOARD, ...overloaded]) for (const { node } of downstream(nodes, id, idx)) keep.add(node._id);
const touched = new Set(); // tags used by any injected row (broken or duplicated)
const usable = (n) => n && n.type === 'equipment' && !n.critical && !keep.has(n._id) && !touched.has(n._id);

function takeEquipment(preferred, filter = () => true) {
  let n = idx.byId.get(preferred);
  if (!usable(n) || !filter(n)) n = rng.pick(nodes.filter((x) => usable(x) && filter(x)));
  touched.add(n._id);
  return n;
}

const injected = []; // { row, code } in the order created
const broken = new Set(); // node ids whose rows are broken

const brokenLevels = rng.sample([2, 3, 4, 6, 7, 8, 9, 10, 11, 12], 5);
const missingRating = [
  takeEquipment('LTG-L1-007'),
  ...brokenLevels.map((level) => takeEquipment(null, (n) => n.level === level && ['LTG', 'SP', 'FCU', 'BHP', 'HW'].includes(n.kind))),
];
for (const n of missingRating) {
  rowOf.get(n._id).rated_kw = '';
  injected.push({ row: rowOf.get(n._id), code: 'MISSING_RATING' });
  broken.add(n._id);
}

const badVoltage = [
  [takeEquipment(null, (n) => n.phases === 3 && n.level === 9), '415'],
  [takeEquipment(null, (n) => n.phases === 1 && n.level === 3 && n.kind === 'SP'), '240'],
  [takeEquipment(null, (n) => n.phases === 1 && n.level === 12 && n.kind === 'SP'), '110'],
];
for (const [n, voltage] of badVoltage) {
  rowOf.get(n._id).voltage = voltage;
  injected.push({ row: rowOf.get(n._id), code: 'INVALID_VOLTAGE' });
  broken.add(n._id);
}

const singlePhaseSubs = (level) => nodes.filter((b) => b.type === 'board' && b.level === level && b.phases === 1);
const phaseMismatch = [
  [takeEquipment('AHU-L5-002', (n) => n.phases === 3), 'DB-L5-02A'],
  ...[6, 11].map((level) => {
    const n = takeEquipment(null, (x) => x.phases === 3 && x.level === level && idx.byId.get(x.parentId).parentId?.startsWith('DB-'));
    return [n, rng.pick(singlePhaseSubs(level).filter((b) => !keep.has(b._id)))._id];
  }),
];
for (const [n, feeder] of phaseMismatch) {
  assert.equal(idx.byId.get(feeder).phases, 1, `${feeder} should be single-phase`);
  rowOf.get(n._id).fed_from = feeder;
  injected.push({ row: rowOf.get(n._id), code: 'PHASE_MISMATCH' });
  broken.add(n._id);
}

// ---------------------------------------------------------------------------------------------
// 2. Benign mess on the untouched rows: must NOT cause any rejection.
// ---------------------------------------------------------------------------------------------
const clean = rows.filter((r) => !touched.has(r.tag));
const mess = { whitespace: 0, typeCase: 0, critical: 0, kwSuffix: 0, blankLines: 0, reordered: 0 };

const pad = (v) => rng.pick([` ${v}`, `${v} `, `  ${v}  `, `${v}   `]);
for (const r of rng.sample(clean, 80)) {
  const col = rng.pick(['tag', 'fed_from', 'description', 'kind', 'level', 'voltage', 'phases', r.type === 'board' ? 'capacity_kw' : 'rated_kw']);
  if (!r[col]) continue;
  r[col] = pad(r[col]);
  mess.whitespace++;
}
for (const r of rng.sample(clean, 60)) {
  r.type = r.type === 'board' ? rng.pick(['BOARD', 'Board']) : rng.pick(['Equipment', 'EQUIPMENT']);
  mess.typeCase++;
}
for (const r of rng.sample(clean.filter((x) => x.critical), 160)) {
  r.critical = r.critical === 'Y' ? rng.pick(['yes', 'y', 'TRUE', 'Yes', '1']) : rng.pick(['n', '', '', 'no', 'FALSE', '0']);
  mess.critical++;
}
for (const r of rng.sample(clean, 30)) {
  const col = r.type === 'board' ? 'capacity_kw' : 'rated_kw';
  r[col] = rng.pick([`${r[col].trim()}kW`, `${r[col].trim()} kW`, ` ${r[col].trim()} kW`, `${r[col].trim()}KW`]);
  mess.kwSuffix++;
}

// Shuffle a little within each level, so the file is not perfectly parent-first.
const ordered = [];
for (let level = 0; level <= 12; level++) {
  const block = rows.filter((r) => Number(r.level.trim()) === level);
  const swaps = Math.round(block.length * 0.08);
  for (let k = 0; k < swaps; k++) {
    const i = rng.int(0, block.length - 2);
    const j = Math.min(block.length - 1, i + rng.int(1, 8));
    [block[i], block[j]] = [block[j], block[i]];
  }
  ordered.push(...block);
}
assert.equal(ordered.length, rows.length);

// ---------------------------------------------------------------------------------------------
// 3. Extra rows, inserted at scattered positions.
// ---------------------------------------------------------------------------------------------
const nextTag = (() => {
  const max = new Map();
  for (const n of nodes) {
    const m = /^([A-Z]+)-L(\d+)-(\d+)$/.exec(n._id);
    if (m) max.set(`${m[1]}-L${m[2]}`, Math.max(max.get(`${m[1]}-L${m[2]}`) ?? 0, Number(m[3])));
  }
  return (kind, level) => {
    const key = `${kind}-L${level}`;
    const n = (max.get(key) ?? 0) + 1;
    max.set(key, n);
    return `${key}-${String(n).padStart(3, '0')}`;
  };
})();

const blankRow = () => Object.fromEntries(SCHEDULE_COLUMNS.map((c) => [c, '']));
const extra = (fields) => ({ ...blankRow(), ...fields });
const insertAt = (row, pos) => ordered.splice(pos, 0, row);
const levelRange = (level) => {
  const at = ordered.map((r, i) => [r, i]).filter(([r]) => Number(r.level.trim()) === level).map(([, i]) => i);
  return [at[0], at[at.length - 1]];
};
const insertInLevel = (row, level) => {
  const [lo, hi] = levelRange(level);
  insertAt(row, rng.int(lo + 1, hi));
};

// DUPLICATE_TAG: an existing equipment tag repeated later with a different description.
const dupSources = [takeEquipment('SP-L4-031'), ...rng.sample([1, 3, 6, 8, 10, 11], 4).map((level) => takeEquipment(null, (n) => n.level === level))];
for (const n of dupSources) {
  const orig = rowOf.get(n._id);
  const desc = n.name;
  const dup = { ...orig, type: 'equipment', tag: n._id, description: rng.pick([`${desc} - spare`, `${desc} (relocated)`, `${desc} - new circuit`, `Spare way: ${desc}`, `${desc} (per RFI-118)`]), notes: '' };
  dup.rated_kw = String(n.ratedKW);
  dup.critical = n.critical ? 'Y' : 'N';
  const origPos = ordered.indexOf(orig);
  const lo = Math.min(origPos + 40, ordered.length);
  insertAt(dup, rng.int(lo, Math.max(lo, Math.min(ordered.length, origPos + 900))));
  injected.push({ row: dup, code: 'DUPLICATE_TAG' });
}

// UNKNOWN_TYPE
const l6SinglePhase = singlePhaseSubs(6).filter((b) => !keep.has(b._id));
const unknownType = [
  extra({ tag: 'MCP-L3-001', type: 'panel', kind: 'MCP', description: 'Motor control panel: level 3 plant room', fed_from: 'DB-L3-04', level: '3', voltage: '400', phases: '3', capacity_kw: '25', cable_ref: 'C03-9001', cable_size_mm2: '16', cable_length_m: '14', notes: 'listed by BrightSpark Ltd' }),
  extra({ tag: nextTag('SP', 6), type: 'equip.', kind: 'SP', description: 'Small power: ICU seminar room', fed_from: rng.pick(l6SinglePhase)._id, level: '6', voltage: '230', phases: '1', rated_kw: '2.4', critical: 'N', cable_ref: 'C06-9001', cable_size_mm2: '2.5', cable_length_m: '22' }),
];
for (const r of unknownType) {
  insertInLevel(r, Number(r.level));
  injected.push({ row: r, code: 'UNKNOWN_TYPE' });
}

// UNKNOWN_FEEDER: fed from a board that does not exist (a typo for DB-L4-01).
const unknownFeeder = [
  extra({ tag: nextTag('LTG', 4), type: 'equipment', kind: 'LTG', description: 'Lighting: admissions lounge extension', fed_from: 'DB-L14-01', level: '4', voltage: '230', phases: '1', rated_kw: '1.2', critical: 'N', cable_ref: 'C04-9001', cable_size_mm2: '1.5', cable_length_m: '31' }),
  extra({ tag: nextTag('SP', 4), type: 'equipment', kind: 'SP', description: 'Small power: admissions lounge extension', fed_from: 'DB-L14-01', level: '4', voltage: '230', phases: '1', rated_kw: '2.5', critical: 'N', cable_ref: 'C04-9002', cable_size_mm2: '2.5', cable_length_m: '33', notes: 'per old drawing E-204 rev A' }),
];
for (const r of unknownFeeder) {
  insertInLevel(r, 4);
  injected.push({ row: r, code: 'UNKNOWN_FEEDER' });
}

// CIRCULAR_FEED: temporary boards with no children that feed each other / themselves.
const circular = [
  extra({ tag: 'DB-L7-X1', type: 'board', kind: 'DB', description: 'Level 7 temporary board X1 (maternity refurb)', fed_from: 'DB-L7-X2', level: '7', voltage: '400', phases: '3', capacity_kw: '40', cable_ref: 'C07-9001', cable_size_mm2: '16', cable_length_m: '18', notes: 'temporary supply for refurb works' }),
  extra({ tag: 'DB-L7-X2', type: 'board', kind: 'DB', description: 'Level 7 temporary board X2 (maternity refurb)', fed_from: 'DB-L7-X1', level: '7', voltage: '400', phases: '3', capacity_kw: '40', cable_ref: 'C07-9002', cable_size_mm2: '16', cable_length_m: '12', notes: 'temporary supply for refurb works' }),
  extra({ tag: 'DB-L9-X1', type: 'board', kind: 'DB', description: 'Level 9 temporary board X1 (ward 9B refurb)', fed_from: 'DB-L9-X1', level: '9', voltage: '400', phases: '3', capacity_kw: '30', cable_ref: 'C09-9001', cable_size_mm2: '10', cable_length_m: '9' }),
];
for (const r of circular) {
  insertInLevel(r, Number(r.level));
  injected.push({ row: r, code: 'CIRCULAR_FEED' });
}

// A few blank lines.
const BLANK = Symbol('blank');
for (let k = 0; k < 3; k++) insertAt(BLANK, rng.int(10, ordered.length - 10));

// ---------------------------------------------------------------------------------------------
// 4. Write the CSV (CRLF, like an Excel export) and remember each row's file line.
// ---------------------------------------------------------------------------------------------
const lines = [csvLine(SCHEDULE_COLUMNS)];
const lineOf = new Map();
for (const item of ordered) {
  if (item === BLANK) {
    lines.push('');
    mess.blankLines++;
    continue;
  }
  lines.push(csvLine(SCHEDULE_COLUMNS.map((c) => item[c])));
  lineOf.set(item, lines.length);
}
writeFileSync(CSV_PATH, lines.join('\r\n') + '\r\n');

// Rows that now appear before the board that feeds them.
const firstLine = new Map();
for (const item of ordered) if (item !== BLANK && !firstLine.has(item.tag.trim())) firstLine.set(item.tag.trim(), lineOf.get(item));
for (const item of ordered) {
  if (item === BLANK) continue;
  const parentLine = firstLine.get(item.fed_from.trim());
  if (parentLine && parentLine > lineOf.get(item)) mess.reordered++;
}

// ---------------------------------------------------------------------------------------------
// 5. Run the reference importer on the written file and check it against what we injected.
// ---------------------------------------------------------------------------------------------
const result = parseSchedule(readFileSync(CSV_PATH, 'utf8'));
const extrasCount = injected.filter((x) => !broken.has(x.row.tag)).length;

assert.equal(injected.length, 24, 'expected 24 injected bad rows');
assert.equal(result.total, nodes.length + extrasCount, 'total = hospital rows + extra rows');
assert.equal(result.valid.length, nodes.length - broken.size, 'imported = hospital nodes - broken equipment rows');

const expectedRejections = injected.map(({ row, code }) => ({ row: lineOf.get(row), tag: row.tag, code })).sort((a, b) => a.row - b.row);
assert.deepEqual(
  result.rejected.map(({ row, tag, code }) => ({ row, tag, code })),
  expectedRejections,
  'every injected bad row is rejected with its intended code, and nothing else is rejected',
);

// The imported nodes are exactly the seeded hospital minus the broken rows.
const byId = (a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
assert.deepEqual([...result.valid].sort(byId), nodes.filter((n) => !broken.has(n._id)).sort(byId), 'import reproduces the seeded hospital');
assert.ok(mess.reordered > 0, 'some rows should come before their feeder');

const expected = {
  total: result.total,
  imported: result.valid.length,
  rejectedCount: result.rejected.length,
  byCode: countByCode(result.rejected),
  rejected: result.rejected,
};
writeFileSync(EXPECTED_PATH, JSON.stringify(expected, null, 2) + '\n');

// ---------------------------------------------------------------------------------------------
console.log(`Wrote ${CSV_PATH}`);
console.log(`  ${lines.length} lines: header + ${result.total} data rows + ${mess.blankLines} blank lines (CRLF)`);
console.log(`  benign mess: ${mess.whitespace} padded cells, ${mess.typeCase} odd-case types, ${mess.critical} critical variants, ${mess.kwSuffix} "kW" ratings, ${mess.reordered} rows before their feeder`);
console.log(`Wrote ${EXPECTED_PATH}`);
console.log(`  total ${expected.total}, imported ${expected.imported} (hospital ${nodes.length} - ${broken.size} broken), rejected ${expected.rejectedCount}`);
console.log('  by code:', expected.byCode);
for (const r of expected.rejected) console.log(`  row ${String(r.row).padStart(4)}  ${r.tag.padEnd(12)} ${r.code.padEnd(15)} ${r.reason}`);
console.log('All checks passed: importing this file with replace=true reproduces the seeded hospital minus the broken rows.');
