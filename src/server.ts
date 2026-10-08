import { createBackend } from './bootstrap.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const { catalog, env, store, source, bootMs } = await createBackend();

  const app = createApp({ catalog, env, requestLog: env.requestLog });
  const server = app.listen(env.port, env.host, () => {
    console.log(`[boot] easybrands API ready  http://${env.host}:${env.port}`);
    console.log(`[boot] source=${source}  jsonl_docs=${store ? store.count : 0}  boot=${bootMs}ms`);
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