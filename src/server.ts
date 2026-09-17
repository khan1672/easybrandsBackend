import { buildStore } from './db/store.js';
import { atlasSummary } from './db/atlas.js';
import { createApp } from './app.js';
import loadEnv from './config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const t = Date.now();
  const store = await buildStore(env.dataFile);
  const bootMs = Date.now() - t;

  const atlas = env.atlas === 'off' || !env.mongoUri
    ? null
    : await atlasSummary(env);

  const app = createApp({ store, atlas, requestLog: env.requestLog });
  const server = app.listen(env.port, env.host, () => {
    console.log(`[boot] easybrands API ready  http://${env.host}:${env.port}`);
    console.log(`[boot] docs=${store.count}  boot=${bootMs}ms  atlas=${atlas?.reachable ? 'online' : 'offline'}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
