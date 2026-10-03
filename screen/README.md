# /screen (owner: agent 2, Arush)

Main screen: React + Vite + React Flow (`@xyflow/react`) + dagre.

```bash
npm install
npm run dev        # http://localhost:5173, talks to http://localhost:3000 (backend or `npm run mock`)
npm run build      # dist/ is served by the backend (and the mock) at / for the demo
```

The base URL is the single setting in `src/config.js` (override with `VITE_API_URL` in `screen/.env.local`).
The QR code points at `<API origin>/join`; set `VITE_JOIN_URL` if the screen runs from Vite during the demo.

## Views

**`#/` Demo building.** dagre lays out the boards top-down; each board's equipment hangs underneath it in a
column, like the ways on a panel schedule, so all 60 nodes fit on a projector.

- Load bar per board from `loads` (green under 80%, amber 80-100%, red over 100%).
- Click any node: `GET /api/trace/up/:id`, the supply path turns yellow, with the query time.
- Board selected: Trip / Reset (`POST /api/boards/:id/trip`) and "Show what loses power" (`GET /api/trace/down/:id`, previewed as a dashed red ripple).
- Equipment selected: re-wire it from the panel (`POST /api/nodes/:id/rewire`); rejections appear as a toast.
- `trip` events ripple red down the tree level by level and pop a banner naming critical items.
- `node:changed` with a new `parentId` glides the item to its new board and flashes the wire.
- Activity feed from `event`; `tree:reload` refetches; Reset demo (two clicks) calls `POST /api/reset`.

**`#/hospital` Scale view.** Levels are collapsed; only boards are listed (equipment is counted, never
rendered). Picking a board calls `GET /api/impact/:id?site=hospital` and shows counts, critical loads and
the `$graphLookup` time.
