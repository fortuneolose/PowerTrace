// The 60-node demo building used for the live audience segment.
// Pure data with no dependencies, so /backend, /mock and /bot can all import it.
//
//   MSB (main switchboard, L0)
//   ├── SMSB-A  ── DB-L1-01 (3ph), DB-L1-02 (1ph), DB-L2-01 (3ph), CH-01
//   ├── SMSB-B  ── DB-L2-02 (1ph), DB-L3-01 (3ph), DB-L3-02 (1ph), LIFT-01, EV-02
//   └── SPR-01  (sprinkler pump, critical, standby)
//
// Demo beats this data is tuned for:
//   - DB-L3-01 starts around two-thirds loaded, so a few "+5 kW" taps push it into the red.
//   - DB-L2-02 is single-phase, so re-wiring AHU-07 (3-phase) onto it is rejected.
//   - Tripping SMSB-B takes out roughly half the building.

const board = (_id, kind, name, parentId, level, phases, capacityKW) => ({
  _id,
  type: 'board',
  kind,
  name,
  parentId,
  level,
  voltage: phases === 3 ? 400 : 230,
  phases,
  capacityKW,
  tripped: false,
});

const equip = (_id, kind, name, parentId, level, phases, ratedKW, on, critical = false) => ({
  _id,
  type: 'equipment',
  kind,
  name,
  parentId,
  level,
  voltage: phases === 3 ? 400 : 230,
  phases,
  ratedKW,
  loadKW: ratedKW,
  on,
  critical,
  claimedBy: null,
});

export const demoNodes = [
  // Boards
  board('MSB', 'MSB', 'Main switchboard', null, 0, 3, 300),
  board('SMSB-A', 'SMSB', 'Sub-main switchboard A (west riser)', 'MSB', 0, 3, 160),
  board('SMSB-B', 'SMSB', 'Sub-main switchboard B (east riser)', 'MSB', 0, 3, 120),
  board('DB-L1-01', 'DB', 'Level 1 mechanical distribution board', 'SMSB-A', 1, 3, 60),
  board('DB-L1-02', 'DB', 'Level 1 lighting & small power', 'SMSB-A', 1, 1, 20),
  board('DB-L2-01', 'DB', 'Level 2 mechanical distribution board', 'SMSB-A', 2, 3, 60),
  board('DB-L2-02', 'DB', 'Level 2 lighting & small power', 'SMSB-B', 2, 1, 20),
  board('DB-L3-01', 'DB', 'Level 3 mechanical distribution board', 'SMSB-B', 3, 3, 60),
  board('DB-L3-02', 'DB', 'Level 3 lighting & small power', 'SMSB-B', 3, 1, 20),

  // Large plant fed straight from the main and sub-main boards
  equip('SPR-01', 'PMP', 'Sprinkler pump (standby)', 'MSB', 0, 3, 15, false, true),
  equip('CH-01', 'CH', 'Chiller', 'SMSB-A', 0, 3, 45, true),
  equip('LIFT-01', 'LIFT', 'Passenger lift', 'SMSB-B', 0, 3, 11, true),
  equip('EV-02', 'EV', 'EV rapid charger', 'SMSB-B', 0, 3, 22, false),

  // DB-L1-01 (3-phase, 60 kW)
  equip('AHU-01', 'AHU', 'Air handling unit', 'DB-L1-01', 1, 3, 11, true),
  equip('AHU-02', 'AHU', 'Air handling unit', 'DB-L1-01', 1, 3, 11, false),
  equip('PMP-01', 'PMP', 'Chilled water pump', 'DB-L1-01', 1, 3, 5.5, true),
  equip('PMP-02', 'PMP', 'Heating pump', 'DB-L1-01', 1, 3, 4, true),
  equip('EF-01', 'EF', 'Car park extract fan', 'DB-L1-01', 1, 3, 3, true),
  equip('KIT-01', 'KIT', 'Kitchen combi oven', 'DB-L1-01', 1, 3, 9, false),
  equip('EV-01', 'EV', 'EV charger', 'DB-L1-01', 1, 1, 7.4, false),
  equip('CCTV-01', 'CCTV', 'CCTV recorder', 'DB-L1-01', 1, 1, 0.5, true),

  // DB-L1-02 (single-phase, 20 kW)
  equip('LTG-L1-01', 'LTG', 'Lighting: reception', 'DB-L1-02', 1, 1, 1.2, true),
  equip('LTG-L1-02', 'LTG', 'Lighting: café', 'DB-L1-02', 1, 1, 1, true),
  equip('SP-L1-01', 'SP', 'Small power: reception', 'DB-L1-02', 1, 1, 2.5, true),
  equip('SP-L1-02', 'SP', 'Small power: café', 'DB-L1-02', 1, 1, 3, false),
  equip('HW-01', 'HW', 'Water heater', 'DB-L1-02', 1, 1, 3, true),
  equip('HD-01', 'HD', 'Hand dryer', 'DB-L1-02', 1, 1, 2, false),
  equip('EM-L1-01', 'EM', 'Emergency lighting', 'DB-L1-02', 1, 1, 0.4, true, true),
  equip('FA-01', 'FA', 'Fire alarm panel', 'DB-L1-02', 1, 1, 0.3, true, true),
  equip('VEND-01', 'VEND', 'Vending machine', 'DB-L1-02', 1, 1, 0.8, true),

  // DB-L2-01 (3-phase, 60 kW)
  equip('AHU-03', 'AHU', 'Air handling unit', 'DB-L2-01', 2, 3, 11, true),
  equip('AHU-04', 'AHU', 'Air handling unit', 'DB-L2-01', 2, 3, 7.5, false),
  equip('CRAC-01', 'CRAC', 'Comms room cooling', 'DB-L2-01', 2, 3, 7, true),
  equip('SRV-01', 'SRV', 'Server rack (comms room)', 'DB-L2-01', 2, 1, 4, true, true),
  equip('FCU-L2-01', 'FCU', 'Fan coil units: open office', 'DB-L2-01', 2, 1, 2.5, true),
  equip('SP-L2-01', 'SP', 'Small power: open office', 'DB-L2-01', 2, 1, 4, true),
  equip('LTG-L2-01', 'LTG', 'Lighting: open office', 'DB-L2-01', 2, 1, 2, true),

  // DB-L2-02 (single-phase, 20 kW): the board 3-phase kit gets rejected from
  equip('LTG-L2-02', 'LTG', 'Lighting: meeting rooms', 'DB-L2-02', 2, 1, 1.2, true),
  equip('SP-L2-02', 'SP', 'Small power: meeting rooms', 'DB-L2-02', 2, 1, 2.5, true),
  equip('AV-01', 'AV', 'AV equipment', 'DB-L2-02', 2, 1, 1.5, false),
  equip('HW-02', 'HW', 'Water heater', 'DB-L2-02', 2, 1, 3, true),
  equip('KET-01', 'KET', 'Boiling-water tap', 'DB-L2-02', 2, 1, 3, false),
  equip('EM-L2-01', 'EM', 'Emergency lighting', 'DB-L2-02', 2, 1, 0.4, true, true),
  equip('PRN-01', 'PRN', 'Printer bank', 'DB-L2-02', 2, 1, 1.5, true),

  // DB-L3-01 (3-phase, 60 kW): the board that goes red
  equip('AHU-07', 'AHU', 'Air handling unit', 'DB-L3-01', 3, 3, 15, true),
  equip('AHU-08', 'AHU', 'Air handling unit', 'DB-L3-01', 3, 3, 11, false),
  equip('PMP-03', 'PMP', 'Condenser water pump', 'DB-L3-01', 3, 3, 5.5, true),
  equip('EF-02', 'EF', 'Toilet extract fan', 'DB-L3-01', 3, 3, 2.2, true),
  equip('HP-01', 'HP', 'Heat pump', 'DB-L3-01', 3, 3, 8, true),
  equip('FUM-01', 'FUM', 'Fume cupboard extract', 'DB-L3-01', 3, 3, 5.5, true),
  equip('FCU-L3-01', 'FCU', 'Fan coil units: labs', 'DB-L3-01', 3, 1, 2.5, true),
  equip('SP-L3-01', 'SP', 'Small power: labs', 'DB-L3-01', 3, 1, 3, false),
  equip('LTG-L3-01', 'LTG', 'Lighting: labs', 'DB-L3-01', 3, 1, 1.5, true),

  // DB-L3-02 (single-phase, 20 kW)
  equip('LTG-L3-02', 'LTG', 'Lighting: meeting rooms', 'DB-L3-02', 3, 1, 1.2, true),
  equip('SP-L3-02', 'SP', 'Small power: breakout', 'DB-L3-02', 3, 1, 2.5, true),
  equip('FCU-L3-02', 'FCU', 'Fan coil units: breakout', 'DB-L3-02', 3, 1, 1.5, true),
  equip('EM-L3-01', 'EM', 'Emergency lighting', 'DB-L3-02', 3, 1, 0.4, true, true),
  equip('HW-03', 'HW', 'Water heater', 'DB-L3-02', 3, 1, 3, false),
  equip('HD-02', 'HD', 'Hand dryer', 'DB-L3-02', 3, 1, 2, true),
  equip('ACC-01', 'ACC', 'Access control panel', 'DB-L3-02', 3, 1, 0.3, true),
];

// Fresh deep copies, so callers can mutate freely (the mock server keeps them in memory).
export function getDemoNodes() {
  return demoNodes.map((n) => ({ ...n }));
}

export default demoNodes;
