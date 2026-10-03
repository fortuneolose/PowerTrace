import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { io } from 'socket.io-client';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

// The root script invokes a second npm command without an argument separator.
// npm consumes flags and forwards their values as positional arguments.
export function rootArgs(argv, env = process.env) {
  if (!env.npm_lifecycle_event || argv.some((value) => value.startsWith('--'))) return argv;
  const result = [];
  const numbers = [];
  for (const value of argv) {
    if (/^https?:\/\//.test(value)) result.push('--url', value);
    else if (Number.isFinite(Number(value))) numbers.push(value);
    else throw new Error(`Invalid argument: ${value}`);
  }
  if (env.npm_config_duration === 'true' && numbers.length) result.push('--duration', numbers.pop());
  if (numbers.length > 1) throw new Error('Use --n NUMBER --url URL --duration SECONDS in that order');
  if (numbers.length) result.push('--n', numbers[0]);
  for (const key of ['url', 'duration', 'n']) {
    const value = env[`npm_config_${key}`];
    if (value && value !== 'true') result.push(`--${key}`, value);
  }
  return result;
}

export function parseArgs(argv) {
  const options = { n: 30, url: process.env.BOT_URL || 'http://localhost:3000', duration: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    const key = argv[i].replace(/^--/, '');
    if (!['n', 'url', 'duration'].includes(key) || !argv[i].startsWith('--') || !argv[i + 1]) throw new Error(`Invalid argument: ${argv[i]}`);
    options[key] = argv[++i];
  }
  options.n = Number(options.n);
  options.duration = Number(options.duration);
  if (!Number.isInteger(options.n) || options.n < 1 || options.n > 500) throw new Error('--n must be an integer from 1 to 500');
  if (!Number.isFinite(options.duration) || options.duration < 0) throw new Error('--duration must be a non-negative number of seconds');
  const url = new URL(options.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must be an HTTP or HTTPS URL');
  options.url = url.href.replace(/\/$/, '');
  return options;
}

export async function run(options) {
  const clients = [];
  let stopping = false;
  const stats = { claims: 0, actions: 0, rejected: 0, errors: 0 };
  async function request(path, who, socketId, body) {
    const response = await fetch(`${options.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Who': who, 'X-Socket-Id': socketId || '' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
    return data;
  }
  await request('/api/health', 'bot', '');
  console.log(`Simulating ${options.n} contractors at ${options.url}. Ctrl+C to stop.`);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const client of clients) { clearTimeout(client.timer); client.socket.disconnect(); }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const durationTimer = options.duration ? setTimeout(stop, options.duration * 1000) : null;
  const reportTimer = setInterval(() => console.log('Totals:', JSON.stringify(stats)), 10000);
  try {
    for (let i = 0; i < options.n; i++) {
      const who = `bot-${i + 1}`;
      const socket = io(options.url, { autoConnect: false, reconnection: true });
      const client = { socket, node: null, ready: false, active: false, generation: 0, timer: null };
      clients.push(client);
      const schedule = () => { clearTimeout(client.timer); if (!stopping) client.timer = setTimeout(step, 1000 + Math.random() * 2000); };
      async function claim() {
        const generation = ++client.generation;
        client.ready = false;
        try {
          const data = await request('/api/claim', who, socket.id, { preferId: client.node?._id });
          if (generation !== client.generation || stopping || !socket.connected) return;
          client.node = data.node; client.ready = true; stats.claims++;
          console.log(`${who} claimed ${data.node._id}`);
        } catch (error) { stats.errors++; console.error(`${who} claim: ${error.message}`); }
        finally { schedule(); }
      }
      async function step() {
        if (stopping) return;
        if (!socket.connected || client.active) { schedule(); return; }
        if (!client.ready) { await claim(); return; }
        client.active = true;
        const generation = client.generation;
        try {
          const choice = Math.random();
          let action, body;
          if (choice < .4) { action = 'toggle'; body = {}; }
          else if (choice < .7) { action = 'load'; body = { deltaKW: Math.random() < .5 ? 5 : -5 }; }
          else {
            const { boards } = await request('/api/boards', who, socket.id);
            const targets = boards.filter((b) => b._id !== client.node.parentId);
            if (!targets.length) return;
            action = 'rewire'; body = { parentId: targets[Math.floor(Math.random() * targets.length)]._id };
          }
          if (stopping || !client.ready || generation !== client.generation) return;
          const data = await request(`/api/nodes/${encodeURIComponent(client.node._id)}/${action}`, who, socket.id, body);
          if (generation === client.generation) client.node = data.node;
          stats.actions++;
        } catch (error) {
          if (error.status === 409) { stats.rejected++; console.log(`${who}: ${error.message}`); }
          else { stats.errors++; console.error(`${who}: ${error.message}`); }
        } finally { client.active = false; schedule(); }
      }
      socket.on('connect', claim);
      socket.on('disconnect', () => { client.ready = false; client.generation++; });
      socket.on('connect_error', (error) => console.error(`${who} connection: ${error.message}`));
      socket.on('node:changed', ({ node }) => { if (node._id === client.node?._id) client.node = node; });
      socket.on('tree:reload', ({ site }) => { if (site === 'demo' && socket.connected) claim(); });
      socket.connect();
    }
    while (!stopping) await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    stop(); clearTimeout(durationTimer); clearInterval(reportTimer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  console.log('Final totals:', JSON.stringify(stats));
  return stats;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArgs(rootArgs(process.argv.slice(2)));
    if (options.help) console.log('Usage: npm run bot -- --n 30 --url http://localhost:3000 [--duration SECONDS]');
    else await run(options);
  } catch (error) { console.error(`Bot: ${error.message}`); process.exitCode = 1; }
}
