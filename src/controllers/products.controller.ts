import type { Request, Response } from 'express';
import type { Catalog, BrowseOpts } from '../db/catalog.js';
import { isSortKey, normaliseBrands, DEFAULT_SORT, type SortKey } from '../db/productFilters.js';
import type { ProductDoc } from '../types.js';

function availableOnlyFrom(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}
function pageFrom(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function limitFrom(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
}

function numberFrom(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function scopeFrom(req: Request): BrowseOpts {
  const brand = req.query.brand ? String(req.query.brand).trim() : undefined;
  const category = req.query.category ? String(req.query.category).trim() : undefined;
  // `brand` may repeat or be comma-separated: ?brand=Edenrobe,HSY
  const repeated = Array.isArray(req.query.brand) ? req.query.brand.map(String) : undefined;
  const brands = normaliseBrands(repeated ?? brand);
  const sort: SortKey = isSortKey(req.query.sort) ? req.query.sort : DEFAULT_SORT;
  return {
    brand,
    ...(brands.length > 0 ? { brands } : {}),
    category,
    availableOnly: availableOnlyFrom(req.query.available),
    minPrice: numberFrom(req.query.minPrice),
    maxPrice: numberFrom(req.query.maxPrice),
    sort,
  };
}

/** Filter options for the scope a client is browsing. */
export function productFacets({ catalog }: { catalog: Catalog }) {
  return async (req: Request, res: Response) => {
    const facets = await catalog.facets(scopeFrom(req));
    return res.json(facets);
  };
}

export function getProduct({ catalog }: { catalog: Catalog }) {
  return async (req: Request, res: Response) => {
    const slug = String(req.params.slug || '').trim();
    const brand = req.query.brand ? String(req.query.brand).trim() : undefined;
    const doc = await catalog.bySlug(slug, brand);
    if (!doc) return res.status(404).json({ error: 'Product not found', slug, brand: brand || undefined });
    return res.json({ product: doc as ProductDoc });
  };
}

export function browseProducts({ catalog }: { catalog: Catalog }) {
  return async (req: Request, res: Response) => {
    const page = pageFrom(req.query.page);
    const limit = limitFrom(req.query.limit);
    const result = await catalog.browse(scopeFrom(req), page, limit);
    res.json({ paging: result.paging, items: result.items });
  };
}

export function searchProducts({ catalog }: { catalog: Catalog }) {
  return async (req: Request, res: Response) => {
    const q = String(req.query.q ? String(req.query.q).trim() : '').trim();
    if (!q) return res.status(400).json({ error: 'Missing required query param: q' });
    const page = pageFrom(req.query.page);
    const limit = limitFrom(req.query.limit);
    const result = await catalog.search(q, scopeFrom(req), page, limit);
    res.json({ paging: result.paging, items: result.items });
  };
}

export default { getProduct, browseProducts, searchProducts };
