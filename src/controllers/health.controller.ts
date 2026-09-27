import type { Request, Response } from 'express';
import type { Catalog } from '../db/catalog.js';

export function health({ catalog }: { catalog: Catalog }) {
  return async (_req: Request, res: Response) => {
    const [docs, brands] = await Promise.all([catalog.count(), catalog.brandCount()]);
    res.json({
      ok: true,
      docs,
      products: docs,
      brands,
      bootedAt: new Date().toISOString(),
      source: catalog.source,
    });
  };
}

export default health;
