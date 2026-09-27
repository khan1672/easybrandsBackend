import type { Env } from '../config/env.js';

interface Col {
  findOne(filter: unknown, opts?: unknown): Promise<unknown>;
  find(filter: unknown): { sort(s: unknown): Col & { skip(n: number): Col & { limit(n: number): { toArray(): Promise<unknown[]> } } } };
  countDocuments(filter?: unknown): Promise<number>;
  distinct(field: string, filter?: unknown): Promise<unknown[]>;
  aggregate(stages: unknown[]): { toArray(): Promise<unknown[]> };
  createIndex(key: unknown, opts?: unknown): Promise<string>;
  bulkWrite(ops: unknown[], opts?: unknown): Promise<unknown>;
}

export interface MongoContext {
  collection(): Col;
  ping(): Promise<boolean>;
  ensureIndexes(): Promise<string[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Builds the Mongo context used by MongoCatalog. `mongodb` is an optional
 * runtime dependency: it is dynamically imported only when MONGO_URI is set,
 * so the server still boots on JSONL alone.
 */
export async function buildMongoCollection(
  env: Pick<Env, 'mongoUri' | 'mongoDb' | 'mongoCollection'>,
): Promise<MongoContext> {
  const { MongoClient } = (await import('mongodb')) as unknown as {
    MongoClient: new (uri: string, opts?: object) => {
      connect(): Promise<void>;
      db(name: string): { collection(name: string): Col };
      close(): Promise<void>;
    };
  };

  const client = new MongoClient(env.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    retryWrites: true,
    maxPoolSize: 10,
  });
  await client.connect();
  const col = client.db(env.mongoDb).collection(env.mongoCollection);

  return {
    collection: () => col,
    ping: async () => {
      try {
        await col.findOne({}, { projection: { _id: 1 } });
        return true;
      } catch {
        return false;
      }
    },
    ensureIndexes: async () => {
      const created: string[] = [];
      const wanted: { key: Record<string, number>; name: string; unique?: boolean }[] = [
        { key: { brand_name: 1, handle: 1 }, name: 'brand_handle_unique', unique: true },
        { key: { brand_name: 1, category: 1, available: 1 }, name: 'browse_idx' },
        { key: { price: 1 }, name: 'price_idx' },
      ];
      for (const idx of wanted) {
        try {
          await col.createIndex(idx.key, { name: idx.name, unique: idx.unique === true });
          created.push(idx.name);
        } catch {
          /* already present, or conflicting duplicates */
        }
      }
      return created;
    },
    count: () => col.countDocuments(),
    close: () => client.close(),
  };
}
