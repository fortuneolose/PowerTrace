import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client;

export async function connect() {
  if (!config.mongoUri) throw new Error('MONGODB_URI is not set. Copy .env.example to .env in the repo root.');
  client = new MongoClient(config.mongoUri);
  await client.connect();
  return client;
}

// site = 'demo' | 'hospital' (from ?site=, default 'demo'). Same collections in both databases.
export function getDb(site = 'demo') {
  const name = config.dbNames[site];
  if (!name) throw Object.assign(new Error(`unknown site "${site}"`), { status: 400, code: 'BAD_REQUEST' });
  return client.db(name);
}

export const SITES = Object.keys(config.dbNames);
