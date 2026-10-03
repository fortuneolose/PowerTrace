// Unit tests for the CSV importer with a stand-in collection that behaves like MongoDB's
// $jsonSchema validator (error 121) and unique _id index (error 11000) under insertMany({ ordered: false }).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, importRows, parseCsv, CsvError } from '../src/importer.js';

function fakeNodes() {
  const store = new Map();
  const valid = (d) => typeof d._id === 'string' && d._id && ['board', 'equipment'].includes(d.type)
    && [230, 400].includes(d.voltage) && [1, 3].includes(d.phases) && Number.isInteger(d.level)
    && (d.type === 'board' ? d.capacityKW > 0 : d.ratedKW > 0);
  return {
    store,
    async insertMany(docs) {
      const writeErrors = [];
      let n = 0;
      docs.forEach((d, index) => {
        if (store.has(d._id)) writeErrors.push({ index, code: 11000 });
        else if (!valid(d)) writeErrors.push({ index, code: 121 });
        else { store.set(d._id, d); n++; }
      });
      if (writeErrors.length) throw Object.assign(new Error('bulk write error'), { writeErrors, result: { insertedCount: n } });
      return { insertedCount: n };
    },
  };
}

const CSV = `tag,type,name,fed_from,level,voltage,phases,rated_kw,capacity_kw,critical
MSB,board,Main,,0,400,3,,500,
DB-1,board,"Board, one",MSB,1,400,3,,60,
DB-2,board,Lighting,MSB,1,230,1,,20,
AHU-1,equipment,AHU,DB-1,1,400,3,11,,
LTG-1,equipment,Light,DB-2,1,230,1,,,
AHU-2,equipment,AHU,DB-2,1,400,3,7,,
AHU-1,equipment,Dup,DB-1,1,400,3,5,,
X-1,equipment,Bad volts,DB-1,1,240,1,2,,
Y-1,thing,Unknown,DB-1,1,230,1,2,,
Z-1,equipment,Orphan,DB-NOPE,1,230,1,2,,
DB-A,board,Loop A,DB-B,2,400,3,,50,
DB-B,board,Loop B,DB-A,2,400,3,,50,
EM-1,equipment,Emergency,DB-2,1,230,1,0.4,,yes
`;

test('imports valid rows and rejects each bad row with the contract code', async () => {
  const nodes = fakeNodes();
  const out = await importRows(nodes, prepare(CSV));
  assert.equal(out.total, 13);
  assert.equal(out.imported, 5);
  assert.deepEqual(out.rejected.map((r) => [r.row, r.tag, r.code]), [
    [6, 'LTG-1', 'MISSING_RATING'],
    [7, 'AHU-2', 'PHASE_MISMATCH'],
    [8, 'AHU-1', 'DUPLICATE_TAG'],
    [9, 'X-1', 'INVALID_VOLTAGE'],
    [10, 'Y-1', 'UNKNOWN_TYPE'],
    [11, 'Z-1', 'UNKNOWN_FEEDER'],
    [12, 'DB-A', 'CIRCULAR_FEED'],
    [13, 'DB-B', 'CIRCULAR_FEED'],
  ]);
  assert.equal(out.rejected[6].reason, 'feed loops back on itself (DB-A -> DB-B -> DB-A)');
  assert.equal(nodes.store.get('EM-1').critical, true);
  assert.equal(nodes.store.get('DB-1').name, 'Board, one');
  assert.equal(nodes.store.get('AHU-1').loadKW, 11);
});

test('a CSV missing required columns is rejected before anything is written', () => {
  assert.throws(() => prepare('tag,type\nX,board\n'), CsvError);
});

test('rows already in the database count as feeders and as duplicates', async () => {
  const nodes = fakeNodes();
  nodes.store.set('DB-9', { _id: 'DB-9' });
  const existing = new Map([['DB-9', { type: 'board', phases: 1, parentId: null }]]);
  const out = await importRows(nodes, prepare('tag,type,fed_from,voltage,phases,rated_kw\nLTG-9,equipment,DB-9,230,1,1\nAHU-9,equipment,DB-9,400,3,5\n'), existing);
  assert.equal(out.imported, 1);
  assert.deepEqual(out.rejected.map((r) => r.code), ['PHASE_MISMATCH']);
});

test('parseCsv handles quoted newlines and CRLF, and keeps file line numbers', () => {
  const rows = parseCsv('a,"b\nc",d\r\n1,2,3');
  assert.deepEqual(rows, [{ line: 1, cells: ['a', 'b\nc', 'd'] }, { line: 3, cells: ['1', '2', '3'] }]);
});

test('reproduces data/messy-schedule.expected.json', async () => {
  const fs = await import('node:fs');
  const csv = fs.readFileSync(new URL('../../data/messy-schedule.csv', import.meta.url), 'utf8');
  const expected = JSON.parse(fs.readFileSync(new URL('../../data/messy-schedule.expected.json', import.meta.url), 'utf8'));
  const out = await importRows(fakeNodes(), prepare(csv));
  assert.equal(out.total, expected.total);
  assert.equal(out.imported, expected.imported);
  assert.deepEqual(out.rejected, expected.rejected.map(({ row, tag, code, reason }) => ({ row, tag, code, reason })));
});
