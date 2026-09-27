import type { Env } from '../config/env.js';

export interface AtlasSummary {
  mode: 'off' | 'auto';
  docs?: number;
  reachable: boolean;
  reason?: string;
}

/** Always-offline by design (no mongodb driver dependency; JSONL is the truth). */
export async function atlasSummary(env: Pick<Env, 'mongoUri' | 'mongoDb' | 'mongoCollection'>): Promise<AtlasSummary | null> {
  if (!env.mongoUri) return null;
  try {
    /* mongodb driver is an optional runtime dep (never installed by default) */
      const { MongoClient } = await import('mongodb');
    const client = new MongoClient(env.mongoUri, { serverSelectionTimeoutMS: 900 });
    await client.connect();
    const count = await client.db(env.mongoDb).collection(env.mongoCollection).countDocuments();
    await client.close();
    return { mode: 'auto', docs: count, reachable: true };
  } catch (err) {
    return { mode: 'off', reachable: false, reason: (err as Error).message };
  }
}

export default atlasSummary;
