import { Router } from 'express';
import type { Catalog } from '../db/catalog.js';
import { getProduct, browseProducts, searchProducts, productFacets } from '../controllers/products.controller.js';
import { listBrands } from '../controllers/brands.controller.js';
import { listCategories } from '../controllers/categories.controller.js';
import { health } from '../controllers/health.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';

export function createRouter(ctx: { catalog: Catalog }) {
  const r = Router();

  r.get('/health', asyncHandler(health(ctx)));
  r.get('/brands', asyncHandler(listBrands(ctx)));
  r.get('/categories', asyncHandler(listCategories(ctx)));
  r.get('/products', asyncHandler(browseProducts(ctx)));
  r.get('/products/search', asyncHandler(searchProducts(ctx)));
  // Must precede '/products/:slug', otherwise 'facets' is read as a slug.
  r.get('/products/facets', asyncHandler(productFacets(ctx)));
  r.get('/products/:slug', asyncHandler(getProduct(ctx)));

  return r;
}

export default createRouter;
