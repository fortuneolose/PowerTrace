import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, rootArgs } from '../bot.js';
import { joinUrl } from '../qr.js';

test('bot accepts root-command arguments and finite rehearsal duration', () => {
  assert.deepEqual(parseArgs(['--n', '30', '--url', 'http://localhost:3000/', '--duration', '10']), { n: 30, url: 'http://localhost:3000', duration: 10 });
  for (const args of [['--n', '0'], ['--n', '1.5'], ['--n', '501'], ['--duration', '-1'], ['--url', 'file:///x'], ['--unknown', '1'], ['--n']]) assert.throws(() => parseArgs(args));
});
test('QR points a bare origin at join and preserves an explicit join URL', () => {
  assert.equal(joinUrl('https://demo.example'), 'https://demo.example/join');
  assert.equal(joinUrl('https://demo.example/join?demo=1'), 'https://demo.example/join?demo=1');
  for (const value of [undefined, 'not a URL', 'file:///x', 'https://user:password@example.com']) assert.throws(() => joinUrl(value));
});

test('root npm wrapper preserves contractor count, URL and duration', () => {
  const env = { npm_lifecycle_event: 'start', npm_config_url: 'true', npm_config_duration: 'true' };
  assert.deepEqual(parseArgs(rootArgs(['30', 'http://localhost:3000', '10'], env)), { n: 30, url: 'http://localhost:3000', duration: 10 });
  assert.deepEqual(rootArgs(['--n', '3'], env), ['--n', '3']);
});