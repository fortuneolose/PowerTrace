// POST /api/import: cable schedule CSV -> nodes.
// The database does most of the rejecting: insertMany({ ordered: false }) lets the $jsonSchema validator
// (error 121) and the unique _id index (error 11000) refuse bad rows while the good ones go in.
// The app adds the checks that span rows: unknown feeders, circular feeds and phase mismatches.

// Accepted header names for each field (lower-cased, spaces -> underscores).
const COLUMNS = {
  tag: ['tag', 'id', '_id', 'equipment_tag', 'ref'],
  type: ['type', 'node_type'],
  kind: ['kind', 'code', 'category'],
  name: ['name', 'description', 'desc'],
  parent: ['fed_from', 'feeder', 'parent', 'parent_id', 'parentid', 'fed_by', 'supply_from', 'source', 'from'],
  level: ['level', 'floor'],
  voltage: ['voltage', 'volts', 'voltage_v'],
  phases: ['phases', 'phase', 'ph'],
  rated: ['rated_kw', 'rating_kw', 'ratedkw', 'kw', 'rated'],
  capacity: ['capacity_kw', 'capacitykw', 'board_capacity_kw', 'capacity'],
  critical: ['critical', 'is_critical'],
  on: ['on', 'switched_on'],
};
const REQUIRED = ['tag', 'type', 'parent', 'voltage', 'phases'];

export class CsvError extends Error {}

// Small RFC 4180 parser: quoted fields, escaped quotes, CRLF. Returns [{ line, cells }].
export function parseCsv(text) {
  const rows = [];
  let cells = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    cells.push(field);
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: rowLine, cells });
    cells = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; field += ch; }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(field); field = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { endRow(); line++; rowLine = line; }
    else field += ch;
  }
  if (field !== '' || cells.length) endRow();
  return rows;
}

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
// parseFloat, so schedule values like "0.8KW" or "45 kW" read as numbers (same rule as data/lib/schedule.js).
const num = (v) => {
  if (blank(v)) return undefined;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
};
const bool = (v, fallback) => {
  if (blank(v)) return fallback;
  return ['1', 'true', 'yes', 'y', 'on', 'x'].includes(String(v).trim().toLowerCase());
};
const prefix = (tag) => String(tag).split('-')[0].toUpperCase() || 'EQ';

function headerMap(headerCells) {
  const norm = headerCells.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const map = {};
  const used = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i !== -1) { map[key] = i; used[key] = headerCells[i].trim(); }
  }
  const missing = REQUIRED.filter((k) => map[k] === undefined);
  if (missing.length) {
    throw new CsvError(`CSV is missing required column(s): ${missing.map((k) => COLUMNS[k][0]).join(', ')}`);
  }
  return { map, used };
}

// One CSV row -> a nodes document. Fields that are blank are left out so the validator sees them as missing.
function toDoc(cells, map) {
  const get = (key) => (map[key] === undefined ? undefined : cells[map[key]]);
  const tag = (get('tag') ?? '').trim();
  const type = (get('type') ?? '').trim().toLowerCase();
  const parentRaw = (get('parent') ?? '').trim();
  const doc = {
    _id: tag,
    type,
    kind: (get('kind') ?? '').trim() || (type === 'board' && !parentRaw ? 'MSB' : prefix(tag)),
    name: (get('name') ?? '').trim() || tag,
    parentId: parentRaw || null,
    level: num(get('level')) ?? 0,
  };
  const voltage = num(get('voltage'));
  const phases = num(get('phases'));
  if (voltage !== undefined) doc.voltage = voltage;
  if (phases !== undefined) doc.phases = phases;
  if (type === 'board') {
    const capacity = num(get('capacity')) ?? num(get('rated'));
    if (capacity !== undefined) doc.capacityKW = capacity;
    doc.tripped = false;
  } else if (type === 'equipment') {
    const rated = num(get('rated'));
    if (rated !== undefined) { doc.ratedKW = rated; doc.loadKW = rated; }
    doc.on = bool(get('on'), true);
    doc.critical = bool(get('critical'), false);
    doc.claimedBy = null;
  }
  const ratingRaw = type === 'board' ? (get('capacity') ?? get('rated')) : get('rated');
  return { doc, raw: { type: (get('type') ?? '').trim(), voltage: get('voltage'), phases: get('phases'), rating: ratingRaw } };
}

// Why did the $jsonSchema validator refuse this document? (error 121 says only "Document failed validation".)
function classify(doc, raw, used) {
  if (!doc._id) return ['SCHEMA_VALIDATION', 'missing tag'];
  const shown = (v) => (blank(v) ? '(blank)' : String(v).trim());
  if (!['board', 'equipment'].includes(doc.type)) return ['UNKNOWN_TYPE', `unknown type "${raw.type}" (must be board or equipment)`];
  if (![230, 400].includes(doc.voltage)) return ['INVALID_VOLTAGE', `invalid voltage ${shown(raw.voltage)} (must be 230 or 400)`];
  if (![1, 3].includes(doc.phases)) return ['INVALID_VOLTAGE', `invalid phases ${shown(raw.phases)} (must be 1 or 3)`];
  const rating = doc.type === 'board' ? doc.capacityKW : doc.ratedKW;
  if (!(rating > 0)) {
    const col = doc.type === 'board' ? (used.capacity ?? 'capacity_kw') : (used.rated ?? 'rated_kw');
    return ['MISSING_RATING', blank(raw.rating) ? `missing ${col}` : `invalid ${col} "${String(raw.rating).trim()}" (must be a number > 0)`];
  }
  if (!Number.isInteger(doc.level) || doc.level < 0) return ['SCHEMA_VALIDATION', `invalid level ${doc.level}`];
  return ['SCHEMA_VALIDATION', 'rejected by the schema validator'];
}

// Parse + validate the header only. Throws CsvError (400) before anything touches the database.
export function prepare(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvError('CSV is empty');
  const { map, used } = headerMap(rows[0].cells);
  return { rows: rows.slice(1), map, used };
}

// Insert prepared rows into `nodes`. `existing` = Map(tag -> { phases, type, parentId }) already in the site.
export async function importRows(nodes, { rows, map, used }, existing = new Map()) {
  const parsed = rows.map(({ line, cells }) => ({ line, ...toDoc(cells, map) }));
  const rejected = [];
  const reject = (p, code, reason) => rejected.push({ row: p.line, tag: p.doc._id, code, reason });

  // Feeder graph: the first occurrence of each tag in the file, plus what's already in the database.
  const feeders = new Map(existing);
  for (const p of parsed) {
    if (p.doc._id && !feeders.has(p.doc._id) && ['board', 'equipment'].includes(p.doc.type)) {
      feeders.set(p.doc._id, { type: p.doc.type, phases: p.doc.phases, parentId: p.doc.parentId });
    }
  }
  const loopFrom = (tag) => {
    const path = [tag];
    const seen = new Set([tag]);
    let cur = feeders.get(tag)?.parentId;
    while (cur) {
      path.push(cur);
      if (cur === tag) return path;
      if (seen.has(cur)) return null; // a loop further up, not through this row
      seen.add(cur);
      cur = feeders.get(cur)?.parentId;
    }
    return null;
  };

  // Cross-row checks (only for rows whose own shape the validator could accept).
  const candidates = [];
  for (const p of parsed) {
    const { doc } = p;
    if (['board', 'equipment'].includes(doc.type) && doc._id) {
      const v = doc.voltage;
      const ph = doc.phases;
      if ([230, 400].includes(v) && [1, 3].includes(ph) && (v === 400) !== (ph === 3)) {
        reject(p, 'INVALID_VOLTAGE', `${v} V does not match ${ph}-phase`);
        continue;
      }
      if (doc.parentId) {
        const feeder = feeders.get(doc.parentId);
        if (!feeder) { reject(p, 'UNKNOWN_FEEDER', `unknown feeder ${doc.parentId}`); continue; }
        if (feeder.type !== 'board') { reject(p, 'UNKNOWN_FEEDER', `${doc.parentId} is not a board`); continue; }
        const loop = loopFrom(doc._id);
        if (loop) { reject(p, 'CIRCULAR_FEED', `feed loops back on itself (${loop.join(' -> ')})`); continue; }
        if (doc.phases === 3 && feeder.phases === 1) { reject(p, 'PHASE_MISMATCH', `${doc.parentId} is single-phase`); continue; }
      }
    }
    candidates.push(p);
  }

  // Let MongoDB do the rest: validator + unique _id index, unordered so good rows still land.
  let imported = 0;
  const BATCH = 1000;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    try {
      const res = await nodes.insertMany(batch.map((p) => p.doc), { ordered: false });
      imported += res.insertedCount;
    } catch (err) {
      if (!err.writeErrors && !err.result) throw err;
      const writeErrors = [].concat(err.writeErrors ?? []);
      imported += err.result?.insertedCount ?? err.insertedCount ?? (batch.length - writeErrors.length);
      for (const we of writeErrors) {
        const p = batch[we.index];
        if (we.code === 11000) reject(p, 'DUPLICATE_TAG', `duplicate tag ${p.doc._id}`);
        else if (we.code === 121) reject(p, ...classify(p.doc, p.raw, used));
        else reject(p, 'SCHEMA_VALIDATION', we.errmsg ?? `write error ${we.code}`);
      }
    }
  }

  rejected.sort((a, b) => a.row - b.row);
  return { total: parsed.length, imported, rejected };
}
