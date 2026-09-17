import type { Request, Response } from 'express';
import type { ProductStore } from '../db/store.js';
import type { AtlasSummary } from '../db/atlas.js';

export function health({ store, atlas }: { store: ProductStore; atlas: AtlasSummary | null }) {
  return (_req: Request, res: Response) => {
    res.json({
      ok: true,
      docs: store.count,
      products: store.count,
      brands: store.brands().length,
      bootedAt: new Date().toISOString(),
      atlas: atlas?.reachable ? 'online' : 'offline',
    });
  };
}

export default health;
