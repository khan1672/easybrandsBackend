import { Router } from 'express';
import type { Catalog } from '../db/catalog.js';
import { getProduct, browseProducts, searchProducts, productFacets } from '../controllers/products.controller.js';
import { listBrands } from '../controllers/brands.controller.js';
import { listCategories } from '../controllers/categories.controller.js';
import { health } from '../controllers/health.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { chat } from '../controllers/chat.controller.js';
import { rateLimit } from '../middleware/rate-limit.js';
import type { Env } from '../config/env.js';

export function createRouter(ctx: { catalog: Catalog; env: Env }) {
  const r = Router();

  r.get('/health', asyncHandler(health(ctx)));
  r.get('/brands', asyncHandler(listBrands(ctx)));
  r.get('/categories', asyncHandler(listCategories(ctx)));
  r.get('/products', asyncHandler(browseProducts(ctx)));
  r.get('/products/search', asyncHandler(searchProducts(ctx)));
  // Must precede '/products/:slug', otherwise 'facets' is read as a slug.
  r.get('/products/facets', asyncHandler(productFacets(ctx)));
  r.get('/products/:slug', asyncHandler(getProduct(ctx)));

  // Server-sent events, not JSON: the reply is streamed as it is written.
  r.post(
    '/chat',
    rateLimit(ctx.env.chatRateLimit, ctx.env.chatRateWindowMs),
    (req, res) => {
      // Response headers must be written before any await, so this handler is
      // deliberately not wrapped in asyncHandler.
      void chat(ctx.env, ctx.catalog)(req, res);
    },
  );

  return r;
}

export default createRouter;
