import type { Request, Response } from 'express';
import type { ProductStore } from '../db/store.js';
import { browse as browseRows, search as searchRows, paginate, rowsToDocs } from '../services/products.service.js';

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

export function getProduct({ store }: { store: ProductStore }) {
  return (req: Request, res: Response) => {
    const slug = String(req.params.slug || '').trim();
    const brand = req.query.brand ? String(req.query.brand).trim() : undefined;
    const doc = store.bySlug(slug, brand);
    if (!doc) return res.status(404).json({ error: 'Product not found', slug, brand: brand || undefined });
    return res.json({ product: doc });
  };
}

export function browseProducts({ store }: { store: ProductStore }) {
  return (req: Request, res: Response) => {
    const brand = req.query.brand ? String(req.query.brand).trim() : undefined;
    const category = req.query.category ? String(req.query.category).trim() : undefined;
    const availableOnly = availableOnlyFrom(req.query.available);
    const page = pageFrom(req.query.page);
    const limit = limitFrom(req.query.limitapsed);

    const ids = browseRows(store, { brand, category, availableOnly });
    const { paging, rows } = paginate(ids, { page, limit });
    const items = rowsToDocs(store, rows);
    res.json({ paging, items });
  };
}

export function searchProducts({ store }: { store: ProductStore }) {
  return (req: Request, res: Response) => {
    const q = String(req.query.q ? String(req.query.q).trim() : '').trim();
    if (!q) return res.status(400).json({ error: 'Missing required query param: q' });
    const brand = req.query.brand ? String(req.query.brand).trim() : undefined;
    const availableOnly = availableOnlyFrom(req.query.available);
    const page = pageFrom(req.query.page);
    const limit = limitFrom(req.query.limit);

    const ids = searchRows(store, q, { brand, availableOnly });
    const { paging, rows } = paginate(ids, { page, limit });
    res.json({ paging, items: rowsToDocs(store, rows) });
  };
}

export default { getProduct, browseProducts, searchProducts };
