import type { IncomingMessage, ServerResponse } from 'node:http';

import { createBackend } from './bootstrap.js';
import { createApp } from './app.js';

/**
 * Request handler for a long-lived process (a Vercel function, a container, or
 * anything else that hands us one request at a time). The Express app is built
 * once and reused, so the Atlas connection and the index check are paid on cold
 * start only.
 */
export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let cached: Promise<Handler> | null = null;

/**
 * Module scope survives between invocations on a warm instance, which is what
 * keeps this off the per-request path. A failed boot is deliberately not cached,
 * so a transient Atlas outage can recover without a redeploy.
 */
export function getApp(): Promise<Handler> {
  cached ??= createBackend()
    .then(({ catalog, env, source, bootMs }) => {
      console.log(`[boot] source=${source}  boot=${bootMs}ms  mode=serverless`);
      return createApp({ catalog, env, requestLog: env.requestLog }) as Handler;
    })
    .catch((err: unknown) => {
      cached = null;
      throw err;
    });
  return cached;
}

/** Test seam: drops the cached app so the next call boots again. */
export function resetApp(): void {
  cached = null;
}

export default getApp;