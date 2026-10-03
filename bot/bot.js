// Fallback bot: simulates N contractors (default 30) through the same REST endpoints as the phones.
// Owner: agent 3 (join/bot). Scaffold only.
// Usage: npm run bot -- --n 30 --url http://localhost:3000
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => s.trim().split(/\s+/)));
const BASE_URL = args.url || process.env.BOT_URL || 'http://localhost:3000';
const N = Number(args.n) || 30;

console.log(`TODO: simulate ${N} contractors against ${BASE_URL} (see CONTRACT.md: POST /api/claim, toggle, rewire, load)`);
