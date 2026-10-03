# /backend (owner: agent 4)

Express + Socket.IO + the official `mongodb` driver. Implements [CONTRACT.md](../CONTRACT.md) on MongoDB Atlas.

```bash
npm install
npm run dev              # node --watch src/index.js, reads MONGODB_URI from the root .env
npm run test:contract    # runs mock/test/contract.mjs against this backend (needs: npm --prefix ../mock install)
```

If the demo database is empty on start, the backend seeds the 60-node demo building itself.
`npm run test:contract` calls `POST /api/reset`, so it re-seeds the demo site.

| File | What it does |
| --- | --- |
| `src/index.js` | Server, every REST route, static `/join` and built `/screen` |
| `src/graph.js` | All graph queries, as `$graphLookup` pipelines: downstream, upstream, de-energised set, live board loads |
| `src/realtime.js` | Change streams on `nodes` (`fullDocument: 'updateLookup'`) and `events` → `node:changed`, `loads`, `event` |
| `src/importer.js` | CSV import: `insertMany({ ordered: false })` so the validator and unique `_id` reject bad rows; app checks for unknown feeders, circular feeds, phase mismatches |
| `src/schema.js` | `$jsonSchema` validator + indexes (also used by the `/data` seed scripts, so it stays dependency-free) |
| `src/config.js`, `src/db.js` | Env from the root `.env`; `getDb(site)` for `?site=demo|hospital` |

## Where MongoDB does the work

- **Trip / trace / impact:** `$graphLookup` from the board over `parentId` (index on `parentId`).
- **Live loads:** one aggregation over all boards: `$graphLookup` downstream with
  `restrictSearchWithMatch: { tripped: { $ne: true } }` so the walk stops at tripped boards, then `$sum` of `loadKW` for equipment that is on.
- **Re-wire validation:** circular feed = is the target in the node's `$graphLookup` downstream; overload = the target and every board on its upstream `$graphLookup` path, with the moved load added.
- **Add load:** an atomic pipeline update, `loadKW = max(0, round(loadKW + delta, 2))`.
- **Impact report:** one `$graphLookup` + `$facet` (affected list, critical list, counts and kW); `queryMs` comes from `explain("executionStats")`.
- **History:** one `$facet` over `events` (by day, by who, by action, most recent 50).
- **Live updates:** change streams. If they aren't available (a standalone server, not Atlas) the routes emit directly instead.

## CSV import columns

Header names are matched case-insensitively. Required: `tag`, `type`, `fed_from` (or `feeder` / `parent`),
`voltage`, `phases`. Optional: `name`, `kind`, `level`, `rated_kw` (equipment), `capacity_kw` (boards),
`critical` (`yes`/`true`/`1`), `on`. A CSV missing a required column is a `400` and nothing is deleted.
