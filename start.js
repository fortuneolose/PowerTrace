// Production entry point (Render runs `npm start`). Starts the real backend, or the in-memory mock
// when USE_MOCK=1 (handy before the backend is ready, or as a fallback if Atlas is unreachable).
// Both serve the built screen at /, the phone page at /join, the API at /api and Socket.IO.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const useMock = process.env.USE_MOCK === '1';
const entry = useMock ? './mock/server.js' : './backend/src/index.js';
console.log(`Starting the ${useMock ? 'mock server (USE_MOCK=1)' : 'backend'}`);

const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url))], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 1));
