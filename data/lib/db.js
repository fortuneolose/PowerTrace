import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { ensureSchema } from '../../backend/src/schema.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export const dbNames = {
  demo: process.env.DEMO_DB || 'powertrace_demo',
  hospital: process.env.HOSPITAL_DB || 'powertrace_hospital',
};

// Connects, applies the backend's validator and indexes, and returns { client, db }.
export async function openSite(site) {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Copy .env.example to .env in the repo root.');
    process.exit(1);
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(dbNames[site]);
  await ensureSchema(db);
  return { client, db };
}

// Replace the contents of a site. deleteMany (not drop) keeps the validator and indexes.
export async function replaceNodes(db, nodes, events = []) {
  await db.collection('nodes').deleteMany({});
  await db.collection('events').deleteMany({});
  const batch = 1000;
  for (let i = 0; i < nodes.length; i += batch) {
    await db.collection('nodes').insertMany(nodes.slice(i, i + batch), { ordered: true });
  }
  for (let i = 0; i < events.length; i += batch) {
    await db.collection('events').insertMany(events.slice(i, i + batch), { ordered: true });
  }
}
