import type { Request, Response } from 'express';
import type { Catalog, BrowseOpts } from '../db/catalog.js';
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

function scopeFrom(req: Request): BrowseOpts {
  const brand = req.query.brand ? String(req.query.brand).trim() : undefined;
  const category = req.query.category ? String(req.query.category).trim() : undefined;
  return { brand, category, availableOnly: availableOnlyFrom(req.query.available) };
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
