// Starts the mock on a spare port, runs test/contract.mjs against it, stops it. Usage: npm test
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = 4000 + Math.floor(Math.random() * 1000);
const base = `http://localhost:${port}`;
const server = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let up = false;
for (let i = 0; i < 50 && !up; i++) {
  await new Promise((r) => setTimeout(r, 100));
  up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
}
if (!up) {
  server.kill();
  console.error('mock server did not start');
  process.exit(1);
}

const test = spawn(process.execPath, [fileURLToPath(new URL('./contract.mjs', import.meta.url))], {
  env: { ...process.env, BASE: base },
  stdio: 'inherit',
});
test.on('exit', (code) => {
  server.kill();
  process.exit(code ?? 1);
});
