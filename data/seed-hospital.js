// Seed the synthetic 12-storey hospital (+ a week of change history) into HOSPITAL_DB.
// Usage: npm run seed:hospital (from the repo root)
import { generateHospital, SHUTDOWN_DEMO_BOARD } from './lib/hospital.js';
import { boardLoadPercents, downstream } from './lib/graph.js';
import { openSite, replaceNodes, dbNames } from './lib/db.js';

const { nodes, events } = generateHospital();
const { client, db } = await openSite('hospital');
try {
  await replaceNodes(db, nodes, events);

  const equipment = nodes.filter((n) => n.type === 'equipment');
  const critical = equipment.filter((n) => n.critical).length;
  console.log(`Seeded ${nodes.length} nodes (${nodes.length - equipment.length} boards, ${equipment.length} equipment) into ${dbNames.hospital}`);
  console.log(`  critical: ${critical} (${((critical / equipment.length) * 100).toFixed(1)}% of equipment)`);
  console.log(`  events: ${events.length} over the last 7 days (${events.filter((e) => e.level === 5).length} on level 5)`);

  const affected = downstream(nodes, SHUTDOWN_DEMO_BOARD).map((d) => d.node);
  console.log(
    `  isolating ${SHUTDOWN_DEMO_BOARD} affects ${affected.length} nodes (${affected.filter((n) => n.type === 'board').length} boards, ` +
      `${affected.filter((n) => n.type === 'equipment').length} equipment, ${affected.filter((n) => n.critical).length} critical)`,
  );

  const pct = boardLoadPercents(nodes);
  const top = Object.entries(pct).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('  highest-loaded boards:');
  for (const [id, p] of top) console.log(`    ${id.padEnd(12)} ${String(p).padStart(4)}%${p > 100 ? '  OVERLOADED' : ''}`);
} finally {
  await client.close();
}
