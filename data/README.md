# /data (owner: lead)

Synthetic data for PowerTrace: the 60-node demo building, the 12-storey hospital, the messy cable
schedule CSV and the scripts that seed MongoDB. Everything here is plain ES-module JavaScript with no
dependencies beyond `mongodb` and `dotenv` (only the seed scripts touch a database).

| File | What it is |
| --- | --- |
| `demo-building.js` | The 60-node office building for the live audience demo (pure data). |
| `lib/graph.js` | In-memory downstream / upstream / load helpers (used by `/mock` and these scripts). |
| `lib/db.js` | `openSite('demo' \| 'hospital')` and `replaceNodes(db, nodes, events)` for the seed scripts. |
| `lib/rng.js` | Deterministic PRNG (mulberry32) with `int`, `float`, `pick`, `chance`, `weighted`, `shuffle`, `sample`. Default seed `20261003`. |
| `lib/hospital.js` | `generateHospital({ seed, now })` returns `{ nodes, events, overloaded }` for the hospital. Pure, no I/O. |
| `lib/schedule.js` | Cable schedule CSV: `toScheduleRows`, a CSV writer and parser, and **`parseSchedule`, the reference importer** (pure, no I/O). |
| `seed-demo.js` | Seeds the demo building into `DEMO_DB`. |
| `seed-hospital.js` | Seeds the hospital and a week of change history into `HOSPITAL_DB`. |
| `make-schedule.js` | Writes `messy-schedule.csv` and `messy-schedule.expected.json`, and asserts the importer gets it right. |
| `messy-schedule.csv` | The hospital as a messy cable schedule: 4,269 rows, 24 of them deliberately bad. |
| `messy-schedule.expected.json` | What `POST /api/import` must return for that file. The backend's import test. |

## Running

From the repo root (needs `MONGODB_URI` in the root `.env` for the seed scripts):

```bash
npm run seed:demo        # 60-node demo building -> DEMO_DB (default powertrace_demo)
npm run seed:hospital    # hospital + ~1,360 events -> HOSPITAL_DB (default powertrace_hospital)
npm run schedule         # regenerate messy-schedule.csv + .expected.json (no database needed)
```

Everything is reproducible: the same seed gives byte-identical nodes, CSV and expected JSON. The change
history is generated relative to `now` (the time you seed), so "this week" is always the last 7 days.

## The hospital

`generateHospital()` (seed `20261003`): **289 boards, 3,968 equipment, 4,257 nodes**, 203 critical items
(5.1% of equipment), ~1,360 change-history events. Every node follows CONTRACT.md 1.1 exactly: all
equipment is `on: true` with `loadKW = ratedKW`, no board is tripped, `voltage` is 400 iff `phases` is 3,
and no single-phase board feeds 3-phase equipment.

```text
MSB (L0, the only root)
├── SMSB-A  riser 1 ── DB-L1-01..04 .. DB-L4-01..04
├── SMSB-B  riser 2 ── DB-L5-01..04 .. DB-L8-01..04       each floor board ── 4 sub-boards A..D
├── SMSB-C  riser 3 ── DB-L9-01..04 .. DB-L12-01..04      (sub-boards mix 1-phase and 3-phase)
├── SMSB-M  mechanical ── DB-L0-01..06 (energy centre), DB-L12-P1..P4 (roof plant), 2 sub-boards each
├── SMSB-E  essential & life safety ── DB-L1-E .. DB-L12-E, main fire alarm panel, smoke extract fans
└── SMSB-L  lifts ── LIFT-L0-001..012 (6 bed, 4 passenger, goods, firefighting)
```

Depth matters for `$graphLookup`: most equipment sits 4 hops below the MSB
(MSB -> SMSB -> floor board -> sub-board -> equipment). Floor boards `DB-L{n}-01/02` are the north and
south wings (lighting, small power, department bed-head/clinical kit), `-03` is the department's
specialist board, `-04` is mechanical services (AHUs direct, pumps, fans, fan coils).

Tags: boards `DB-L5-02`, `DB-L5-02C`, `DB-L5-E`, `DB-L12-P1A` (no zero padding on the level); equipment
`${KIND}-L${level}-${seq}` with a 3-digit sequence per kind and level, e.g. `LTG-L5-014`, `THL-L5-003`.
There are 75 equipment kinds, from `LTG` lighting (0.5-2 kW) to `CT` scanners (~80 kW) and `CH`
chillers (~150 kW).

| Level | Department | Boards | Equipment | Critical |
| --- | --- | ---: | ---: | ---: |
| 0 | Energy centre & FM (MSB, sub-mains, plant, lifts) | 25 | 152 | 13 |
| 1 | Emergency Department | 21 | 308 | 10 |
| 2 | Imaging & Radiology (CT, MRI, X-ray on dedicated sub-boards) | 21 | 278 | 6 |
| 3 | Outpatients | 21 | 324 | 6 |
| 4 | Day Surgery (4 day theatres) | 21 | 312 | 20 |
| 5 | Operating Theatres (8 theatres) | 21 | 302 | 36 |
| 6 | Intensive Care Unit (bed-head power is critical) | 21 | 312 | 39 |
| 7 | Maternity (neonatal unit, 2 obstetric theatres) | 21 | 318 | 24 |
| 8 | Medical Wards (+ renal dialysis) | 21 | 305 | 10 |
| 9 | Surgical Wards | 21 | 333 | 10 |
| 10 | Pathology Labs | 21 | 319 | 15 |
| 11 | Administration | 21 | 313 | 6 |
| 12 | Estates, IT data centre & roof plant | 33 | 392 | 8 |
| | **Total** | **289** | **3,968** | **203** |

Critical kinds: emergency lighting `EM` (65), bed-head power in ICU `BHP` (22), nurse call `NC` (20),
theatre lights `THL`, surgical pendants `PEND` and anaesthetic machines `ANA` (14 each), fire alarm
panels `FA` (13), ventilator circuits `VENT` (9), incubators `INC` (8), UPS (6), lab freezers `FRZ` (6),
medical gas plant `MGP` (4) + alarm panel, blood bank fridges, sprinkler pumps, smoke extract fans and
the firefighting lift.

**Capacities** are sized bottom-up from the downstream load (everything is on): load divided by a random
utilisation of 45-85%, rounded up to a multiple of 5 kW below 100, 10 below 500 and 50 above. So every
board starts at or below 85%, except three.

### Shutdown example: isolate DB-L5-02 on Tuesday

`DB-L5-02` ("Level 5 theatres 1-4 distribution board", 190 kW, 70% loaded) feeds four sub-boards:
`DB-L5-02A` and `DB-L5-02C` (1-phase lighting & small power for theatres 1-2 and 3-4) and `DB-L5-02B`
and `DB-L5-02D` (3-phase clinical equipment), plus the theatres 1-4 UPS.

`GET /api/impact/DB-L5-02?site=hospital` should report **70 affected (4 boards, 66 equipment), 15
critical, 132.4 kW**:

| Critical item | Name | Fed from |
| --- | --- | --- |
| `UPS-L5-001` | Theatres 1-4 UPS | DB-L5-02 |
| `THL-L5-001`, `THL-L5-002` | Theatre 1 / 2 operating light | DB-L5-02A |
| `EM-L5-002` | Emergency lighting: theatres 1-2 | DB-L5-02A |
| `PEND-L5-001`, `PEND-L5-002` | Theatre 1 / 2 surgical pendant | DB-L5-02B |
| `ANA-L5-001`, `ANA-L5-002` | Anaesthetic machine: theatre 1 / 2 | DB-L5-02B |
| `THL-L5-003`, `THL-L5-004` | Theatre 3 / 4 operating light | DB-L5-02C |
| `EM-L5-003` | Emergency lighting: theatres 3-4 | DB-L5-02C |
| `PEND-L5-003`, `PEND-L5-004` | Theatre 3 / 4 surgical pendant | DB-L5-02D |
| `ANA-L5-003`, `ANA-L5-004` | Anaesthetic machine: theatre 3 / 4 | DB-L5-02D |

### The three overloaded boards

Exactly three leaf sub-boards are over capacity (none under DB-L5-02; everything upstream of them is
at or below 85%):

| Board | Name | Load | Capacity | Load % |
| --- | --- | ---: | ---: | ---: |
| `DB-L2-02A` | Level 2 lighting | 16.7 kW | 15 kW | 111% |
| `DB-L3-03C` | Level 3 eye & audiology clinics | 43.3 kW | 40 kW | 108% |
| `DB-L11-04C` | Level 11 heat pumps & supply fans | 68.0 kW | 65 kW | 105% |

### Change history (`events`)

About 1,360 events over the 7 days before `now`, shaped like CONTRACT.md 1.2 (`ts` is a `Date`, no `_id`
so MongoDB assigns one): `toggle` pairs (switched off, then back on), `load` changes ending at the
current `loadKW`, `rewire` moves ending at the item's current `parentId` (from a phase-compatible board
on the same level), and `trip`/`reset` pairs. The final state therefore matches the seeded nodes.
About 24% of events are on **Level 5**, where Northside M&E is the most active (the "what changed on
Level 5 this week, and who changed it?" question). ~90% fall in working hours (07:00-18:00 UK), with
fewer at weekends. `who` is one of: Northside M&E, Apex Electrical, BrightSpark Ltd, Facilities team,
Commissioning engineer, Site manager, Estates electrician.

## Cable schedule CSV

`POST /api/import` takes a cable schedule as CSV (`Content-Type: text/csv`). `data/messy-schedule.csv`
is the test case and `data/messy-schedule.expected.json` is the answer. The reference importer is
`parseSchedule(csvText, { existingNodes })` in `data/lib/schedule.js`; it is pure JS, so the backend can
import it as-is or use it as the test oracle:

```js
import { parseSchedule } from '../../data/lib/schedule.js';
const { total, valid, rejected } = parseSchedule(csvText, { existingNodes }); // existingNodes: node docs already in the DB
// valid: CONTRACT.md node documents, ready for insertMany. Respond { total, imported: valid.length, rejected, ms }.
```

With `replace=true`, pass nothing (the site is emptied first). Without it, pass the nodes already in the
site (`_id`, `type` and `phases` are enough): rows repeating them become `DUPLICATE_TAG`, rows may be fed
from them, and 3-phase rows fed from an existing single-phase board are `PHASE_MISMATCH`. (`existingIds`, a
set of tags, still works but skips the phase check against existing boards.)

### Columns

The first non-blank line is the header. Column names are matched case-insensitively and in any order;
extra columns are ignored. A missing required column (all but the last four) fails the whole import
(`400 BAD_REQUEST`).

| Column | Example | Meaning |
| --- | --- | --- |
| `tag` | `THL-L5-003` | The node `_id`. |
| `type` | `equipment` | `board` or `equipment`. |
| `kind` | `THL` | `MSB` / `SMSB` / `DB` for boards, a free code for equipment (stored upper-cased). |
| `description` | `Theatre 3 operating light` | Stored as `name`. |
| `fed_from` | `DB-L5-02C` | The feeding board's tag (`parentId`). Empty only for the `MSB`. |
| `level` | `5` | Integer >= 0. |
| `voltage` | `230` | `230` or `400`. |
| `phases` | `1` | `1` or `3`; 400 V must be 3-phase, 230 V single-phase. |
| `rated_kw` | `0.9` | Equipment nameplate rating (empty for boards). Becomes `ratedKW` and `loadKW`. |
| `capacity_kw` | `40` | Board rating (empty for equipment). Becomes `capacityKW`. |
| `critical` | `Y` | Equipment only. |
| `cable_ref`, `cable_size_mm2`, `cable_length_m`, `notes` | `C05-0091`, `2.5`, `48`, `moved per RFI-112` | Informational, not imported. |

Imported documents get `on: true`, `loadKW = ratedKW`, `critical`, `claimedBy: null` (equipment) or
`tripped: false` (boards), `parentId: null` for an empty `fed_from`, and `level`, `voltage`, `phases` as numbers.

### Normalisation (benign mess that must NOT cause a rejection)

- Every cell is trimmed (`"  DB-L5-02 "` is `DB-L5-02`).
- `type` is case-insensitive (`Equipment`, `BOARD`).
- `critical` is true for `y`, `yes`, `true` or `1` (any case) and false for anything else, including blank.
- Ratings are read with `parseFloat`, so `15kW`, ` 15 kW` and `0.8KW` all work.
- Blank lines (and lines of only commas/whitespace) are skipped and not counted in `total`.
- Fields may be quoted (`"Chiller 3 (air-cooled, roof)"`, `""` for a literal quote); CRLF or LF line
  endings; a UTF-8 BOM is ignored.
- Rows are **not** in parent-first order: a row may come before the board that feeds it. Resolve feeders
  after reading the whole file.

`row` in a rejection is the **line number in the file** (header = line 1), counting blank lines.

### Rejection codes

Each row gets at most one code. Per-row checks run first, in this order (the validator, then the unique
`_id`), then the graph checks once every row has been read:

| Code | When | `reason` example |
| --- | --- | --- |
| `UNKNOWN_TYPE` | `type` is not board/equipment | `unknown type "panel" (must be board or equipment)` |
| `INVALID_VOLTAGE` | voltage not 230/400, phases not 1/3, or voltage doesn't match phases | `invalid voltage 415 (must be 230 or 400)`, `230 V does not match 3-phase` |
| `MISSING_RATING` | equipment `rated_kw` (board `capacity_kw`) empty, not a number or <= 0 | `missing rated_kw` |
| `DUPLICATE_TAG` | tag already claimed by an earlier row, or already in the database. The first row that passes the checks above keeps the tag. | `duplicate tag SP-L4-031` |
| `CIRCULAR_FEED` | following `fed_from` loops back; every row in the loop is rejected | `feed loops back on itself (DB-L7-X1 -> DB-L7-X2 -> DB-L7-X1)` |
| `UNKNOWN_FEEDER` | `fed_from` is not a valid board in the file or the database; empty `fed_from` on anything but the MSB; feeder is equipment; feeder row was itself rejected | `unknown feeder DB-L14-01`, `feeder DB-L7-X1 was rejected` |
| `PHASE_MISMATCH` | a 3-phase row fed from a single-phase board | `DB-L5-02A is single-phase` |

`parseSchedule` also uses `INVALID_ROW` (missing tag, or a level that is not a whole number). It is not
in the contract and does not occur in the test file.

### Expected result for `messy-schedule.csv`

4,273 lines: the header, **4,269 data rows** and 3 blank lines (CRLF). The rows are the seeded hospital
(4,257 nodes, same seed) plus 24 deliberately bad rows, with benign mess sprinkled over the good ones
(80 padded cells, 60 odd-case types, 160 critical variants, 30 ratings with a `kW` suffix, ~200 rows
placed before their feeder).

```json
{ "total": 4269, "imported": 4245, "rejectedCount": 24,
  "byCode": { "MISSING_RATING": 6, "DUPLICATE_TAG": 5, "INVALID_VOLTAGE": 3, "UNKNOWN_TYPE": 2,
              "PHASE_MISMATCH": 3, "CIRCULAR_FEED": 3, "UNKNOWN_FEEDER": 2 } }
```

- 12 existing equipment rows are broken: 6 with a blank `rated_kw` (`LTG-L1-007`, ...), 3 with voltage
  415 / 240 / 110, and 3 three-phase items pointed at single-phase sub-boards (`AHU-L5-002` -> `DB-L5-02A`, ...).
- 12 extra rows: 5 repeats of existing equipment tags with a different description (`SP-L4-031`, ...),
  2 rows of type `panel` / `equip.`, 2 rows fed from `DB-L14-01` (no such board), and the temporary
  boards `DB-L7-X1` <-> `DB-L7-X2` and `DB-L9-X1` (fed from itself).
- No bad row has children, so nothing cascades: **importing with `replace=true` reproduces the seeded
  hospital exactly, minus the 12 broken equipment rows** (4,257 - 12 = 4,245). DB-L5-02 and the three
  overloaded boards are untouched, so the demo numbers above still hold after an import.

The full list of 24 rejections (row, tag, code, reason) is in `messy-schedule.expected.json`.
`npm run schedule` regenerates both files and fails loudly if the importer's output differs from what
was injected.
