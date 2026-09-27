import type { Request, Response } from 'express';
import type { Catalog } from '../db/catalog.js';

function pageFrom(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function limitFrom(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
}

/**
 * GET /api/v1/categories — product categories, not brands.
 *
 * Merchants label products with their own Shopify `product_type`, which yields
 * 192 raw values for our catalogue. These are folded into the canonical set in
 * db/categoryTaxonomy.ts, so the app gets a stable, short list with product
 * counts and a cover image. The same names work as a `?category=` filter on
 * /products, which is why the client can navigate straight from a tile.
 */
export function listCategories({ catalog }: { catalog: Catalog }) {
  return async (req: Request, res: Response) => {
    const page = pageFrom(req.query.page);
    const limit = limitFrom(req.query.limit);
    const result = await catalog.categories(page, limit);
    res.json({ paging: result.paging, items: result.items });
  };
}

export default listCategories;
