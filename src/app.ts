import express from 'express';
import type { Express } from 'express';
import type { Catalog } from './db/catalog.js';
import { createRouter } from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';
import { requestLog } from './middleware/request-log.js';
import type { Env } from './config/env.js';

export interface AppContext {
  catalog: Catalog;
  env: Env;
  requestLog?: boolean;
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  // Required behind Vercel's proxy: without it Express reads the proxy's IP as
  // req.ip, so the chat rate limiter would key everyone to one bucket.
  app.set('trust proxy', ctx.env.trustProxy);

  app.use(requestLog(ctx.requestLog !== false));
  // Chat accepts up to 20 messages of 2,000 chars, so 64kb leaves headroom.
  app.use(express.json({ limit: '64kb' }));

  app.get('/', (_req, res) => {
    void ctx.catalog.brandCount().then((brands) => {
      res.json({
        name: 'easybrands API',
        source: ctx.catalog.source,
        endpoints: {
          health: '/api/v1/health',
          brands: '/api/v1/brands',
          products: '/api/v1/products?brand=&category=&available=&page=&limit=',
          product: '/api/v1/products/:slug',
          search: '/api/v1/products/search?q=&brand=&available=&page=&limit=',
          chat: 'POST /api/v1/chat (SSE)',
        },
        brands,
      });
    });
  });
  app.use('/api/v1', createRouter(ctx));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
