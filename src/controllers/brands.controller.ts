import type { Request, Response } from 'express';
import type { ProductStore } from '../db/store.js';
import { paginate } from '../services/products.service.js';

function pageFrom(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function limitFrom(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
}

export function listBrands({ store }: { store: ProductStore }) {
  return (req: Request, res: Response) => {
    const page = pageFrom(req.query.page);
    const limit = limitFrom(req.query.limit);
    const all = store.brands();
    const { paging, rows } = paginate(all, { page, limit });
    res.json({ paging, items: rows });
  };
}

export default listBrands;
