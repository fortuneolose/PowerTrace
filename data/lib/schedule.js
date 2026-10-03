// Cable schedule CSV: row builder, a minimal CSV writer/parser, and the REFERENCE IMPORTER.
// Pure (no I/O, no Node-only imports) so /mock, /backend tests and the data scripts can all use it.
// The format and every rejection code are documented in data/README.md ("Cable schedule CSV").

import { indexNodes } from './graph.js';

export const SCHEDULE_COLUMNS = [
  'tag',
  'type',
  'kind',
  'description',
  'fed_from',
  'level',
  'voltage',
  'phases',
  'rated_kw',
  'capacity_kw',
  'critical',
  'cable_ref',
  'cable_size_mm2',
  'cable_length_m',
  'notes',
];

// Columns the importer needs; the cable_* and notes columns are informational.
export const REQUIRED_COLUMNS = ['tag', 'type', 'kind', 'description', 'fed_from', 'level', 'voltage', 'phases', 'rated_kw', 'capacity_kw', 'critical'];

// In the order CONTRACT.md lists them.
export const REJECTION_CODES = ['MISSING_RATING', 'DUPLICATE_TAG', 'INVALID_VOLTAGE', 'UNKNOWN_TYPE', 'PHASE_MISMATCH', 'CIRCULAR_FEED', 'UNKNOWN_FEEDER'];

// ---------------------------------------------------------------------------------------------
// Nodes -> schedule rows
// ---------------------------------------------------------------------------------------------

// Standard copper cable sizes (mm²) with an approximate current rating (A).
const CABLES = [
  [1.5, 20], [2.5, 27], [4, 37], [6, 47], [10, 65], [16, 87], [25, 114], [35, 141], [50, 182],
  [70, 234], [95, 284], [120, 330], [150, 381], [185, 436], [240, 515], [300, 594],
];

// Size a cable for `kw` at `phases`: design current with a 25% margin, up to 4 parallel 300s, then busbar.
export function cableSize(kw, phases, isLighting = false) {
  const amps = phases === 3 ? (kw * 1000) / (Math.sqrt(3) * 400 * 0.9) : (kw * 1000) / (230 * 0.95);
  const need = amps * 1.25;
  const min = isLighting ? 1.5 : 2.5;
  for (const [mm2, rating] of CABLES) if (mm2 >= min && rating >= need) return String(mm2);
  const runs = Math.ceil(need / 594);
  return runs <= 4 ? `${runs}x300` : 'busbar';
}

const NOTES = [
  'moved per RFI-112',
  'as-built per site instruction SI-045',
  'circuit re-terminated, see TQ-031',
  'label missing on site',
  'to be verified at commissioning',
  'rating taken from nameplate, not O&M manual',
  'spare way used',
  'tagged "temporary" on site, confirm with Northside M&E',
  'RCBO replaced 14/09',
  'IR test re-done after snag',
  'route changed to avoid MRI shielding',
  'fed via local isolator, see dwg E-501 rev C',
];

/**
 * One schedule row (all values strings) per node, parent-first, grouped by level.
 * Equipment rows carry rated_kw (capacity_kw empty), board rows capacity_kw (rated_kw empty);
 * critical is "Y"/"N" for equipment and empty for boards.
 */
export function toScheduleRows(nodes, rng) {
  const idx = indexNodes(nodes);
  const ordered = [];
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n._id)) return;
    seen.add(n._id);
    ordered.push(n);
    for (const c of idx.children.get(n._id) ?? []) visit(c);
  };
  for (const root of idx.children.get(null) ?? []) visit(root);
  for (const n of nodes) visit(n); // anything unreachable still gets a row
  // Stable sort by level keeps parents first: a parent is on the same level or on level 0.
  ordered.sort((a, b) => a.level - b.level);

  const cableSeq = new Map();
  return ordered.map((n) => {
    const isBoard = n.type === 'board';
    const parent = n.parentId ? idx.byId.get(n.parentId) : null;
    const kw = isBoard ? n.capacityKW : n.ratedKW;
    let cableRef = '';
    let size = '';
    let length = '';
    let notes = '';
    if (parent) {
      const seq = (cableSeq.get(n.level) ?? 0) + 1;
      cableSeq.set(n.level, seq);
      cableRef = `C${String(n.level).padStart(2, '0')}-${String(seq).padStart(4, '0')}`;
      size = cableSize(kw, n.phases, n.kind === 'LTG' || n.kind === 'EM');
      if (isBoard && parent.kind !== 'DB') length = String(12 + Math.round(4.2 * n.level) + rng.int(0, 18)); // riser run
      else if (isBoard) length = String(rng.int(3, 25));
      else length = String(rng.int(5, 60));
      if (rng.chance(0.035)) notes = rng.pick(NOTES);
    } else {
      notes = 'fed from TX1/TX2 via LV busbar';
    }
    return {
      tag: n._id,
      type: n.type,
      kind: n.kind,
      description: n.name,
      fed_from: n.parentId ?? '',
      level: String(n.level),
      voltage: String(n.voltage),
      phases: String(n.phases),
      rated_kw: isBoard ? '' : String(n.ratedKW),
      capacity_kw: isBoard ? String(n.capacityKW) : '',
      critical: isBoard ? '' : n.critical ? 'Y' : 'N',
      cable_ref: cableRef,
      cable_size_mm2: size,
      cable_length_m: length,
      notes,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Minimal CSV writer and parser (RFC 4180-ish)
// ---------------------------------------------------------------------------------------------

export function csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values) {
  return values.map(csvField).join(',');
}

// rows: array of objects keyed by column name.
export function toCSV(rows, columns = SCHEDULE_COLUMNS, { eol = '\r\n' } = {}) {
  return [csvLine(columns), ...rows.map((r) => csvLine(columns.map((c) => r[c])))].join(eol) + eol;
}

/**
 * Parse CSV text into records: [{ line, fields }], `line` being the 1-based file line the record
 * starts on. Handles quoted fields ("" escapes, embedded commas and line breaks, kept as \n), CRLF/LF/CR line
 * endings and a UTF-8 BOM. Blank lines (and lines of only commas/whitespace) are skipped.
 */
export function parseCSV(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];
  let fields = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;

  const endRecord = () => {
    fields.push(field);
    if (fields.some((f) => f.trim() !== '')) records.push({ line: startLine, fields });
    fields = [];
    field = '';
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else if (c === '\r' || c === '\n') {
        // Line break inside a quoted field: keep it as "\n" and keep counting file lines.
        if (c === '\r' && src[i + 1] === '\n') i++;
        field += '\n';
        line++;
      } else {
        field += c;
      }
    } else if (c === '"' && field.trim() === '') {
      field = '';
      inQuotes = true;
    } else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else {
      field += c;
    }
  }
  if (field !== '' || fields.length) endRecord();
  return records;
}

// ---------------------------------------------------------------------------------------------
// Reference importer
// ---------------------------------------------------------------------------------------------

const TRUTHY = new Set(['y', 'yes', 'true', '1']);

const reject = (row, tag, code, reason) => ({ row, tag, code, reason });

/**
 * Validate a cable schedule and turn its good rows into CONTRACT.md node documents.
 *
 * @param {string} csvText  the raw CSV (header on its first non-blank line)
 * @param {{ existingIds?: Set<string>|string[], existingNodes?: object[] }} [opts]  what is already in the
 *        database (feeders may point at it; rows repeating a tag are DUPLICATE_TAG). Pass `existingNodes`
 *        (the node docs) rather than just `existingIds` so phase checks also cover existing feeder boards.
 *        Pass nothing for replace=true.
 * @returns {{ total: number, valid: object[], rejected: {row:number, tag:string, code:string, reason:string}[] }}
 *   total = data rows read (blank lines excluded); valid = node docs in file order;
 *   rejected sorted by row (the file line number, header = line 1).
 * @throws Error if a required column is missing from the header.
 */
export function parseSchedule(csvText, { existingIds = new Set(), existingNodes = [] } = {}) {
  // tag -> existing node doc (or null when only the id is known)
  const existing = new Map(existingIds instanceof Map ? existingIds : [...(existingIds ?? [])].map((id) => [id, null]));
  for (const n of existingNodes) existing.set(n._id, n);
  const records = parseCSV(csvText ?? '');
  if (!records.length) return { total: 0, valid: [], rejected: [] };

  const header = records[0].fields.map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`cable schedule is missing column(s): ${missing.join(', ')}`);
  const col = Object.fromEntries(header.map((h, i) => [h, i]).reverse()); // first occurrence wins

  const rejected = [];
  const candidates = new Map(); // tag -> parsed row that passed the per-row checks
  const failedTags = new Set(); // tags whose rows failed a per-row check (for better feeder reasons)
  const rows = records.slice(1);

  // Pass 1: per-row checks, in the order the database would apply them
  // (shape/validator first, then the unique tag).
  for (const { line, fields } of rows) {
    const get = (name) => (fields[col[name]] ?? '').trim();
    const tag = get('tag');
    const typeRaw = get('type');
    const type = typeRaw.toLowerCase();
    const levelRaw = get('level');
    const voltageRaw = get('voltage');
    const phasesRaw = get('phases');
    const fail = (code, reason) => {
      rejected.push(reject(line, tag, code, reason));
      if (tag) failedTags.add(tag);
    };

    if (!tag) {
      fail('INVALID_ROW', 'missing tag');
      continue;
    }
    if (type !== 'board' && type !== 'equipment') {
      fail('UNKNOWN_TYPE', `unknown type "${typeRaw}" (must be board or equipment)`);
      continue;
    }
    if (!/^\d+$/.test(levelRaw)) {
      fail('INVALID_ROW', `invalid level "${levelRaw}"`);
      continue;
    }
    const voltage = parseFloat(voltageRaw);
    const phases = parseFloat(phasesRaw);
    if (voltage !== 230 && voltage !== 400) {
      fail('INVALID_VOLTAGE', `invalid voltage ${voltageRaw || '(blank)'} (must be 230 or 400)`);
      continue;
    }
    if (phases !== 1 && phases !== 3) {
      fail('INVALID_VOLTAGE', `invalid phases ${phasesRaw || '(blank)'} (must be 1 or 3)`);
      continue;
    }
    if ((voltage === 400) !== (phases === 3)) {
      fail('INVALID_VOLTAGE', `${voltage} V does not match ${phases}-phase`);
      continue;
    }
    const ratingCol = type === 'board' ? 'capacity_kw' : 'rated_kw';
    const ratingRaw = get(ratingCol);
    const rating = parseFloat(ratingRaw);
    if (!ratingRaw) {
      fail('MISSING_RATING', `missing ${ratingCol}`);
      continue;
    }
    if (!(rating > 0)) {
      fail('MISSING_RATING', `invalid ${ratingCol} "${ratingRaw}" (must be a number > 0)`);
      continue;
    }
    if (candidates.has(tag) || existing.has(tag)) {
      rejected.push(reject(line, tag, 'DUPLICATE_TAG', `duplicate tag ${tag}`));
      continue;
    }

    candidates.set(tag, {
      line,
      tag,
      type,
      kind: get('kind').toUpperCase(),
      name: get('description') || tag,
      fedFrom: get('fed_from'),
      level: parseInt(levelRaw, 10),
      voltage,
      phases,
      rating,
      critical: TRUTHY.has(get('critical').toLowerCase()),
    });
  }

  // Pass 2: the graph. Rows are not guaranteed parent-first, so resolve after reading everything.
  // 2a. Feed loops among candidate rows: every row in the loop is CIRCULAR_FEED.
  const loopOf = new Map();
  const done = new Set();
  for (const tag of candidates.keys()) {
    if (done.has(tag)) continue;
    const path = [];
    const onPath = new Map();
    let cur = tag;
    while (candidates.has(cur) && !done.has(cur) && !onPath.has(cur)) {
      onPath.set(cur, path.length);
      path.push(cur);
      cur = candidates.get(cur).fedFrom;
    }
    if (onPath.has(cur)) {
      const loop = path.slice(onPath.get(cur));
      loop.forEach((m, i) => loopOf.set(m, [...loop.slice(i), ...loop.slice(0, i), m]));
    }
    for (const p of path) done.add(p);
  }

  // 2b. Feeder checks, memoised walking up the (now loop-free) feed chain.
  const verdict = new Map(); // tag -> null (ok) or { code, reason }
  const resolve = (tag) => {
    if (verdict.has(tag)) return verdict.get(tag);
    const r = candidates.get(tag);
    let v = null;
    if (loopOf.has(tag)) {
      v = { code: 'CIRCULAR_FEED', reason: `feed loops back on itself (${loopOf.get(tag).join(' -> ')})` };
    } else if (!r.fedFrom) {
      if (!(r.type === 'board' && r.kind === 'MSB')) v = { code: 'UNKNOWN_FEEDER', reason: 'missing fed_from (only the MSB has no feeder)' };
    } else if (candidates.has(r.fedFrom)) {
      const p = candidates.get(r.fedFrom);
      if (p.type !== 'board') v = { code: 'UNKNOWN_FEEDER', reason: `feeder ${p.tag} is not a board` };
      else if (resolve(p.tag)) v = { code: 'UNKNOWN_FEEDER', reason: `feeder ${p.tag} was rejected` };
      else if (r.phases === 3 && p.phases === 1) v = { code: 'PHASE_MISMATCH', reason: `${p.tag} is single-phase` };
    } else if (existing.has(r.fedFrom)) {
      // Feeder already in the database: check it when we have its document.
      const p = existing.get(r.fedFrom);
      if (p && p.type !== 'board') v = { code: 'UNKNOWN_FEEDER', reason: `feeder ${p._id} is not a board` };
      else if (p && r.phases === 3 && p.phases === 1) v = { code: 'PHASE_MISMATCH', reason: `${p._id} is single-phase` };
    } else if (failedTags.has(r.fedFrom)) {
      v = { code: 'UNKNOWN_FEEDER', reason: `feeder ${r.fedFrom} was rejected` };
    } else {
      v = { code: 'UNKNOWN_FEEDER', reason: `unknown feeder ${r.fedFrom}` };
    }
    verdict.set(tag, v);
    return v;
  };

  const valid = [];
  for (const r of candidates.values()) {
    const v = resolve(r.tag);
    if (v) {
      rejected.push(reject(r.line, r.tag, v.code, v.reason));
      continue;
    }
    const base = { _id: r.tag, type: r.type, kind: r.kind, name: r.name, parentId: r.fedFrom || null, level: r.level, voltage: r.voltage, phases: r.phases };
    valid.push(
      r.type === 'board'
        ? { ...base, capacityKW: r.rating, tripped: false }
        : { ...base, ratedKW: r.rating, loadKW: r.rating, on: true, critical: r.critical, claimedBy: null },
    );
  }

  rejected.sort((a, b) => a.row - b.row);
  return { total: rows.length, valid, rejected };
}

// { MISSING_RATING: n, ... } in contract order, then anything else.
export function countByCode(rejected) {
  const out = {};
  for (const code of REJECTION_CODES) out[code] = 0;
  for (const r of rejected) out[r.code] = (out[r.code] ?? 0) + 1;
  return out;
}
