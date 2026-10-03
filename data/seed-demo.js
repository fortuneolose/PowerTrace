// Seed the 60-node demo building into DEMO_DB. Usage: npm run seed:demo (from the repo root)
import { getDemoNodes } from './demo-building.js';
import { boardLoadPercents } from './lib/graph.js';
import { openSite, replaceNodes, dbNames } from './lib/db.js';

const nodes = getDemoNodes();
const { client, db } = await openSite('demo');
try {
  await replaceNodes(db, nodes);
  const equipment = nodes.filter((n) => n.type === 'equipment').length;
  console.log(`Seeded ${nodes.length} nodes (${nodes.length - equipment} boards, ${equipment} equipment) into ${dbNames.demo}`);
  console.log('Starting loads:', boardLoadPercents(nodes));
} finally {
  await client.close();
}
