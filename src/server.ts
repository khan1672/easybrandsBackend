import { buildStore } from './db/store.js';
import { JsonlCatalog, seedMongoFromJsonl, type Catalog } from './db/catalog.js';
import { buildMongoCollection } from './db/mongo.js';
import { MongoCatalog } from './db/mongoCatalog.js';
import { createApp } from './app.js';
import loadEnv from './config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const t = Date.now();

  const store = await buildStore(env.dataFile);
  const bootMs = Date.now() - t;

  let catalog: Catalog = new JsonlCatalog(store);
  let source = 'jsonl';

  // Mongo is the source of truth whenever MONGO_URI is set. If it is not
  // reachable we refuse to silently serve stale data: boot fails loudly.
  if (env.mongoUri) {
    const ctx = await buildMongoCollection(env);
    const total = await ctx.count();
    if (total === 0) {
      const seed = await seedMongoFromJsonl(store, env);
      console.log(`[boot] seeded mongo from jsonl: ${seed.seeded} docs (skipped=${seed.skipped})`);
    }
    const indexes = await ctx.ensureIndexes();
    catalog = new MongoCatalog(ctx);
    source = 'mongodb';
    console.log(`[boot] mongo source ready  db=${env.mongoDb}  coll=${env.mongoCollection}  indexes=[${indexes.join(',')}]`);
  }

  const app = createApp({ catalog, requestLog: env.requestLog });
  const server = app.listen(env.port, env.host, () => {
    console.log(`[boot] easybrands API ready  http://${env.host}:${env.port}`);
    console.log(`[boot] jsonl_docs=${store.count}  boot=${bootMs}ms  source=${source}`);
  });

  const shutdown = () => {
    void catalog.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
