import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('30 real contractors send attributed actions and release claims at shutdown', { timeout: 20000 }, async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [fileURLToPath(new URL('../../mock/server.js', import.meta.url))], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  let bot;
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(up, 'Install mock dependencies before running this integration test');
    bot = spawn(process.execPath, [fileURLToPath(new URL('../bot.js', import.meta.url)), '--n', '30', '--url', base, '--duration', '5'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    bot.stdout.on('data', (chunk) => { output += chunk; });
    bot.stderr.on('data', (chunk) => { errors += chunk; });
    const [code] = await once(bot, 'exit');
    assert.equal(code, 0, errors);
    const totals = JSON.parse(output.match(/Final totals: (.+)/)[1]);
    assert.equal(totals.claims, 30);
    assert.ok(totals.actions > 0);
    assert.equal(totals.errors, 0, errors);
    const history = await fetch(`${base}/api/history`).then((r) => r.json());
    assert.equal(history.byWho.length, 30);
    assert.ok(history.byWho.every((entry) => /^bot-\d+$/.test(entry.who)));
    const tree = await fetch(`${base}/api/tree`).then((r) => r.json());
    assert.ok(tree.nodes.every((node) => !node.claimedBy), 'Socket identity must permit claim cleanup');
  } finally {
    bot?.kill(); server.kill();
  }
});
