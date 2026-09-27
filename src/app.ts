import express from 'express';
import type { Express } from 'express';
import type { Catalog } from './db/catalog.js';
import { createRouter } from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';
import { requestLog } from './middleware/request-log.js';

export interface AppContext {
  catalog: Catalog;
  requestLog?: boolean;
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLog(ctx.requestLog !== false));

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
