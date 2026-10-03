// Runs the shared contract test (mock/test/contract.mjs) against the REAL backend on Atlas.
// Usage, from /backend:  npm run test:contract
// Needs: the root .env with MONGODB_URI, and `npm --prefix ../mock install` (for socket.io-client).
// Warning: the test calls POST /api/reset, so it re-seeds the demo site.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = 4000 + Math.floor(Math.random() * 1000);
const base = `http://localhost:${port}`;
const server = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let up = false;
for (let i = 0; i < 150 && !up; i++) {
  await new Promise((r) => setTimeout(r, 200));
  up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
}
if (!up) {
  server.kill();
  console.error('backend did not start within 30 s (check MONGODB_URI and the Atlas network access list)');
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 500)); // let the change streams open

const test = spawn(process.execPath, [fileURLToPath(new URL('../../mock/test/contract.mjs', import.meta.url))], {
  env: { ...process.env, BASE: base },
  stdio: 'inherit',
});
test.on('exit', (code) => {
  server.kill();
  process.exit(code ?? 1);
});
