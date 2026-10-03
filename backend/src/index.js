// PowerTrace backend. Owner: agent 4 (backend). Implements CONTRACT.md.
// Scaffold only: routes below return 501 until implemented.
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { config } from './config.js';
import { connect, getDb, SITES } from './db.js';
import { ensureSchema } from './schema.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/csv', limit: '5mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- REST (CONTRACT.md section 2) ---
const api = express.Router();
const todo = (req, res) => res.status(501).json({ error: `${req.method} ${req.baseUrl}${req.path} not implemented yet`, code: 'NOT_IMPLEMENTED' });

api.get('/health', (req, res) => res.json({ ok: true, db: 'connected', sites: SITES }));
api.get('/tree', todo);
api.get('/nodes/:id', todo);
api.get('/boards', todo);
api.post('/claim', todo);
api.post('/nodes/:id/toggle', todo);
api.post('/nodes/:id/rewire', todo);
api.post('/nodes/:id/load', todo);
api.post('/boards/:id/trip', todo);
api.get('/trace/down/:id', todo);
api.get('/trace/up/:id', todo);
api.get('/impact/:id', todo);
api.post('/import', todo);
api.get('/history', todo);
api.post('/reset', todo);
app.use('/api', api);

// --- Static pages: phones at /join, the built screen at / ---
const joinDir = fileURLToPath(new URL('../../join', import.meta.url));
const screenDist = fileURLToPath(new URL('../../screen/dist', import.meta.url));
app.use('/join', express.static(joinDir));
if (fs.existsSync(screenDist)) {
  app.use(express.static(screenDist));
  app.get(/^\/(?!api|socket\.io|join).*/, (req, res) => res.sendFile(`${screenDist}/index.html`));
}

// --- Socket.IO (CONTRACT.md section 3) ---
io.on('connection', (socket) => {
  console.log('client connected', socket.id);
});

// Usage elsewhere: io.emit('node:changed', { node }); io.to(req.get('X-Socket-Id')).emit('rejected', {...})
export { app, io };

await connect();
for (const site of SITES) await ensureSchema(getDb(site));
server.listen(config.port, () => {
  console.log(`PowerTrace backend on http://localhost:${config.port}  (phones: /join)`);
});
