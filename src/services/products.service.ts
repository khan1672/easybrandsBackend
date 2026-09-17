import type { ProductStore } from '../db/store.js';
import type { Paging, ProductDoc } from '../types.js';

export interface Scope {
  brand?: string;
  category?: string;
  availableOnly?: boolean;
}

export function browse(store: ProductStore, scope: Scope): number[] {
  return store.browseRows(scope);
}

export function search(
  store: ProductStore,
  q: string,
  opts: { brand?: string; availableOnly?: boolean },
): number[] {
  return store.searchRows(q, opts.brand, opts.availableOnly !== false);
}

export function paginate<T>(rows: T[], { page, limit }: { page: number; limit: number }): { paging: Paging; rows: T[] } {
  const total = rows.length;
  const offset = (page - 1) * limit;
  return { paging: { page, limit, offset, total }, rows: rows.slice(offset, offset + limit) };
}

export function rowsToDocs(store: ProductStore, rows: number[]): ProductDoc[] {
  return rows.map((i) => store.docs[i]).filter((d): d is ProductDoc => Boolean(d));
}

export default { browse, search, paginate, rowsToDocs };
