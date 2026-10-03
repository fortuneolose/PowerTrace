// $jsonSchema validator and indexes for the `nodes` collection (see CONTRACT.md section 1.1).
// Keep this file dependency-free: /data's seed scripts import ensureSchema() from here so the seed
// data always goes through the same validator as the app.

export const nodesValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['_id', 'type', 'kind', 'name', 'parentId', 'level', 'voltage', 'phases'],
    properties: {
      _id: { bsonType: 'string', minLength: 1, description: 'equipment/board tag' },
      type: { enum: ['board', 'equipment'], description: 'must be board or equipment' },
      kind: { bsonType: 'string' },
      name: { bsonType: 'string' },
      parentId: { bsonType: ['string', 'null'], description: 'tag of the feeding board; null only for the MSB' },
      level: { bsonType: 'int', minimum: 0 },
      voltage: { enum: [230, 400], description: 'must be 230 or 400' },
      phases: { enum: [1, 3], description: 'must be 1 or 3' },
      capacityKW: { bsonType: 'number', minimum: 0, exclusiveMinimum: true },
      tripped: { bsonType: 'bool' },
      ratedKW: { bsonType: 'number', minimum: 0, exclusiveMinimum: true, description: 'rating is required and > 0' },
      loadKW: { bsonType: 'number', minimum: 0 },
      on: { bsonType: 'bool' },
      critical: { bsonType: 'bool' },
      claimedBy: { bsonType: ['string', 'null'] },
    },
    anyOf: [
      { properties: { type: { enum: ['board'] } }, required: ['capacityKW', 'tripped'] },
      { properties: { type: { enum: ['equipment'] } }, required: ['ratedKW', 'loadKW', 'on', 'critical'] },
    ],
  },
};

export async function ensureSchema(db) {
  const existing = await db.listCollections({ name: 'nodes' }).toArray();
  if (existing.length === 0) {
    await db.createCollection('nodes', { validator: nodesValidator, validationLevel: 'strict', validationAction: 'error' });
  } else {
    await db.command({ collMod: 'nodes', validator: nodesValidator, validationLevel: 'strict', validationAction: 'error' });
  }
  await db.collection('nodes').createIndex({ parentId: 1 });
  await db.collection('nodes').createIndex({ type: 1, level: 1 });
  await db.collection('events').createIndex({ ts: -1 });
  await db.collection('events').createIndex({ level: 1, ts: -1 });
}
