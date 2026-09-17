import express from 'express';
import type { Express } from 'express';
import type { ProductStore } from './db/store.js';
import type { AtlasSummary } from './db/atlas.js';
import { createRouter } from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';
import { requestLog } from './middleware/request-log.js';

export interface AppContext {
  store: ProductStore;
  atlas: AtlasSummary | null;
  requestLog?: boolean;
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLog(ctx.requestLog !== false));

  app.get('/', (_req, res) => {
    res.json({
      name: 'easybrands API',
      docs: ctx.store.count,
      brands: ctx.store.brands().length,
      endpoints: {
        health: '/api/v1/health',
        brands: '/api/v1/brands',
        products: '/api/v1/products?brand=&category=&available=&page=&limit=',
        product: '/api/v1/products/:slug   (e.g. /api/v1/products/Limelight%3Ap8456sh-sll-owh)',
        search: '/api/v1/products/search?q=&brand=&available=&page=&limit=',
      },
    });
  });
  app.use('/api/v1', createRouter(ctx));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
