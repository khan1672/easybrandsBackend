import fs from 'node:fs';

import { buildStore, ProductStore } from './db/store.js';
import { JsonlCatalog, seedMongoFromJsonl, type Catalog } from './db/catalog.js';
import { buildMongoCollection } from './db/mongo.js';
import { MongoCatalog } from './db/mongoCatalog.js';
import loadEnv, { type Env } from './config/env.js';

export interface Backend {
  catalog: Catalog;
  env: Env;
  /** Null when Mongo is the source and no JSONL was read. */
  store: ProductStore | null;
  source: 'jsonl' | 'mongodb';
  bootMs: number;
}

/**
 * The JSONL read model is optional when Mongo is configured.
 *
 * The data file is gitignored and its local path lives outside this repo, so on
 * a fresh clone (Vercel, CI, a new teammate) it simply is not there. Loading it
 * unconditionally would abort the boot before Mongo was ever consulted, even
 * though Mongo is the source of truth and the file is only needed to seed an
 * empty collection or to run with no database at all.
 */
async function loadJsonlStore(env: Env): Promise<ProductStore | null> {
  if (!fs.existsSync(env.dataFile)) {
    // Not an error on its own: Mongo may well be configured and no file
    // is ever shipped with the source. `createBackend` decides whether a
    // missing store is acceptable, and if not it raises a message naming
    // DATA_FILE instead of a bare ENOENT from readFile.
    if (env.mongoUri) console.log('[boot] no JSONL at DATA_FILE, using mongodb only');
    return null;
  }
  return buildStore(env.dataFile);
}

export async function createBackend(env: Env = loadEnv()): Promise<Backend> {
  const t = Date.now();

  const store = await loadJsonlStore(env);
  const bootMs = Date.now() - t;

  // Mongo is the source of truth whenever MONGO_URI is set. If it is not
  // reachable we refuse to silently serve stale data: boot fails loudly.
  if (env.mongoUri) {
    const ctx = await buildMongoCollection(env);
    const total = await ctx.count();
    if (total === 0) {
      // Seeding is the one thing that genuinely needs the file. On a serverless
      // deploy there is no JSONL to seed from, so say what is wrong rather than
      // serving an empty catalogue that looks like a healthy install.
      if (!store) {
        throw new Error(
          `mongodb collection "${env.mongoDb}.${env.mongoCollection}" is empty and no JSONL ` +
            `is available at DATA_FILE (${env.dataFile}) to seed it from`,
        );
      }
      const seed = await seedMongoFromJsonl(store, env);
      console.log(`[boot] seeded mongo from jsonl: ${seed.seeded} docs (skipped=${seed.skipped})`);
    }
    const indexes = await ctx.ensureIndexes();
    console.log(`[boot] mongo source ready  db=${env.mongoDb}  coll=${env.mongoCollection}  indexes=[${indexes.join(',')}]`);
    return { catalog: new MongoCatalog(ctx), env, store, source: 'mongodb', bootMs };
  }

  if (!store) {
    throw new Error(`no DATA_FILE at ${env.dataFile} and MONGO_URI is not set, so there is no catalog to serve`);
  }
  return { catalog: new JsonlCatalog(store), env, store, source: 'jsonl', bootMs };
}

export default createBackend;