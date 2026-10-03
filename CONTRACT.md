# PowerTrace API contract

This file is the single source of truth between `/backend`, `/screen`, `/join`, `/bot` and `/data`.
**Build against this file, not against each other's code.** To change it, ask the lead (agent 1);
the lead updates this file on `main` and everyone pulls.

- Base URL in development: `http://localhost:3000` (the real backend and `/mock` both listen there).
- In the demo everything is served from one origin through the tunnel: the screen at `/`, phones at `/join`, the API at `/api`, Socket.IO at `/socket.io`.
- All bodies are JSON (`Content-Type: application/json`) except `POST /api/import`, which takes `text/csv`.
- CORS is open (`*`) on both REST and Socket.IO so the Vite dev server on `:5173` can call `:3000`.

---

## 1. Data model

Two databases with the **same collections, validator, indexes and queries**; only the size differs:

| Site | Database (env) | Size | Used for |
| --- | --- | --- | --- |
| `demo` | `DEMO_DB` (default `powertrace_demo`) | 60 nodes | the live audience demo |
| `hospital` | `HOSPITAL_DB` (default `powertrace_hospital`) | ~300 boards, ~4,000 equipment | the scale segment |

Every REST endpoint takes an optional `?site=demo|hospital` query parameter. **Default: `demo`.**

### 1.1 `nodes` collection

One document per board or piece of equipment. The equipment/board tag is the `_id`, so the default unique
`_id` index rejects duplicate tags. `parentId` points at whatever feeds this node; that one field turns
the collection into a graph that `$graphLookup` can walk.

**Board**

```json
{
  "_id": "DB-L3-01",
  "type": "board",
  "kind": "DB",
  "name": "Level 3 mechanical distribution board",
  "parentId": "SMSB-B",
  "level": 3,
  "voltage": 400,
  "phases": 3,
  "capacityKW": 60,
  "tripped": false
}
```

**Equipment**

```json
{
  "_id": "AHU-07",
  "type": "equipment",
  "kind": "AHU",
  "name": "Air handling unit",
  "parentId": "DB-L3-01",
  "level": 3,
  "voltage": 400,
  "phases": 3,
  "ratedKW": 15,
  "loadKW": 15,
  "on": true,
  "critical": false,
  "claimedBy": null
}
```

| Field | Type | Applies to | Rules |
| --- | --- | --- | --- |
| `_id` | string | all | The tag, e.g. `AHU-07`. Unique. |
| `type` | string | all | `"board"` or `"equipment"` |
| `kind` | string | all | Boards: `MSB`, `SMSB`, `DB`. Equipment: free code such as `AHU`, `LTG`, `PMP` (used for icons/labels) |
| `name` | string | all | Human description, e.g. "Air handling unit" |
| `parentId` | string or null | all | Tag of the feeding board. `null` only for the main switchboard (`MSB`) |
| `level` | int | all | Building level. `0` = ground/basement plant room |
| `voltage` | int | all | `230` (single-phase) or `400` (three-phase) |
| `phases` | int | all | `1` or `3` |
| `capacityKW` | number > 0 | board | Board rating |
| `tripped` | bool | board | `true` = this board is off; everything downstream is de-energised |
| `ratedKW` | number > 0 | equipment | Nameplate rating |
| `loadKW` | number >= 0 | equipment | Current draw when on. Starts equal to `ratedKW`; "add load" changes it |
| `on` | bool | equipment | Switched on or off |
| `critical` | bool | equipment | Must not lose power unplanned (emergency lighting, theatre lights, ...) |
| `claimedBy` | string or null | equipment | Socket/client id of the phone that claimed it (demo only) |

**`$jsonSchema` validator** (backend owns it, in `backend/src/schema.js`): requires the common fields above,
`type` enum `board|equipment`, `voltage` enum `230|400`, `phases` enum `1|3`; boards also require
`capacityKW` and `tripped`; equipment also requires `ratedKW`, `loadKW`, `on`, `critical`.
Indexes: `{ parentId: 1 }` (graph traversal), `{ type: 1, level: 1 }`.

**Computed, never stored:**

- **De-energised**: a node is de-energised if it, or any board upstream of it, has `tripped: true`.
- **Board load (kW)**: the sum of `loadKW` of every equipment item downstream of the board that is `on: true`
  and not de-energised. A tripped board's load is `0`. Hint: `$graphLookup` with
  `restrictSearchWithMatch: { tripped: { $ne: true } }` stops the walk at tripped boards.
- **Load percent**: `Math.round(loadKW / capacityKW * 100)`. Colours: green `< 80`, amber `80–100`, red `> 100`.

### 1.2 `events` collection

The audit trail. One document per change; feeds the activity panel and the change history.

```json
{
  "_id": "66fe3c...",
  "ts": "2026-10-03T16:17:03.120Z",
  "who": "phone:AHU-07",
  "action": "rewire",
  "nodeId": "AHU-07",
  "from": "DB-L3-01",
  "to": "DB-L2-02",
  "level": 3
}
```

| `action` | `from` → `to` |
| --- | --- |
| `toggle` | `"off"` → `"on"` (or the reverse) |
| `rewire` | old `parentId` → new `parentId` |
| `load` | old `loadKW` → new `loadKW` (numbers) |
| `trip` | `false` → `true` (board tripped) |
| `reset` | `true` → `false` (board reset) |
| `claim` | `null` → claimer id |
| `import` | `null` → `"<n> rows"` (`nodeId` is `null`) |

### 1.3 Identity headers

Every mutating request may send two optional headers:

| Header | Example | Used for |
| --- | --- | --- |
| `X-Socket-Id` | `Jx8kP2...` (the client's `socket.id`) | The backend emits `rejected` **only to this socket** |
| `X-Who` | `phone:AHU-07`, `bot-12`, `presenter` | Stored as `who` in `events` |

If `X-Who` is missing the backend uses `"anonymous"`.

---

## 2. REST endpoints

Errors always look like:

```json
{ "error": "Rejected: DB-L2-02 is single-phase", "code": "PHASE_MISMATCH" }
```

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Missing or malformed body |
| 404 | `NOT_FOUND` | Unknown node or board id |
| 409 | `PHASE_MISMATCH` | 3-phase equipment or board onto a single-phase board |
| 409 | `CIRCULAR_FEED` | New parent is the node itself or downstream of it |
| 409 | `OVERLOAD` | Re-wire would push the target board, or any board upstream of it, over 100% |
| 409 | `NOT_A_BOARD` | Re-wire target is a piece of equipment |
| 422 | `SCHEMA_VALIDATION` | MongoDB `$jsonSchema` rejected the write (error code 121) |

A rejected **mutation** also emits a `rejected` Socket.IO event to the caller's `X-Socket-Id`.

### `GET /api/health`

```json
{ "ok": true, "db": "connected", "sites": ["demo", "hospital"] }
```

### `GET /api/tree?site=demo`

The whole building, plus current loads and the list of de-energised nodes.
For the hospital, `&level=5` returns only that level's nodes (boards on other levels that feed them are not included).

```json
{
  "site": "demo",
  "nodes": [
    { "_id": "MSB", "type": "board", "kind": "MSB", "name": "Main switchboard", "parentId": null, "level": 0, "voltage": 400, "phases": 3, "capacityKW": 300, "tripped": false },
    { "_id": "AHU-07", "type": "equipment", "kind": "AHU", "name": "Air handling unit", "parentId": "DB-L3-01", "level": 3, "voltage": 400, "phases": 3, "ratedKW": 15, "loadKW": 15, "on": true, "critical": false, "claimedBy": null }
  ],
  "loads": { "MSB": 61, "SMSB-A": 71, "SMSB-B": 55, "DB-L3-01": 67 },
  "deenergised": []
}
```

### `GET /api/nodes/:id?site=demo`

```json
{ "node": { "_id": "AHU-07", "type": "equipment", "...": "..." }, "energised": true }
```

### `GET /api/boards?site=demo`

Boards for the re-wire dropdown, ordered by level then id.

```json
{
  "boards": [
    { "_id": "DB-L2-02", "name": "Level 2 lighting & small power", "level": 2, "phases": 1, "voltage": 230, "capacityKW": 20, "tripped": false, "loadPct": 43 },
    { "_id": "DB-L3-01", "name": "Level 3 mechanical distribution board", "level": 3, "phases": 3, "voltage": 400, "capacityKW": 60, "tripped": false, "loadPct": 67 }
  ]
}
```

### `POST /api/claim`

Gives the caller one equipment node. Picks a random **unclaimed** equipment item from the demo site and sets
`claimedBy` to the caller's `X-Socket-Id` (or a generated id). If every item is claimed, returns a random one anyway.
Send `preferId` to get the same node back after a page reload (the phone keeps it in `localStorage`).

Request:

```json
{ "preferId": "AHU-07" }
```

Response `200`:

```json
{
  "node": { "_id": "AHU-07", "type": "equipment", "kind": "AHU", "name": "Air handling unit", "parentId": "DB-L3-01", "level": 3, "voltage": 400, "phases": 3, "ratedKW": 15, "loadKW": 15, "on": true, "critical": false, "claimedBy": "Jx8kP2" },
  "energised": true
}
```

Phone card text: *"You are AHU-07, a 15 kW air handling unit fed from DB-L3-01."*

### `POST /api/nodes/:id/toggle`

Switch equipment on/off. Body is optional: `{ "on": true }` sets it, an empty body flips it.
**Never rejected for overload**: piling load on until a board goes red is the point of the demo.

Response `200`:

```json
{ "node": { "_id": "AHU-07", "on": false, "...": "..." } }
```

### `POST /api/nodes/:id/rewire`

Move equipment (or a board) to a new feeding board. Validated in this order:
`NOT_FOUND` → `NOT_A_BOARD` → `CIRCULAR_FEED` → `PHASE_MISMATCH` → `OVERLOAD`.

Request:

```json
{ "parentId": "DB-L2-02" }
```

Response `200`:

```json
{ "node": { "_id": "AHU-07", "parentId": "DB-L2-02", "...": "..." }, "from": "DB-L3-01", "to": "DB-L2-02" }
```

Response `409`:

```json
{ "error": "Rejected: DB-L2-02 is single-phase", "code": "PHASE_MISMATCH" }
```

```json
{ "error": "Rejected: circular feed (DB-L3-01 is downstream of SMSB-B)", "code": "CIRCULAR_FEED" }
```

```json
{ "error": "Rejected: DB-L3-01 would be at 112%", "code": "OVERLOAD" }
```

### `POST /api/nodes/:id/load`

Add (or remove) load on a piece of equipment. `deltaKW` must be between `-50` and `50`; `loadKW` never goes below `0`.
**Never rejected for overload** (same reason as toggle).

Request:

```json
{ "deltaKW": 5 }
```

Response `200`:

```json
{ "node": { "_id": "AHU-07", "loadKW": 20, "...": "..." } }
```

### `POST /api/boards/:id/trip`

Trip or reset a board. Body `{ "tripped": true }` or `{ "tripped": false }`; an empty body flips it.
`affected` is every node downstream of the board (from `$graphLookup`), not including the board itself.

Response `200`:

```json
{ "boardId": "SMSB-B", "tripped": true, "affected": ["DB-L2-02", "DB-L3-01", "DB-L3-02", "AHU-07", "LIFT-01"] }
```

### `GET /api/trace/down/:id?site=demo`

Everything downstream: "what loses power if this trips?" `depth` is from `$graphLookup` (`0` = direct child).

```json
{
  "id": "SMSB-B",
  "downstream": [
    { "_id": "DB-L3-01", "type": "board", "parentId": "SMSB-B", "depth": 0 },
    { "_id": "AHU-07", "type": "equipment", "parentId": "DB-L3-01", "depth": 1 }
  ],
  "queryMs": 2
}
```

### `GET /api/trace/up/:id?site=demo`

The feed path back to the main switchboard: "what feeds this?" `path` is ordered nearest first.

```json
{ "id": "AHU-07", "path": ["DB-L3-01", "SMSB-B", "MSB"], "queryMs": 1 }
```

### `GET /api/impact/:id?site=hospital`

Planned-shutdown report: everything that loses power if board `:id` is isolated, critical items flagged.
`queryMs` is `executionTimeMillis` from `explain("executionStats")` of the `$graphLookup` aggregation.

```json
{
  "boardId": "DB-L5-02",
  "site": "hospital",
  "counts": { "total": 74, "boards": 4, "equipment": 70, "critical": 9 },
  "totalKW": 112.4,
  "critical": [
    { "_id": "THL-L5-003", "name": "Theatre 3 operating light", "kind": "THL", "parentId": "DB-L5-02C", "level": 5, "loadKW": 1.5 }
  ],
  "affected": [
    { "_id": "DB-L5-02A", "type": "board", "name": "Level 5 lighting sub-board A", "kind": "DB", "parentId": "DB-L5-02", "level": 5, "depth": 0, "critical": false, "loadKW": 0 },
    { "_id": "THL-L5-003", "type": "equipment", "name": "Theatre 3 operating light", "kind": "THL", "parentId": "DB-L5-02C", "level": 5, "depth": 1, "critical": true, "loadKW": 1.5 }
  ],
  "queryMs": 14
}
```

### `POST /api/import?site=hospital&replace=true`

Import a cable schedule CSV. Body is the raw CSV text with `Content-Type: text/csv` (up to 5 MB).
`replace=true` deletes the site's existing `nodes` first (the demo flow imports into an empty hospital).
Without it, rows whose tag already exists are rejected as duplicates by the unique `_id` index.

CSV format: see [`data/README.md`](data/README.md#cable-schedule-csv). `row` is the line number in the file (the header is line 1).

Response `200`:

```json
{
  "total": 4180,
  "imported": 4156,
  "rejected": [
    { "row": 18, "tag": "LTG-L1-007", "code": "MISSING_RATING", "reason": "missing rated_kw" },
    { "row": 912, "tag": "SP-L4-031", "code": "DUPLICATE_TAG", "reason": "duplicate tag SP-L4-031" },
    { "row": 1410, "tag": "AHU-L5-002", "code": "PHASE_MISMATCH", "reason": "DB-L5-02A is single-phase" },
    { "row": 2203, "tag": "DB-L7-X1", "code": "CIRCULAR_FEED", "reason": "feed loops back on itself (DB-L7-X1 -> DB-L7-X2 -> DB-L7-X1)" }
  ],
  "ms": 840
}
```

Rejection codes: `MISSING_RATING`, `DUPLICATE_TAG`, `INVALID_VOLTAGE`, `UNKNOWN_TYPE`, `PHASE_MISMATCH`,
`CIRCULAR_FEED`, `UNKNOWN_FEEDER`. The expected result for `data/messy-schedule.csv` is in
`data/messy-schedule.expected.json`; use it as the importer's test.

### `GET /api/history?site=hospital&level=5&days=7` *(cut first if short on time)*

Change history from an aggregation over `events`. `level` is optional.

```json
{
  "byDay": [ { "day": "2026-09-28", "count": 41 } ],
  "byWho": [ { "who": "Northside M&E", "count": 37 } ],
  "byAction": [ { "action": "rewire", "count": 22 } ],
  "recent": [ { "ts": "2026-10-03T09:12:00.000Z", "who": "Northside M&E", "action": "rewire", "nodeId": "SP-L5-014", "from": "DB-L5-01B", "to": "DB-L5-02B", "level": 5 } ]
}
```

### `POST /api/reset?site=demo`

Re-seed the demo building from `data/demo-building.js` (clears claims, trips and events). Emits `tree:reload`.
Used between rehearsals and right before going on stage.

```json
{ "ok": true, "nodes": 60 }
```

---

## 3. Socket.IO events (backend → clients)

Socket.IO events cover the **demo site only**. Clients don't need to send anything over the socket; all
actions go through REST. Connect with `io(BASE_URL)`; phones load the client from `/socket.io/socket.io.js`.

| Event | Payload | Sent to | When |
| --- | --- | --- | --- |
| `node:changed` | `{ node }` | everyone | Any change to a node (from the change stream, full document) |
| `loads` | `{ [boardId]: percent }` | everyone | After every node change (all boards, recomputed) |
| `trip` | `{ boardId, tripped, affected: [ids] }` | everyone | A board is tripped (`tripped: true`) or reset (`false`) |
| `event` | `{ ts, who, action, nodeId, from, to, level }` | everyone | A new `events` document (activity feed) |
| `rejected` | `{ reason, code, nodeId }` | the `X-Socket-Id` socket only | A mutation was rejected |
| `tree:reload` | `{ site }` | everyone | After `/api/reset` or an import: refetch `/api/tree` |

Examples:

```json
// node:changed
{ "node": { "_id": "AHU-07", "type": "equipment", "parentId": "DB-L2-01", "on": true, "loadKW": 15, "...": "..." } }

// loads
{ "MSB": 63, "SMSB-A": 78, "SMSB-B": 49, "DB-L3-01": 112, "DB-L2-02": 43 }

// trip
{ "boardId": "SMSB-B", "tripped": true, "affected": ["DB-L2-02", "DB-L3-01", "DB-L3-02", "AHU-07"] }

// event
{ "ts": "2026-10-03T16:17:03.120Z", "who": "phone:AHU-07", "action": "rewire", "nodeId": "AHU-07", "from": "DB-L3-01", "to": "DB-L2-01", "level": 3 }

// rejected
{ "reason": "Rejected: DB-L2-02 is single-phase", "code": "PHASE_MISMATCH", "nodeId": "AHU-07" }
```

Phone behaviour on `trip`: if `tripped && affected.includes(myId)` show "YOU'VE LOST POWER";
if `!tripped && affected.includes(myId)` show "Power restored".

---

## 4. Reference queries

```js
// Downstream: what loses power if SMSB-B trips?
db.nodes.aggregate([
  { $match: { _id: "SMSB-B" } },
  { $graphLookup: { from: "nodes", startWith: "$_id",
      connectFromField: "_id", connectToField: "parentId",
      as: "downstream", depthField: "depth" } }
])

// Upstream: what feeds AHU-07?
db.nodes.aggregate([
  { $match: { _id: "AHU-07" } },
  { $graphLookup: { from: "nodes", startWith: "$parentId",
      connectFromField: "parentId", connectToField: "_id",
      as: "feedPath", depthField: "depth" } }
])

// Live load of one board: energised, switched-on equipment downstream
db.nodes.aggregate([
  { $match: { _id: "DB-L3-01", tripped: { $ne: true } } },
  { $graphLookup: { from: "nodes", startWith: "$_id",
      connectFromField: "_id", connectToField: "parentId",
      as: "down", restrictSearchWithMatch: { tripped: { $ne: true } } } },
  { $project: { capacityKW: 1, loadKW: { $sum: {
      $map: { input: { $filter: { input: "$down", cond: { $and: [
        { $eq: ["$$this.type", "equipment"] }, { $eq: ["$$this.on", true] } ] } } },
        in: "$$this.loadKW" } } } } }
])
```

`$jsonSchema` validates the shape of one document. Rules that span documents (no circular feeds, no
overloads, phase compatibility with the feeding board) are app logic built on `$graphLookup`.
