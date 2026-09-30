import type { ProductDoc } from '../types.js';

/**
 * Sort keys offered by GET /products.
 *
 * There is deliberately no "newest" option: every document in the collection
 * carries the same `_product_collected_at` (a single scrape run), so sorting by
 * recency would be a no-op that looks like a working feature.
 */
export const SORT_KEYS = ['price_asc', 'price_desc', 'name_asc'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const DEFAULT_SORT: SortKey = 'price_asc';

export const isSortKey = (value: unknown): value is SortKey =>
  typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);

/** Priceless products sort last, matching the default browse order. */
const priceOf = (doc: ProductDoc): number => {
  const price = Number(doc.price);
  return Number.isFinite(price) && price > 0 ? price : Infinity;
};

const byName = (a: ProductDoc, b: ProductDoc): number =>
  String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }) ||
  String(a.handle || '').localeCompare(String(b.handle || ''));

export const compareBySort = (sort: SortKey) => (a: ProductDoc, b: ProductDoc): number => {
  if (sort === 'name_asc') return byName(a, b);
  const pa = priceOf(a);
  const pb = priceOf(b);
  if (pa !== pb) return sort === 'price_desc' ? pb - pa : pa - pb;
  // Stable, deterministic tiebreak so paging cannot repeat or skip a document.
  return String(a.handle || '').localeCompare(String(b.handle || ''));
};

/** Accepts an array or a comma-separated string, dropping blanks and dupes. */
export const normaliseBrands = (input: string | readonly string[] | undefined): string[] => {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const seen = new Set<string>();
  for (const entry of raw) {
    const name = String(entry ?? '').trim();
    if (name) seen.add(name);
  }
  return [...seen];
};

/**
 * Products whose storefront page no longer exists. ``check_product_links.py``
 * marks these ``dead``; a shopper tapping one lands on the brand's own not-found
 * page, so they are kept out of listings and facet counts. Stock is untouched:
 * a product can be out of stock and still have a working page.
 */
const DELISTED_LINK_STATUS = 'dead';

export interface ScopeFilters {
  brands?: readonly string[];
  minPrice?: number;
  maxPrice?: number;
  availableOnly?: boolean;
}

const priceBounds = (filters: ScopeFilters): Record<string, number> => {
  const bounds: Record<string, number> = {};
  if (typeof filters.minPrice === 'number' && Number.isFinite(filters.minPrice)) {
    bounds.$gte = filters.minPrice;
  }
  if (typeof filters.maxPrice === 'number' && Number.isFinite(filters.maxPrice)) {
    bounds.$lte = filters.maxPrice;
  }
  return bounds;
};

/** In-memory equivalent of {@link scopeFilter}, for the JSONL catalog. */
export const matchesScope = (doc: ProductDoc, filters: ScopeFilters): boolean => {
  const brands = normaliseBrands(filters.brands);
  if (brands.length > 0 && !brands.includes(String(doc.brand_name || '').trim())) {
    return false;
  }
  if (filters.availableOnly !== false && doc.available === false) {
    return false;
  }
  if (doc.product_link_status === DELISTED_LINK_STATUS) {
    return false;
  }
  const price = Number(doc.price);
  const hasPrice = Number.isFinite(price);
  if (typeof filters.minPrice === 'number' && Number.isFinite(filters.minPrice)) {
    if (!hasPrice || price < filters.minPrice) return false;
  }
  if (typeof filters.maxPrice === 'number' && Number.isFinite(filters.maxPrice)) {
    if (!hasPrice || price > filters.maxPrice) return false;
  }
  return true;
};

/** Mongo counterpart of {@link matchesScope}. Category is layered on separately. */
export const scopeFilter = (filters: ScopeFilters): Record<string, unknown> => {
  const filter: Record<string, unknown> = {};
  const brands = normaliseBrands(filters.brands);
  if (brands.length === 1) filter.brand_name = brands[0];
  else if (brands.length > 1) filter.brand_name = { $in: brands };
  if (filters.availableOnly !== false) filter.available = { $ne: false };
  filter.product_link_status = { $ne: DELISTED_LINK_STATUS };
  const bounds = priceBounds(filters);
  if (Object.keys(bounds).length > 0) filter.price = bounds;
  return filter;
};

export interface FacetBrand {
  name: string;
  count: number;
}

export interface Facets {
  brands: FacetBrand[];
  price: { min: number; max: number };
  total: number;
}
