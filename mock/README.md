# /mock (owner: lead)

An in-memory implementation of the whole [CONTRACT.md](../CONTRACT.md): every REST endpoint, every
Socket.IO event, and the phone page at `/join`. No MongoDB, no `.env`. Use it to build `/screen`,
`/join` and `/bot` before the real backend is live; switching to the backend changes nothing but the base URL.

## Run it

From the repo root:

```bash
npm --prefix mock install   # first time only (or npm run install:all)
npm run mock
```

Or inside `/mock`: `npm start` (or `npm run dev` to restart on file changes).

- Listens on `http://localhost:3000`. Set `PORT` to change it: `PORT=3001 npm run mock`.
- Phones: `http://localhost:3000/join` (served from `../join`, with the Socket.IO client at `/socket.io/socket.io.js`).
- If `screen/dist` exists (`npm run build:screen`), the built screen is served at `/` too. Otherwise run the Vite dev server (`npm run screen`) and point it at `:3000`.
- Logs one line per request (`METHOD path status time`).

## State

Everything lives in memory:

- **demo**: the 60 nodes from `data/demo-building.js`. `POST /api/reset` re-seeds it (clears claims, trips and events) and emits `tree:reload`. Restarting the server does the same.
- **hospital**: generated at startup by `generateHospital()` from `data/lib/hospital.js`. Restart the server to get it back after an import with `replace=true`. If that file is missing, the hospital starts empty.

## Limits (compared with the real backend)

- Graph queries are plain JavaScript over arrays (`data/lib/graph.js`), not `$graphLookup`. `queryMs` is wall-clock time in JS, not `executionTimeMillis` from `explain()`.
- `POST /api/import` uses `parseSchedule()` from `data/lib/schedule.js`; there is no `$jsonSchema` validator or unique index doing the rejecting, so `SCHEMA_VALIDATION` (422) never happens here. If that file is missing, import returns `501 NOT_IMPLEMENTED`.
- Change history (`GET /api/history`) is computed in JS over the in-memory events: the hospital's simulated past events plus anything done since startup. It is not persisted.
- Socket.IO events (`node:changed`, `loads`, `trip`, `event`) are emitted for the demo site only, as in the contract. `tree:reload` is sent for both sites (its payload names the site) and `rejected` goes to the caller's `X-Socket-Id` whichever site it was.
- Re-wire `OVERLOAD`: a move is rejected if it raises the load of the target board, or a board upstream of it, and leaves that board over 100%. Boards whose load the move doesn't change (shared ancestors) are not checked.
- When a socket disconnects, the equipment it claimed is released (`claimedBy: null`).
