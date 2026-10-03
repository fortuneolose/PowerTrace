import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, fallbackCommand, toRequest, describe } from '../src/command.js';
import { demoNodes } from '../../data/demo-building.js';

const byId = new Map(demoNodes.map((n) => [n._id, n]));

test('route power away from a board trips it', () => {
  assert.deepEqual(parseCommand('Route power away from DB-L3-01', byId), { action: 'trip', target: 'DB-L3-01' });
  assert.deepEqual(parseCommand('isolate smsb-b please', byId), { action: 'trip', target: 'SMSB-B' });
});

test('restore resets a board', () => {
  assert.deepEqual(parseCommand('Restore power to DB-L3-01', byId), { action: 'reset', target: 'DB-L3-01' });
});

test('move one thing onto another board re-wires it', () => {
  assert.deepEqual(parseCommand('Move AHU-07 onto DB-L2-01', byId), { action: 'rewire', target: 'AHU-07', to: 'DB-L2-01' });
});

test('switch off equipment toggles it', () => {
  assert.deepEqual(parseCommand('Switch off EV-02', byId), { action: 'toggle', target: 'EV-02', on: false });
  assert.deepEqual(parseCommand('turn on EV-02', byId), { action: 'toggle', target: 'EV-02', on: true });
});

test('unknown tags and unclear verbs explain themselves', () => {
  assert.ok(parseCommand('trip DB-L9-99', byId).error);
  assert.ok(parseCommand('what about DB-L3-01', byId).error);
});

test('each action maps to its existing route', () => {
  assert.deepEqual(toRequest({ action: 'trip', target: 'DB-L3-01' }), { path: '/api/boards/DB-L3-01/trip', body: { tripped: true } });
  assert.equal(describe({ action: 'trip', target: 'DB-L3-01' }, 200, { affected: [1, 2, 3] }), 'Routed power away from DB-L3-01: 3 items downstream are now without power.');
  assert.equal(describe({ action: 'rewire', target: 'AHU-07', to: 'DB-L2-02' }, 409, { error: 'Rejected: DB-L2-02 is single-phase' }), 'Rejected: DB-L2-02 is single-phase');
});

test('reset on equipment restores it to normal', () => {
  assert.deepEqual(parseCommand('reset LTG-L1-02', byId), { action: 'restore', target: 'LTG-L1-02' });
  assert.deepEqual(parseCommand('reset ltg l1-02', byId), { action: 'restore', target: 'LTG-L1-02' });
  assert.deepEqual(toRequest({ action: 'restore', target: 'LTG-L1-02' }), { path: '/api/nodes/LTG-L1-02/restore', body: {} });
});

test('commands with no recognisable board fall back to the fault sub-main', () => {
  assert.deepEqual(fallbackCommand('route power away from the faulty board'), { action: 'trip', target: 'SMSB-B' });
  assert.deepEqual(fallbackCommand('restore power'), { action: 'reset', target: 'SMSB-B' });
});
