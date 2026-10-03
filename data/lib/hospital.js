// Synthetic 12-storey hospital for the scale segment: ~290 boards, ~4,000 pieces of equipment and a
// week of change history. Pure and deterministic (no I/O, no Math.random): the same seed and `now`
// always give exactly the same output. Node documents follow CONTRACT.md section 1.1.
//
//   MSB (L0, the only root)
//   ├── SMSB-A  riser 1 ── DB-L1-01..04 .. DB-L4-01..04   (each floor board ── 4 sub-boards A..D)
//   ├── SMSB-B  riser 2 ── DB-L5-01..04 .. DB-L8-01..04
//   ├── SMSB-C  riser 3 ── DB-L9-01..04 .. DB-L12-01..04
//   ├── SMSB-M  mechanical plant ── DB-L0-01..06 (2 sub-boards each), DB-L12-P1..P4 roof plant (2 each)
//   ├── SMSB-E  essential / life-safety ── DB-L1-E .. DB-L12-E (+ fire alarm, smoke extract)
//   └── SMSB-L  lifts ── 12 lifts
//
// Demo beats this data is tuned for:
//   - Level 5 is Operating Theatres. DB-L5-02 feeds theatres 1-4 through four sub-boards, so isolating
//     it ("shutdown on Tuesday") flags theatre operating lights, emergency lighting, pendants, ...
//   - Exactly three leaf sub-boards (never under DB-L5-02) are over capacity at 104-115%.
//   - Change history is weighted to Level 5 ("what changed on Level 5 this week, and who changed it?").

import { createRng, round, DEFAULT_SEED } from './rng.js';
import { indexNodes, downstream } from './graph.js';

export const DEPARTMENTS = {
  0: 'Energy centre & FM',
  1: 'Emergency Department',
  2: 'Imaging & Radiology',
  3: 'Outpatients',
  4: 'Day Surgery',
  5: 'Operating Theatres',
  6: 'Intensive Care Unit',
  7: 'Maternity',
  8: 'Medical Wards',
  9: 'Surgical Wards',
  10: 'Pathology Labs',
  11: 'Administration',
  12: 'Estates, IT & roof plant',
};

// The board the shutdown-report demo isolates.
export const SHUTDOWN_DEMO_BOARD = 'DB-L5-02';

// ---------------------------------------------------------------------------------------------
// Equipment catalogue. kw: [min, max] range, or pick: discrete ratings (standard motor sizes).
// ---------------------------------------------------------------------------------------------

const KINDS = {
  LTG: { label: 'Lighting', ph: 1, kw: [0.5, 2] },
  EM: { label: 'Emergency lighting', ph: 1, kw: [0.2, 0.5], dp: 2, critical: true },
  SP: { label: 'Small power', ph: 1, kw: [1.5, 3.5] },
  BHP: { label: 'Bed-head power', ph: 1, kw: [1.5, 3] },
  NC: { label: 'Nurse call system', ph: 1, kw: [0.2, 0.6], dp: 2, critical: true },
  FA: { label: 'Fire alarm panel', ph: 1, kw: [0.2, 0.5], dp: 2, critical: true },
  FCU: { label: 'Fan coil units', ph: 1, kw: [0.8, 2.5] },
  TEF: { label: 'Toilet extract fan', ph: 1, kw: [0.2, 0.6], dp: 2 },
  EF: { labels: ['General extract fan', 'Dirty utility extract fan', 'Kitchen extract fan', 'Isolation room extract fan', 'Plant room extract fan'], ph: 3, pick: [0.75, 1.1, 1.5, 2.2, 3, 4] },
  SF: { label: 'Supply fan', ph: 3, pick: [1.1, 1.5, 2.2, 3, 4] },
  AHU: { label: 'Air handling unit', ph: 3, pick: [7.5, 11, 15, 18.5, 22] },
  PMP: { labels: ['Chilled water pump', 'LTHW heating pump', 'Cold water booster pump', 'DHW secondary pump', 'Condenser water pump'], ph: 3, pick: [2.2, 3, 4, 5.5, 7.5, 11] },
  HP: { label: 'Heat pump', ph: 3, pick: [5.5, 7.5, 11, 15] },
  PRS: { label: 'Pressurisation unit', ph: 1, kw: [0.5, 1.5] },
  HW: { label: 'Water heater', ph: 1, kw: [2, 3] },
  IHW: { label: 'Instantaneous water heater', ph: 3, pick: [9, 10.8, 12] },
  HD: { label: 'Hand dryer', ph: 1, kw: [1.2, 2.2] },
  BEV: { label: 'Beverage bay', ph: 1, kw: [2, 3] },
  ACC: { label: 'Access control panel', ph: 1, kw: [0.2, 0.5], dp: 2 },
  CCTV: { label: 'CCTV', ph: 1, kw: [0.2, 0.6], dp: 2 },
  DATA: { label: 'Comms cabinet', ph: 1, kw: [1, 3] },
  BMS: { label: 'BMS outstation', ph: 1, kw: [0.3, 1] },
  FRG: { label: 'Medicines fridge', ph: 1, kw: [0.2, 0.5], dp: 2 },
  MON: { label: 'Patient monitoring', ph: 1, kw: [0.3, 0.8] },
  UPS: { label: 'UPS', ph: 3, kw: [10, 40], dp: 0, critical: true },
  VENT: { label: 'Ventilator circuit', ph: 1, kw: [0.4, 1], critical: true },
  INC: { label: 'Neonatal incubator', ph: 1, kw: [0.4, 0.8], critical: true },
  FRZ: { label: 'Ultra-low freezer (-80 °C)', ph: 1, kw: [1, 1.8], critical: true },
  BBF: { label: 'Blood bank fridge', ph: 1, kw: [0.5, 1.2], critical: true },
  ANZ: { label: 'Analyser', ph: 1, kw: [1.5, 3] },
  FUM: { label: 'Fume cupboard', ph: 3, pick: [1.1, 1.5, 2.2, 3] },
  CEN: { label: 'Centrifuge', ph: 1, kw: [0.8, 2] },
  LAB: { label: 'Lab bench power', ph: 1, kw: [1.5, 3] },
  CT: { label: 'CT scanner', ph: 3, kw: [78, 85], dp: 0 },
  MRI: { label: 'MRI scanner', ph: 3, kw: [55, 65], dp: 0 },
  XR: { label: 'X-ray room', ph: 3, kw: [25, 35], dp: 0 },
  FLU: { label: 'Fluoroscopy suite', ph: 3, kw: [40, 50], dp: 0 },
  MAM: { label: 'Mammography unit', ph: 1, kw: [3, 5] },
  US: { label: 'Ultrasound', ph: 1, kw: [0.5, 1.2] },
  INJ: { label: 'Contrast injector', ph: 1, kw: [0.3, 0.6], dp: 2 },
  HEC: { label: 'MRI helium compressor', ph: 3, pick: [7.5, 9, 11] },
  IMG: { label: 'Mobile image intensifier', ph: 1, kw: [1.5, 2.5] },
  THL: { label: 'Operating light', ph: 1, kw: [0.8, 1.5], critical: true },
  PEND: { label: 'Surgical pendant', ph: 1, kw: [1, 2], critical: true },
  ANA: { label: 'Anaesthetic machine', ph: 1, kw: [0.5, 1], critical: true },
  DTH: { label: 'Diathermy unit', ph: 1, kw: [0.3, 0.6], dp: 2 },
  WRM: { label: 'Warming cabinet', ph: 1, kw: [0.4, 0.8] },
  ENDO: { label: 'Endoscopy stack', ph: 1, kw: [0.6, 1.2] },
  UCV: { label: 'Ultra-clean ventilation canopy', ph: 3, pick: [3, 4, 5.5] },
  DIA: { label: 'Dialysis machine', ph: 1, kw: [2, 3] },
  RO: { label: 'RO water treatment plant', ph: 3, pick: [5.5, 7.5, 11] },
  STR: { label: 'Steam steriliser', ph: 3, pick: [18, 24, 36] },
  WD: { label: 'Washer-disinfector', ph: 3, pick: [9, 12, 18] },
  KIT: { labels: ['Combi oven', 'Bratt pan', 'Fryer', 'Induction range', 'Pass-through dishwasher', 'Steam kettle'], ph: 3, kw: [6, 20], dp: 0 },
  CR: { label: 'Cold room', ph: 3, pick: [2.2, 3, 4, 5.5] },
  MOR: { label: 'Mortuary refrigeration', ph: 3, pick: [3, 4, 5.5] },
  LIFT: { label: 'Lift', ph: 3, pick: [11, 15, 18.5] },
  CH: { label: 'Chiller', ph: 3, kw: [140, 165], dp: 0 },
  BLR: { label: 'Boiler burner & controls', ph: 3, pick: [3, 4, 5.5, 7.5] },
  MGP: { label: 'Medical gas plant', ph: 3, pick: [7.5, 11, 15, 18.5, 22], critical: true },
  MGA: { label: 'Medical gas alarm panel', ph: 1, kw: [0.2, 0.4], dp: 2, critical: true },
  AGS: { label: 'Anaesthetic gas scavenging plant', ph: 3, pick: [1.5, 2.2, 3] },
  SPR: { label: 'Sprinkler pump', ph: 3, pick: [37, 45], critical: true },
  SMK: { label: 'Smoke extract fan', ph: 3, pick: [11, 15], critical: true },
  PTS: { label: 'Pneumatic tube blower', ph: 3, pick: [4, 5.5, 7.5] },
  CMP: { label: 'Waste compactor', ph: 3, pick: [7.5, 11] },
  EV: { label: 'EV charger', ph: 1, kw: [7.4, 7.4] },
  SRV: { label: 'Server rack', ph: 1, kw: [3, 6] },
  CRAC: { label: 'Close-control cooling unit', ph: 3, pick: [7.5, 11, 15] },
  PRN: { label: 'Printer bank', ph: 1, kw: [1, 1.5] },
  VEND: { label: 'Vending machine', ph: 1, kw: [0.5, 1] },
  WRK: { label: 'Workshop machinery', ph: 3, pick: [3, 4, 5.5, 7.5] },
  PHR: { label: 'Pharmacy dispensing robot', ph: 3, pick: [5.5, 7.5] },
  WSR: { label: 'Water softener', ph: 1, kw: [0.3, 0.6], dp: 2 },
  TRC: { label: 'Trace heating', ph: 1, kw: [0.5, 1.5] },
};

// Generic sub-board fills.
const FILL = {
  lighting: { LTG: 10, ACC: 0.6, CCTV: 0.6 },
  smallPower: { SP: 9, HW: 1, HD: 1, BEV: 0.6, DATA: 0.5 },
  fcu: { FCU: 9, TEF: 2, BMS: 1 },
  mech: { PMP: 4, EF: 4, SF: 1.5, HP: 1.2, FCU: 2, BMS: 0.6, PRS: 0.5 },
};

// sub-board spec: phases, label, must-have items [[kind, count, overrides]], weighted fill, item count range
const sb = (ph, label, must = [], fill = {}, n = [16, 19], extra = {}) => ({ ph, label, must, fill, n, ...extra });

const STD = {
  lighting: (wing) => sb(1, 'lighting', [['EM', 1, named(() => `Emergency lighting: ${wing}`)]], FILL.lighting),
  smallPower: () => sb(1, 'small power', [], FILL.smallPower),
  mech: (label = 'mechanical services') => sb(3, label, [], FILL.mech),
  fcu: () => sb(1, 'fan coil units & controls', [], FILL.fcu),
};

const named = (fn) => ({ name: fn });

// Theatres: four sub-boards per four theatres; theatre lights + emergency lighting on the 1-phase
// lighting sub-boards, pendants and anaesthetic machines on the 3-phase equipment sub-boards.
function theatreSubs(first, prefix = 'Theatre', withEm = true) {
  const pair = (a) => {
    const b = a + 1;
    const areas = [`${prefix} ${a}`, `${prefix} ${b}`, `Anaesthetic room ${a}`, `Anaesthetic room ${b}`, `Scrub ${a}-${b}`, `${prefix} corridor`];
    const lighting = sb(
      1,
      `${prefix.toLowerCase()}s ${a}-${b} lighting & small power`,
      [
        ['THL', 2, named((i) => `${prefix} ${a + i - 1} operating light`)],
        ...(withEm ? [['EM', 1, named(() => `Emergency lighting: ${prefix.toLowerCase()}s ${a}-${b}`)]] : []),
      ],
      { LTG: 5, SP: 4, WRM: 0.6, FRG: 0.4 },
      [15, 18],
      { areas },
    );
    const equipment = sb(
      3,
      `${prefix.toLowerCase()}s ${a}-${b} clinical equipment`,
      [
        ['PEND', 2, named((i) => `${prefix} ${a + i - 1} surgical pendant`)],
        ['ANA', 2, named((i) => `Anaesthetic machine: ${prefix.toLowerCase()} ${a + i - 1}`)],
        ['DTH', 2, named((i) => `Diathermy unit: ${prefix.toLowerCase()} ${a + i - 1}`)],
      ],
      { MON: 2, WRM: 1, ENDO: 1, IMG: 0.7, SP: 2, IHW: 0.4 },
      [15, 18],
      { areas },
    );
    return [lighting, equipment];
  };
  return [...pair(first), ...pair(first + 2)];
}

// ---------------------------------------------------------------------------------------------
// Level layout. Floor boards 01/02 = wings ([lighting, small power, c1 (1-ph clinical), c3 (3-ph)]),
// 03 = department specialist services, 04 = mechanical services (AHUs direct + 4 sub-boards).
// ---------------------------------------------------------------------------------------------

const LEVELS = {
  1: {
    areas: ['Majors', 'Minors', 'Resus', 'Triage', 'Paediatric ED', 'Waiting room', 'Main entrance', 'Ambulance entrance', 'CDU', 'Plaster room', 'Staff base', 'Relatives room', 'See & treat'],
    c1: sb(1, 'cubicles bed-head & nurse call', [['NC', 1]], { BHP: 7, MON: 2, SP: 2, FRG: 0.4 }),
    c3: sb(3, 'treatment equipment', [['IHW', 1]], { BHP: 3, MON: 2, SP: 3, FRG: 0.5, EF: 0.8 }),
    special: {
      role: 'resus, X-ray & ambulance services',
      subs: [
        sb(3, 'resus bays', [['VENT', 2, named((i) => `Ventilator circuit: resus bay ${i}`)]], { BHP: 4, MON: 3, SP: 2, FRG: 0.5, IMG: 0.5 }),
        sb(3, 'ED X-ray rooms', [['XR', 2, named((i) => `ED X-ray room ${i}`)], ['US', 1]], { SP: 2, LTG: 1 }, [5, 7]),
        sb(1, 'reception & waiting', [], { SP: 4, LTG: 3, VEND: 1, DATA: 1, CCTV: 1, ACC: 1 }),
        sb(3, 'ambulance bay & decontamination', [['EV', 2, named((i) => `Ambulance charger: bay ${i}`)], ['IHW', 2, named((i) => `Decontamination shower heater ${i}`)]], { LTG: 3, SP: 2, EF: 1, CCTV: 1, ACC: 1 }),
      ],
    },
    ahu: 2,
  },
  2: {
    areas: ['CT suite', 'MRI suite', 'X-ray rooms', 'Fluoroscopy', 'Ultrasound', 'Mammography', 'Reporting room', 'Patient waiting', 'Changing cubicles', 'Imaging recovery bays', 'Control room', 'Reception'],
    c1: sb(1, 'reporting & patient areas', [], { SP: 6, LTG: 2, US: 1, DATA: 1.2, FRG: 0.3 }),
    c3: sb(3, 'imaging support equipment', [], { SP: 4, US: 1, DATA: 1.5, IMG: 0.6, MON: 1, EF: 0.5 }),
    special: {
      role: 'imaging modalities',
      subs: [
        sb(3, 'CT scanners', [['CT', 2, named((i) => `CT scanner ${i}`)], ['INJ', 2, named((i) => `Contrast injector: CT ${i}`)], ['CRAC', 1, named(() => 'CT equipment room cooling')]], { SP: 2, LTG: 1 }, [6, 8]),
        sb(3, 'MRI scanner', [['MRI', 1, named(() => 'MRI scanner (3T)')], ['HEC', 1], ['CRAC', 1, named(() => 'MRI equipment room cooling')], ['INJ', 1, named(() => 'Contrast injector: MRI')]], { SP: 2, LTG: 1 }, [6, 8]),
        sb(3, 'X-ray rooms', [['XR', 3, named((i) => `X-ray room ${i}`)]], { SP: 2, LTG: 1, DATA: 0.5 }, [6, 8]),
        sb(3, 'fluoroscopy & mammography', [['FLU', 1, named(() => 'Fluoroscopy suite')], ['MAM', 1], ['US', 2, named((i) => `Ultrasound room ${i}`)]], { SP: 2, LTG: 1 }, [6, 8]),
      ],
    },
    ahu: 2,
  },
  3: {
    areas: ['Clinic A', 'Clinic B', 'Clinic C', 'Clinic D', 'Phlebotomy', 'Main waiting', 'Consulting rooms 1-8', 'Consulting rooms 9-16', 'Treatment rooms', 'Audiology', 'Eye clinic', 'Reception', 'Outpatient pharmacy'],
    c1: sb(1, 'clinic rooms', [], { SP: 6, LTG: 2, US: 0.5, FRG: 0.5, DATA: 0.5 }),
    c3: sb(3, 'treatment rooms', [], { SP: 4, IHW: 0.5, ENDO: 0.5, US: 0.5, EF: 0.5, FRG: 0.5, LTG: 1 }),
    special: {
      role: 'pharmacy & clinic services',
      subs: [
        sb(1, 'phlebotomy', [], { SP: 4, FRG: 3, CEN: 1, DATA: 1, LTG: 1 }),
        sb(3, 'outpatient pharmacy', [['PHR', 1]], { SP: 4, FRG: 2, DATA: 1, LTG: 1 }),
        sb(1, 'eye & audiology clinics', [], { SP: 5, LTG: 2, DATA: 1 }),
        sb(1, 'main waiting & reception', [], { SP: 3, LTG: 3, VEND: 1, CCTV: 1, ACC: 1, DATA: 1 }),
      ],
    },
    ahu: 2,
  },
  4: {
    areas: ['Admissions lounge', 'Pre-op assessment', 'Stage 1 recovery', 'Stage 2 recovery', 'Discharge lounge', 'Endoscopy', 'Clean utility', 'Dirty utility', 'Staff change', 'Day theatres corridor', 'Reception', 'Consulting rooms'],
    c1: sb(1, 'pre-op & recovery bed-head & nurse call', [['NC', 1]], { BHP: 7, MON: 2, SP: 2 }),
    c3: sb(3, 'day-case equipment', [], { SP: 3, ENDO: 1, MON: 1, WRM: 1, IHW: 0.3, WD: 0.3 }),
    special: { role: 'day theatres 1-4', subs: theatreSubs(1, 'Day theatre', false) },
    ahu: 2,
  },
  5: {
    areas: ['Theatre corridor', 'Recovery', 'Holding bay', 'Theatre store', 'Sterile store', 'Staff base', 'Coffee room', 'Clean utility', 'Dirty utility', 'Theatre reception', 'Changing rooms', 'Seminar room'],
    c1: sb(1, 'recovery bed-head & nurse call', [['NC', 1]], { BHP: 7, MON: 3, SP: 2 }),
    c3: sb(3, 'theatre support equipment', [], { SP: 3, WRM: 1, IHW: 0.5, WD: 0.5, FRG: 0.6, MON: 1 }),
    // DB-L5-01 is the wing board; 02 and 03 are theatres 1-4 and 5-8; 04 is mechanical with UCV.
    boards: {
      '02': { role: 'theatres 1-4', subs: theatreSubs(1), direct: [['UPS', 1, { name: 'Theatres 1-4 UPS', kw: 20 }]] },
      '03': { role: 'theatres 5-8', subs: theatreSubs(5), direct: [['UPS', 1, { name: 'Theatres 5-8 UPS', kw: 20 }]] },
    },
    mechC: sb(3, 'ultra-clean ventilation', [['UCV', 8, named((i) => `Ultra-clean ventilation canopy: theatre ${i}`)]], { BMS: 1, EF: 1 }, [10, 12]),
    ahu: 4,
  },
  6: {
    areas: ['ICU bed spaces 1-6', 'ICU bed spaces 7-12', 'HDU bays', 'Isolation rooms', 'Nurse base', 'Relatives room', 'Equipment store', 'Clean utility', 'Dirty utility', 'Seminar room', 'Staff rest', 'Corridor'],
    critKinds: ['BHP'], // ICU bed-head power must stay on
    c1: sb(1, 'bed spaces bed-head & nurse call', [['NC', 1]], { BHP: 6, VENT: 2.5, MON: 3, SP: 1 }),
    c3: sb(3, 'bed spaces equipment', [], { MON: 4, SP: 3, DIA: 1, IHW: 0.3, WRM: 0.5 }),
    special: {
      role: 'critical care services',
      subs: [
        sb(3, 'critical supplies', [['UPS', 1, { name: 'ICU UPS', kw: 30 }], ['VENT', 3, named((i) => `Ventilator circuit: isolation ${i}`)]], { MON: 3, SP: 2, DIA: 1 }),
        sb(1, 'isolation rooms', [['NC', 1]], { BHP: 5, MON: 2, SP: 2, TEF: 1 }),
        sb(1, 'nurse base & relatives', [], { SP: 5, LTG: 3, DATA: 1, BEV: 1, FRG: 1 }),
        sb(3, 'equipment store & utilities', [], { SP: 4, WD: 1, IHW: 1, EF: 1, FRG: 1 }),
      ],
    },
    ahu: 2,
  },
  7: {
    areas: ['Delivery suite', 'Birth rooms 1-6', 'Birth rooms 7-12', 'Neonatal unit', 'Postnatal ward', 'Antenatal clinic', 'Maternity triage', 'Midwives base', 'Milk kitchen', 'Family room', 'Obstetric theatres corridor', 'Reception'],
    c1: sb(1, 'birth rooms bed-head & nurse call', [['NC', 1]], { BHP: 7, MON: 2, SP: 2 }),
    c3: sb(3, 'delivery equipment', [], { SP: 3, MON: 2, WRM: 1, IHW: 0.4, BEV: 0.5 }),
    special: {
      role: 'neonatal & obstetric theatres',
      subs: [
        sb(1, 'neonatal unit cots', [['INC', 8, named((i) => `Neonatal incubator: cot ${i}`)], ['NC', 1]], { MON: 3, SP: 2, FRG: 1 }),
        sb(1, 'obstetric theatres lighting', [['THL', 2, named((i) => `Obstetric theatre ${i} operating light`)]], { LTG: 6, SP: 4 }),
        sb(3, 'obstetric theatres equipment', [['PEND', 2, named((i) => `Obstetric theatre ${i} surgical pendant`)], ['ANA', 2, named((i) => `Anaesthetic machine: obstetric theatre ${i}`)]], { MON: 2, DTH: 2, WRM: 2, SP: 2 }),
        sb(1, 'postnatal ward', [['NC', 1]], { BHP: 7, SP: 3, LTG: 2 }),
      ],
    },
    ahu: 2,
  },
  8: {
    areas: ['Ward 8A', 'Ward 8B', 'Ward 8C', 'Ward 8D', 'Day room', 'Nurse base', 'Treatment room', 'Sluice', 'Ward kitchen', 'Side rooms', 'Renal unit', 'Corridor'],
    c1: sb(1, 'ward bed-head & nurse call', [['NC', 1]], { BHP: 7, SP: 2, LTG: 1 }),
    c3: sb(3, 'ward support', [], { SP: 3, IHW: 0.5, WD: 0.5, BEV: 1, FRG: 1, EF: 0.5 }),
    special: {
      role: 'renal & ward services',
      subs: [
        sb(1, 'renal dialysis unit', [['NC', 1]], { DIA: 8, MON: 2, SP: 2 }),
        sb(3, 'dialysis water treatment', [['RO', 1, named(() => 'Dialysis RO water treatment plant')]], { PMP: 1, SP: 2, WSR: 1, BMS: 0.5 }, [8, 10]),
        sb(1, 'wards 8C-8D bed-head & nurse call', [['NC', 1]], { BHP: 7, SP: 2, LTG: 1 }),
        sb(1, 'day room & ward kitchens', [], { BEV: 3, SP: 4, LTG: 2, FRG: 1, VEND: 0.5 }),
      ],
    },
    ahu: 2,
  },
  9: {
    areas: ['Ward 9A', 'Ward 9B', 'Ward 9C', 'Ward 9D', 'Day room', 'Nurse base', 'Treatment room', 'Sluice', 'Ward kitchen', 'Side rooms', 'Discharge lounge', 'Corridor'],
    c1: sb(1, 'ward bed-head & nurse call', [['NC', 1]], { BHP: 7, SP: 2, LTG: 1 }),
    c3: sb(3, 'ward support', [], { SP: 3, IHW: 0.5, WD: 0.5, BEV: 1, FRG: 1, EF: 0.5 }),
    special: {
      role: 'surgical ward services',
      subs: [
        sb(1, 'wards 9C-9D bed-head & nurse call', [['NC', 1]], { BHP: 7, SP: 2, LTG: 1 }),
        sb(1, 'side rooms bed-head & nurse call', [['NC', 1]], { BHP: 6, SP: 2, TEF: 1 }),
        sb(1, 'day room & ward kitchens', [], { BEV: 3, SP: 4, LTG: 2, FRG: 1, VEND: 0.5 }),
        sb(3, 'treatment rooms & sluices', [], { SP: 3, WD: 1, IHW: 1, EF: 1, FRG: 1 }),
      ],
    },
    ahu: 2,
  },
  10: {
    areas: ['Blood sciences', 'Microbiology', 'Histopathology', 'Haematology', 'Blood bank', 'Specimen reception', 'Molecular lab', 'Media prep', 'Lab offices', 'Wash-up', 'Cold room', 'Corridor'],
    c1: sb(1, 'lab bench power', [], { LAB: 6, CEN: 2, FRG: 1, ANZ: 1, SP: 1 }),
    c3: sb(3, 'lab equipment', [], { ANZ: 3, FUM: 1.5, CEN: 1, LAB: 2, IHW: 0.3 }),
    special: {
      role: 'blood sciences & cold store',
      subs: [
        sb(3, 'blood sciences automation', [['ANZ', 2, { ph: 3, kw: [8, 12], name: (i) => `Blood sciences automation track ${i}` }]], { ANZ: 6, CEN: 2, LAB: 2 }),
        sb(1, 'cold store & freezers', [['FRZ', 6, named((i) => `Ultra-low freezer ${i} (-80 °C)`)]], { FRG: 3, LAB: 2 }),
        sb(1, 'blood bank', [['BBF', 2, named((i) => `Blood bank fridge ${i}`)]], { FRG: 2, CEN: 2, LAB: 3, ANZ: 1, SP: 2 }),
        sb(3, 'containment level 3 suite', [], { FUM: 3, CEN: 1, LAB: 3, EF: 1, IHW: 0.3 }),
      ],
      direct: [['UPS', 1, { name: 'Pathology UPS', kw: 20 }]],
    },
    ahu: 2,
  },
  11: {
    areas: ['Open-plan office north', 'Open-plan office south', 'Boardroom', 'Meeting rooms', 'Medical records', 'Education centre', 'Library', 'Staff restaurant', 'Print room', 'Hot-desk area', 'Break-out', 'Reception'],
    c1: sb(1, 'office small power', [], { SP: 8, PRN: 1, DATA: 1, BEV: 0.5 }),
    c3: sb(3, 'office services', [], { SP: 4, BEV: 1, IHW: 0.3, DATA: 1, VEND: 0.5, PRN: 1 }),
    special: {
      role: 'restaurant & education',
      subs: [
        sb(3, 'staff restaurant kitchen', [], { KIT: 5, CR: 1, IHW: 1, SP: 2, EF: 1 }),
        sb(1, 'education centre & library', [], { SP: 5, LTG: 2, DATA: 1, PRN: 0.5 }),
        sb(1, 'medical records', [], { SP: 5, LTG: 2, DATA: 1, PRN: 1 }),
        sb(1, 'boardroom & meeting rooms', [], { SP: 4, LTG: 3, DATA: 1, BEV: 1 }),
      ],
    },
    ahu: 2,
  },
  12: {
    areas: ['Estates offices', 'Estates workshop', 'IT data centre', 'Comms hub', 'Plant room east', 'Plant room west', 'Water tank room', 'Lift motor room', 'Roof walkway', 'Stores', 'Staff change', 'Corridor'],
    c1: sb(1, 'estates offices', [], { SP: 6, LTG: 2, DATA: 1, PRN: 0.5 }),
    c3: sb(3, 'estates workshops', [], { WRK: 3, SP: 3, LTG: 1, EF: 1 }),
    special: {
      role: 'IT data centre',
      subs: [
        sb(3, 'data centre racks A', [['UPS', 1, { name: 'Data centre UPS A', kw: 40 }]], { SRV: 8, DATA: 1 }, [12, 14]),
        sb(3, 'data centre racks B', [['UPS', 1, { name: 'Data centre UPS B', kw: 40 }]], { SRV: 8, DATA: 1 }, [12, 14]),
        sb(3, 'data centre cooling', [['CRAC', 4, named((i) => `Data centre cooling unit ${i}`)]], { BMS: 1, LTG: 1 }, [6, 8]),
        sb(1, 'comms hub', [], { DATA: 6, SP: 3, LTG: 1, ACC: 1 }),
      ],
    },
    ahu: 1,
  },
};

const RISER = (level) => (level <= 4 ? 'SMSB-A' : level <= 8 ? 'SMSB-B' : 'SMSB-C');

// Level 0 energy centre boards (SMSB-M), two sub-boards each.
const L0_BOARDS = [
  {
    role: 'chiller plant',
    direct: [['CH', 2, named((i) => `Chiller ${i} (water-cooled)`)]],
    subs: [
      sb(3, 'chilled water pumps', [['PMP', 6, named((i) => `Chilled water pump ${i}`)]], { PRS: 1, BMS: 1 }, [9, 11]),
      sb(1, 'chiller plant lighting & controls', [], { LTG: 4, BMS: 2, SP: 2, PRS: 1 }, [9, 11]),
    ],
  },
  {
    role: 'heating & hot water plant',
    direct: [['BLR', 3, named((i) => `Boiler ${i} burner & controls`)]],
    subs: [
      sb(3, 'LTHW heating pumps', [['PMP', 6, named((i) => `LTHW heating pump ${i}`)]], { PRS: 1, BMS: 1 }, [9, 11]),
      sb(3, 'domestic hot water plant', [['PMP', 4, named((i) => `DHW secondary pump ${i}`)]], { WSR: 1, BMS: 1, TRC: 1 }, [8, 10]),
    ],
  },
  {
    role: 'medical gases plant',
    direct: [
      ['MGP', 2, named((i) => `Medical vacuum plant ${i}`)],
      ['MGP', 2, named((i) => `Medical air compressor ${i}`)],
    ],
    subs: [
      sb(3, 'AGSS & manifolds', [['AGS', 2, named((i) => `Anaesthetic gas scavenging plant ${i}`)], ['MGA', 1, named(() => 'Medical gas plant alarm panel')]], { BMS: 1, LTG: 1, SP: 1 }, [7, 9]),
      sb(1, 'gas plant lighting & controls', [], { LTG: 4, SP: 2, BMS: 1 }, [7, 9]),
    ],
  },
  {
    role: 'water services & sprinklers',
    direct: [['SPR', 2, named((i) => `Sprinkler pump ${i} (${i === 1 ? 'duty' : 'standby'})`)]],
    subs: [
      sb(3, 'cold water boosters', [['PMP', 4, named((i) => `Cold water booster pump ${i}`)]], { BMS: 1, WSR: 1, TRC: 1 }, [8, 10]),
      sb(1, 'tank room lighting & controls', [], { LTG: 4, SP: 2, BMS: 1, TRC: 1 }, [8, 10]),
    ],
  },
  {
    role: 'main kitchen',
    direct: [],
    subs: [
      sb(3, 'kitchen cooking line', [], { KIT: 6, EF: 1, SP: 1 }, [12, 14], { areas: ['Main kitchen'] }),
      sb(3, 'cold rooms & dishwash', [['CR', 4, named((i) => `Cold room ${i}`)]], { KIT: 2, IHW: 1, SP: 1, LTG: 1 }, [10, 12], { areas: ['Main kitchen'] }),
    ],
  },
  {
    role: 'sterile services, mortuary & loading bay',
    direct: [['PTS', 1], ['CMP', 1]],
    subs: [
      sb(3, 'sterile services', [['STR', 3, named((i) => `Steam steriliser ${i}`)], ['WD', 4, named((i) => `Washer-disinfector ${i}`)]], { SP: 2, LTG: 2, IHW: 1 }, [12, 14], { areas: ['Sterile services'] }),
      sb(3, 'mortuary & loading bay', [['MOR', 2, named((i) => `Mortuary refrigeration ${i}`)]], { LTG: 3, SP: 2, CCTV: 1, ACC: 1, EV: 1 }, [10, 12], { areas: ['Mortuary', 'Loading bay', 'Service yard'] }),
    ],
  },
];

const L0_AREAS = ['Energy centre', 'Chiller plant room', 'Boiler house', 'Medical gas plant room', 'Sprinkler tank room', 'Main kitchen', 'Loading bay', 'Sterile services', 'Mortuary', 'Estates stores', 'Service corridor'];

// Roof plant boards DB-L12-P1..P4 (SMSB-M), two sub-boards each.
const ROOF_BOARDS = [
  {
    role: 'roof chillers',
    direct: [['CH', 2, named((i) => `Chiller ${i + 2} (air-cooled, roof)`)]],
    subs: [
      sb(3, 'roof chilled water pumps', [['PMP', 4, named((i) => `Roof chilled water pump ${i}`)]], { BMS: 1, PRS: 1 }, [8, 10]),
      sb(1, 'roof plant controls & trace heating', [], { BMS: 2, TRC: 3, LTG: 2 }, [9, 11]),
    ],
  },
  {
    role: 'roof AHUs (wards)',
    direct: [['AHU', 3, named((i) => `Roof AHU W${i} (ward supply)`)]],
    subs: [
      sb(3, 'ward ventilation fans', [], { EF: 4, SF: 3, BMS: 1 }, [9, 11]),
      sb(1, 'ward AHU controls & frost protection', [], { BMS: 3, TRC: 3, LTG: 1 }, [8, 10]),
    ],
  },
  {
    role: 'roof AHUs (theatres & ICU)',
    direct: [['AHU', 3, named((i) => `Roof AHU T${i} (theatres & ICU supply)`)]],
    subs: [
      sb(3, 'theatre & ICU ventilation fans', [], { EF: 4, SF: 3, BMS: 1 }, [9, 11]),
      sb(1, 'theatre AHU controls & frost protection', [], { BMS: 3, TRC: 3, LTG: 1 }, [8, 10]),
    ],
  },
  {
    role: 'roof services',
    direct: [],
    subs: [
      sb(3, 'roof water & heat pumps', [], { PMP: 3, HP: 2, BMS: 1 }, [8, 10]),
      sb(1, 'roof lighting & access', [], { LTG: 5, CCTV: 1, ACC: 1, TRC: 1 }, [8, 10]),
    ],
  },
];

const ROOF_AREAS = ['Roof plant deck', 'Roof walkway', 'Plant room east', 'Plant room west', 'Roof access stair'];

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

function createBuilder(rng) {
  const nodes = [];
  const seq = new Map();
  const usedNames = new Map(); // per board, so names read like a real schedule ("Lighting: Ward 8A (2)")

  const nextTag = (kind, level) => {
    const key = `${kind}-L${level}`;
    const n = (seq.get(key) ?? 0) + 1;
    seq.set(key, n);
    return `${key}-${String(n).padStart(3, '0')}`;
  };

  const uniqueName = (boardId, name) => {
    const key = `${boardId}|${name}`;
    const n = (usedNames.get(key) ?? 0) + 1;
    usedNames.set(key, n);
    return n === 1 ? name : `${name} (${n})`;
  };

  function board(_id, kind, name, parentId, level, phases) {
    const b = { _id, type: 'board', kind, name, parentId, level, voltage: phases === 3 ? 400 : 230, phases, capacityKW: 0, tripped: false };
    nodes.push(b);
    return b;
  }

  // One equipment item under `parent`. over: { name (string | fn(i)), kw (number | [min,max]), ph, critical }
  function equip(parent, kind, over = {}, i = 1, ctx = {}) {
    const k = KINDS[kind];
    if (!k) throw new Error(`unknown equipment kind ${kind}`);
    const ph = over.ph ?? k.ph;
    if (parent.phases === 1 && ph === 3) throw new Error(`design error: 3-phase ${kind} on single-phase ${parent._id}`);
    let kw;
    if (typeof over.kw === 'number') kw = over.kw;
    else if (Array.isArray(over.kw)) kw = rng.float(over.kw[0], over.kw[1], 1);
    else if (k.pick) kw = rng.pick(k.pick);
    else kw = rng.float(k.kw[0], k.kw[1], k.dp ?? 1);
    if (!(kw > 0)) kw = 0.1;

    let name;
    if (typeof over.name === 'function') name = over.name(i);
    else if (typeof over.name === 'string') name = over.name;
    else {
      const label = ctx.labels?.[kind] ?? (k.labels ? rng.pick(k.labels) : k.label);
      const area = ctx.nextArea ? ctx.nextArea() : null;
      name = area ? `${label}: ${area}` : label;
    }
    name = uniqueName(parent._id, name);

    const critical = over.critical ?? (k.critical || (ctx.critKinds ?? []).includes(kind));
    const n = {
      _id: nextTag(kind, parent.level),
      type: 'equipment',
      kind,
      name,
      parentId: parent._id,
      level: parent.level,
      voltage: ph === 3 ? 400 : 230,
      phases: ph,
      ratedKW: kw,
      loadKW: kw,
      on: true,
      critical,
      claimedBy: null,
    };
    nodes.push(n);
    return n;
  }

  // Must-have items first, then a weighted random fill up to a count drawn from spec.n.
  function fill(parent, spec, ctx = {}) {
    const areas = spec.areas ?? rng.sample(ctx.areas ?? ['Plant room'], 4);
    let a = 0;
    const itemCtx = { ...ctx, labels: spec.labels, nextArea: () => areas[a++ % areas.length] };
    const target = rng.int(spec.n[0], spec.n[1]);
    let made = 0;
    for (const [kind, count, over = {}] of spec.must ?? []) {
      for (let i = 1; i <= count; i++, made++) equip(parent, kind, over, i, itemCtx);
    }
    const weights = Object.entries(spec.fill ?? {}).filter(([kind]) => parent.phases === 3 || KINDS[kind].ph === 1);
    while (made < target && weights.length) {
      equip(parent, rng.weighted(weights), {}, 1, itemCtx);
      made++;
    }
  }

  return { nodes, board, equip, fill };
}

// Nice capacity: up to a multiple of 5 below 100 kW, 10 below 500 kW, 50 above.
export function niceCapacity(kw) {
  const x = round(kw, 6);
  if (x <= 100) return Math.max(5, Math.ceil(x / 5) * 5);
  if (x <= 500) return Math.ceil(x / 10) * 10;
  return Math.ceil(x / 50) * 50;
}

function buildNodes(rng) {
  const B = createBuilder(rng);
  const { board, equip, fill } = B;

  // Main and sub-main switchboards (level 0, energy centre)
  const msb = board('MSB', 'MSB', 'Main LV switchboard (energy centre)', null, 0, 3);
  const smsb = {
    A: board('SMSB-A', 'SMSB', 'Sub-main switchboard A (riser 1, levels 1-4)', msb._id, 0, 3),
    B: board('SMSB-B', 'SMSB', 'Sub-main switchboard B (riser 2, levels 5-8)', msb._id, 0, 3),
    C: board('SMSB-C', 'SMSB', 'Sub-main switchboard C (riser 3, levels 9-12)', msb._id, 0, 3),
    M: board('SMSB-M', 'SMSB', 'Sub-main switchboard M (mechanical plant)', msb._id, 0, 3),
    E: board('SMSB-E', 'SMSB', 'Sub-main switchboard E (essential & life-safety services)', msb._id, 0, 3),
    L: board('SMSB-L', 'SMSB', 'Sub-main switchboard L (lifts)', msb._id, 0, 3),
  };

  // Level 0: energy centre plant from SMSB-M
  L0_BOARDS.forEach((spec, i) => {
    const id = `DB-L0-0${i + 1}`;
    const fb = board(id, 'DB', `Level 0 ${spec.role} distribution board`, smsb.M._id, 0, 3);
    for (const [kind, count, over = {}] of spec.direct) for (let k = 1; k <= count; k++) equip(fb, kind, over, k);
    spec.subs.forEach((s, j) => {
      const sub = board(`${id}${'AB'[j]}`, 'DB', `Level 0 ${s.label}`, fb._id, 0, s.ph);
      fill(sub, s, { areas: L0_AREAS });
    });
  });

  // Life-safety items straight off SMSB-E (level 0)
  equip(smsb.E, 'FA', { name: 'Main fire alarm panel (energy centre)' });
  equip(smsb.E, 'SMK', { name: (i) => `Smoke extract fan ${i} (east stair)` }, 1);
  equip(smsb.E, 'SMK', { name: (i) => `Smoke extract fan ${i + 1} (west stair)` }, 1);
  equip(smsb.E, 'EM', { name: 'Emergency lighting: energy centre' });
  equip(smsb.E, 'EM', { name: 'Emergency lighting: service corridor' });

  // Lifts from SMSB-L (level 0)
  const lifts = [
    ...[1, 2, 3, 4, 5, 6].map((i) => [`Bed lift ${i}`, [15, 18.5]]),
    ...[1, 2, 3, 4].map((i) => [`Passenger lift ${i}`, [11, 15]]),
    ['Goods lift', [15]],
    ['Firefighting lift', [18.5], true],
  ];
  for (const [name, ratings, critical = false] of lifts) equip(smsb.L, 'LIFT', { name, kw: rng.pick(ratings), critical });

  // Levels 1-12
  for (let level = 1; level <= 12; level++) {
    const L = LEVELS[level];
    const dept = DEPARTMENTS[level];
    const ctx = { areas: L.areas, critKinds: L.critKinds ?? [] };
    const riser = RISER(level);
    const wingDirect = (wing) => [
      ['HP', 1, named(() => `Heat pump: L${level} ${wing} wing`)],
      ['DATA', 1, named(() => `Floor comms room: L${level} ${wing} wing`)],
    ];

    const floorSpecs = {
      '01': { role: `${dept} north wing`, subs: [STD.lighting(`L${level} north wing`), STD.smallPower(), L.c1, L.c3], direct: wingDirect('north') },
      '02': { role: `${dept} south wing`, subs: [STD.lighting(`L${level} south wing`), STD.smallPower(), L.c1, L.c3], direct: wingDirect('south') },
      '03': L.special ? { role: L.special.role, subs: L.special.subs, direct: L.special.direct } : null,
      '04': {
        role: 'mechanical services',
        subs: [STD.mech('pumps & extract fans'), STD.fcu(), L.mechC ?? STD.mech('heat pumps & supply fans'), STD.fcu()],
        direct: [['AHU', L.ahu, named((i) => `Air handling unit ${i}: ${dept}`)]],
      },
      ...(L.boards ?? {}),
    };

    for (const no of ['01', '02', '03', '04']) {
      const spec = floorSpecs[no];
      const id = `DB-L${level}-${no}`;
      const fb = board(id, 'DB', `Level ${level} ${spec.role} distribution board`, riser, level, 3);
      for (const [kind, count, over = {}] of spec.direct ?? []) for (let k = 1; k <= count; k++) equip(fb, kind, over, k, ctx);
      spec.subs.forEach((s, j) => {
        const sub = board(`${id}${'ABCD'[j]}`, 'DB', `Level ${level} ${s.label}`, fb._id, level, s.ph);
        fill(sub, s, ctx);
      });
    }

    // Essential services board, fed from SMSB-E
    const ess = board(`DB-L${level}-E`, 'DB', `Level ${level} essential services board`, smsb.E._id, level, 3);
    fill(
      ess,
      sb(
        3,
        'essential services',
        [
          ['EM', 3, named((i) => `Emergency lighting: ${['stair core 1', 'stair core 2', 'escape corridors'][i - 1]} (L${level})`)],
          ['FA', 1, named(() => `Fire alarm panel (level ${level})`)],
        ],
        { LTG: 6, SP: 5, ACC: 1, CCTV: 1, BMS: 0.6, DATA: 0.6 },
        [26, 32],
        { labels: { LTG: 'Essential lighting', SP: 'Essential small power' } },
      ),
      ctx,
    );
  }

  // Roof plant (level 12) from SMSB-M
  ROOF_BOARDS.forEach((spec, i) => {
    const id = `DB-L12-P${i + 1}`;
    const pb = board(id, 'DB', `Level 12 ${spec.role} distribution board`, smsb.M._id, 12, 3);
    for (const [kind, count, over = {}] of spec.direct) for (let k = 1; k <= count; k++) equip(pb, kind, over, k);
    spec.subs.forEach((s, j) => {
      const sub = board(`${id}${'AB'[j]}`, 'DB', `Level 12 ${s.label}`, pb._id, 12, s.ph);
      fill(sub, s, { areas: ROOF_AREAS });
    });
  });

  return B.nodes;
}

// Size every board from its downstream load (everything is on), then force exactly three
// leaf sub-boards (never under DB-L5-02) over capacity.
function sizeBoards(nodes, rng) {
  const idx = indexNodes(nodes);
  const loads = new Map();
  const loadOf = (id) => {
    if (loads.has(id)) return loads.get(id);
    let kw = 0;
    for (const c of idx.children.get(id) ?? []) kw += c.type === 'equipment' ? c.loadKW : loadOf(c._id);
    kw = round(kw, 2);
    loads.set(id, kw);
    return kw;
  };

  const boards = nodes.filter((n) => n.type === 'board');
  for (const b of boards) {
    const u = rng.float(0.45, 0.85, 3);
    b.capacityKW = niceCapacity(loadOf(b._id) / u);
  }

  const protectedIds = new Set([SHUTDOWN_DEMO_BOARD, ...downstream(nodes, SHUTDOWN_DEMO_BOARD, idx).map((d) => d.node._id)]);
  const pct = (load, cap) => Math.round((load / cap) * 100);
  const overloadCap = (load) => {
    // Nice capacities (multiples of 5) that land between 104% and 115%; pick the middle one.
    const caps = [];
    for (let cap = 5; cap < load; cap += 5) if (pct(load, cap) >= 104 && pct(load, cap) <= 115) caps.push(cap);
    return caps.length ? caps[Math.floor(caps.length / 2)] : null;
  };
  const candidates = boards.filter(
    (b) =>
      b.kind === 'DB' &&
      !protectedIds.has(b._id) &&
      b.level >= 1 &&
      !(idx.children.get(b._id) ?? []).some((c) => c.type === 'board') &&
      idx.byId.get(b.parentId)?.kind === 'DB' &&
      (idx.children.get(b._id) ?? []).length >= 12 &&
      overloadCap(loadOf(b._id)) != null,
  );
  const picked = [];
  const levels = new Set();
  for (const b of rng.shuffle(candidates)) {
    if (levels.has(b.level)) continue;
    picked.push(b);
    levels.add(b.level);
    if (picked.length === 3) break;
  }
  if (picked.length !== 3) throw new Error('could not pick three boards to overload');
  for (const b of picked) b.capacityKW = overloadCap(loadOf(b._id));
  return picked.map((b) => b._id).sort();
}

// ---------------------------------------------------------------------------------------------
// Change history: ~1,300 events over the 7 days before `now`, weighted to Level 5.
// ---------------------------------------------------------------------------------------------

export const CONTRACTORS = [
  'Northside M&E',
  'Apex Electrical',
  'BrightSpark Ltd',
  'Facilities team',
  'Commissioning engineer',
  'Site manager',
  'Estates electrician',
];

const WHO_BY_ACTION = {
  rewire: { 'Northside M&E': 35, 'Apex Electrical': 30, 'BrightSpark Ltd': 25, 'Estates electrician': 10 },
  load: { 'Commissioning engineer': 30, 'Facilities team': 20, 'Northside M&E': 15, 'Apex Electrical': 15, 'BrightSpark Ltd': 15, 'Estates electrician': 5 },
  toggle: { 'Facilities team': 35, 'Commissioning engineer': 25, 'Estates electrician': 20, 'Site manager': 10, 'Northside M&E': 10 },
  trip: { 'Commissioning engineer': 40, 'Site manager': 20, 'Facilities team': 20, 'Estates electrician': 20 },
};

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

function generateEvents(nodes, rng, now) {
  const idx = indexNodes(nodes);
  const byLevel = new Map();
  for (const n of nodes) {
    if (!byLevel.has(n.level)) byLevel.set(n.level, { equipment: [], boards: [] });
    const bucket = byLevel.get(n.level);
    if (n.type === 'equipment') bucket.equipment.push(n);
    else if (n.kind === 'DB') bucket.boards.push(n);
  }
  // Movable equipment: small kit on a sub-board (a DB fed from a DB).
  const movable = (n) => n.ratedKW <= 11 && idx.byId.get(n.parentId)?.kind === 'DB' && idx.byId.get(idx.byId.get(n.parentId).parentId)?.kind === 'DB';

  const levelWeights = [...byLevel.keys()].map((l) => [l, l === 5 ? 24 : l === 0 ? 4 : 6.5]);
  const start = now - 7 * DAY;

  // A timestamp in the last 7 days, mostly 07:00-18:00 UK time (06:00-17:00 UTC), fewer at weekends.
  const randomTs = (maxTs) => {
    for (let tries = 0; tries < 60; tries++) {
      const d = rng.int(0, 7);
      const dayStart = Math.floor(now / DAY) * DAY - d * DAY;
      const dow = new Date(dayStart).getUTCDay();
      if ((dow === 0 || dow === 6) && !rng.chance(0.35)) continue;
      const minute = rng.chance(0.88) ? rng.int(6 * 60, 17 * 60 - 1) : rng.int(0, 24 * 60 - 1);
      const ts = dayStart + minute * MIN + rng.int(0, 59999);
      if (ts > start && ts < maxTs) return ts;
    }
    return Math.max(start + MIN, maxTs - rng.int(1, 60) * MIN);
  };

  const events = [];
  const push = (ts, who, action, node, from, to) =>
    events.push({ ts: new Date(ts), who, action, nodeId: node._id, from, to, level: node.level });

  const rewired = new Set();
  const loaded = new Set();
  const target = rng.int(1250, 1400);
  while (events.length < target) {
    const level = rng.weighted(levelWeights);
    const pool = byLevel.get(level);
    const action = rng.weighted({ rewire: 26, toggle: 30, load: 30, trip: 14 });
    const whoFor = (a) => {
      const weights = { ...WHO_BY_ACTION[a] };
      if (level === 5 && a !== 'trip') weights['Northside M&E'] = (weights['Northside M&E'] ?? 10) * 2.5;
      return rng.weighted(weights);
    };

    if (action === 'rewire') {
      // A move that ended up on the item's current board: from = where it was, to = parentId now.
      const n = rng.pick(pool.equipment);
      if (!movable(n) || rewired.has(n._id)) continue;
      const parent = idx.byId.get(n.parentId);
      const ok = (b) => b._id !== parent._id && (n.phases === 1 || b.phases === 3) && idx.byId.get(b.parentId)?.kind === 'DB';
      const siblings = (idx.children.get(parent.parentId) ?? []).filter((b) => b.type === 'board' && ok(b));
      const others = pool.boards.filter(ok);
      const fromPool = siblings.length && rng.chance(0.6) ? siblings : others;
      if (!fromPool.length) continue;
      rewired.add(n._id);
      push(randomTs(now), whoFor('rewire'), 'rewire', n, rng.pick(fromPool)._id, parent._id);
    } else if (action === 'load') {
      const n = rng.pick(pool.equipment);
      if (loaded.has(n._id)) continue;
      loaded.add(n._id);
      const from = rng.chance(0.7) ? round(Math.max(0.1, n.loadKW * rng.float(0.4, 0.9, 2)), 1) : round(n.loadKW * rng.float(1.1, 1.6, 2), 1);
      if (from === n.loadKW) continue;
      push(randomTs(now), whoFor('load'), 'load', n, from, n.loadKW);
    } else if (action === 'toggle') {
      // Switched off for work, then back on (everything is on now).
      const n = rng.pick(pool.equipment);
      const gap = rng.int(5, 180) * MIN;
      const t1 = randomTs(now - gap);
      const who = whoFor('toggle');
      push(t1, who, 'toggle', n, 'on', 'off');
      push(t1 + gap, rng.chance(0.75) ? who : whoFor('toggle'), 'toggle', n, 'off', 'on');
    } else {
      // Board tripped (or isolated for testing) and reset (nothing is tripped now).
      const b = rng.pick(pool.boards);
      const gap = rng.int(2, 90) * MIN;
      const t1 = randomTs(now - gap);
      const who = whoFor('trip');
      push(t1, who, 'trip', b, false, true);
      push(t1 + gap, rng.chance(0.7) ? who : whoFor('trip'), 'reset', b, true, false);
    }
  }
  events.sort((a, b) => a.ts - b.ts || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return events;
}

// ---------------------------------------------------------------------------------------------

/**
 * Generate the hospital. Pure: same { seed, now } in, identical output out.
 * @returns {{ nodes: object[], events: object[], overloaded: string[] }}
 *   nodes: CONTRACT.md 1.1 documents (parent-first order); events: CONTRACT.md 1.2 documents
 *   (ts is a Date, no _id so MongoDB assigns one); overloaded: the three boards sized over 100%.
 */
export function generateHospital({ seed = DEFAULT_SEED, now = Date.now() } = {}) {
  const rng = createRng(seed);
  const nodes = buildNodes(rng);
  const overloaded = sizeBoards(nodes, rng);
  const events = generateEvents(nodes, createRng((seed ^ 0x5eed) >>> 0), now);
  return { nodes, events, overloaded };
}

export default generateHospital;
