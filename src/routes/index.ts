import { Router } from 'express';
import type { ProductStore } from '../db/store.js';
import type { AtlasSummary } from '../db/atlas.js';
import { getProduct, browseProducts, searchProducts } from '../controllers/products.controller.js';
import { listBrands } from '../controllers/brands.controller.js';
import { health } from '../controllers/health.controller.js';

export function createRouter(ctx: { store: ProductStore; atlas: AtlasSummary | null }) {
  const r = Router();

  r.get('/health', health(ctx));
  r.get('/brands', listBrands(ctx));
  r.get('/products', browseProducts(ctx));
  r.get('/products/search', searchProducts(ctx));
  r.get('/products/:slug', getProduct(ctx));

  return r;
}

export default createRouter;
