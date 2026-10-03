# PowerTrace: rules for every coding agent

Hackathon project, due **16:00 today**. Four people, four coding agents, one repo. Read this file,
[README.md](README.md) (what we're building) and [CONTRACT.md](CONTRACT.md) (the API) before writing code.

## Ownership: edit only your own folder

| Agent | Person | Owns | May NOT edit |
| --- | --- | --- | --- |
| 1 (lead) | Fortune | repo root files, `CONTRACT.md`, `/data`, `/mock`, merging and integration | other folders' internals without asking the owner |
| 2 | Arush | `/screen` | everything else |
| 3 | Alex | `/join`, `/bot` (and polishing `README.md` for submission, with the lead) | everything else |
| 4 | Matthew | `/backend` | everything else |

That rule is what stops four agents overwriting each other. If you need something outside your
folder, tell your human; they ask the owner.

## The contract is law

- Build against `CONTRACT.md`, not against another folder's code.
- Need a new field, endpoint or event? Your human asks the lead, the lead updates `CONTRACT.md` on
  `main`, everyone pulls. Do not invent fields on your own.
- Until the real backend is live, frontends use the mock: `npm run mock` serves the whole contract
  (REST + Socket.IO + `/join`) from memory on `http://localhost:3000`.
  Switching to the real backend means changing nothing but the base URL.

## Git

- One branch per person (e.g. `arush/screen`, `alex/join`, `matthew/backend`). Commit small and often, push often.
- The lead merges branches into `main` about every 30 minutes and fixes integration breaks.
- Pull `main` into your branch after each merge (`git pull origin main`).
- Never force-push `main`. Never rewrite someone else's branch.

## Secrets: the repo is PUBLIC

- `MONGODB_URI` lives only in `.env` at the repo root (git-ignored). Copy `.env.example`.
- Never commit `.env`, connection strings, API keys, or anything in `private/`.
- Share the Atlas connection string with teammates privately (DM), not in the repo or an issue.

## Conventions

- Node 20+, ES modules (`"type": "module"`), plain JavaScript. No TypeScript, no new frameworks.
- Each folder has its own `package.json` and lockfile; there are no npm workspaces (so lockfiles never conflict).
- `.env` is loaded from the repo root (`dotenv.config({ path: '../.env' })`-style; see `backend/src/config.js`).
- Keep it boring and working. Feature freeze at **15:15**: after that, only bug fixes.
- Run what you build before you push (start the server, open the page, click the button).

## Useful files

- `data/demo-building.js`: the 60-node demo building (pure data, importable from anywhere).
- `data/lib/graph.js`: in-memory downstream/upstream/load helpers (used by `/mock` and the data scripts; the real backend does this in MongoDB).
- `data/messy-schedule.csv` + `data/messy-schedule.expected.json`: the import test case and its expected result.
- `backend/src/schema.js`: the `$jsonSchema` validator and indexes (the seed scripts use it too, so keep it dependency-free).

## Kickoff prompts

Paste the one for your agent once this scaffold is on `main`.

**Agent 2 (Arush), `/screen`:**

```text
You own /screen only. Do not edit other folders. Read CLAUDE.md, README.md and CONTRACT.md first.
Build the main screen in React with React Flow (@xyflow/react) and a dagre top-down layout. Load GET /api/tree. Each board shows a load bar: green under 80%, amber 80-100%, red over 100%. Listen to Socket.IO events node:changed, loads, trip, event and tree:reload. Animate an edge moving when equipment is re-wired. De-energised nodes turn red after a trip. Show an activity feed panel. Clicking a node calls GET /api/trace/up/:id and highlights the path. Add presenter controls: trip/reset a board, and a reset-demo button (POST /api/reset).
Add a second view at #/hospital: a collapsible tree by level (GET /api/tree?site=hospital, optionally &level=N). Picking a board calls GET /api/impact/:id?site=hospital and shows an impact panel with critical items flagged and the query time. Do not render 4,000 nodes at once.
Develop against the mock server (npm run mock, http://localhost:3000). The base URL is the single setting in src/config.js.
```

**Agent 3 (Alex), `/join` and `/bot`:**

```text
You own /join and /bot only. Do not edit other folders. Read CLAUDE.md, README.md and CONTRACT.md first.
/join/index.html: a mobile-first single HTML page with no build step, served by the backend at /join. Load the Socket.IO client from /socket.io/socket.io.js. On load, POST /api/claim (send preferId from localStorage so a reload keeps the same node) and show a card like "You are AHU-07, a 15 kW air handling unit fed from DB-L3-01". Buttons: switch on/off, re-wire (dropdown from GET /api/boards), add 5 kW. Send X-Socket-Id and X-Who headers on every POST. On a rejected event (or a 409 response), show the reason. On a trip event whose affected list includes your node and tripped is true, show a full-screen flashing "YOU'VE LOST POWER" (and vibrate if supported); on reset, show "Power restored". Keep the card in sync from node:changed events for your node.
/bot/bot.js: a Node script that simulates N contractors (default 30), each claiming a node and making a random action every 1-3 seconds through the same endpoints. One command: npm run bot -- --n 30 --url http://localhost:3000
/bot/qr.js: print a QR code in the terminal for a given public URL: npm run qr -- https://xyz.trycloudflare.com/join
Develop against the mock server (npm run mock).
```

**Agent 4 (Matthew), `/backend`:**

```text
You own /backend only. Do not edit other folders. Read CLAUDE.md, README.md and CONTRACT.md first.
Implement CONTRACT.md in backend/src with Express, Socket.IO and the official mongodb driver against Atlas (MONGODB_URI from the root .env, never committed). The scaffold already has the server, the ?site= database switch, the $jsonSchema validator and indexes (schema.js), and 501 stubs for every route. /mock/server.js is an in-memory reference implementation of the same contract: match its behaviour, but do the work in MongoDB.
- Re-wire validation: reject circular feeds (check with $graphLookup downstream of the node being moved), phase mismatches and moves that would overload the target board or anything upstream of it. Emit rejected to the X-Socket-Id socket only.
- Load per board: $graphLookup downstream plus $sum of loadKW for equipment that is on, not walking through tripped boards.
- Trip: set tripped, find everything downstream with $graphLookup, emit trip with the affected ids.
- Watch nodes with a change stream (fullDocument: 'updateLookup') and broadcast node:changed and recomputed loads; watch events and broadcast event.
- POST /api/import: parse the CSV (format in data/README.md), insert valid rows with insertMany({ ordered: false }) so the validator and unique _id index do the rejecting, plus app checks for circular feeds, unknown feeders and phase mismatches. Must reproduce data/messy-schedule.expected.json.
- GET /api/impact/:id: affected items, critical flags and executionTimeMillis from explain().
- POST /api/reset re-seeds the demo site from data/demo-building.js.
Seed Atlas with npm run seed:demo and npm run seed:hospital from the repo root.
```
