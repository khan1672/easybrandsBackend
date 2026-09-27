import type { Env } from '../config/env.js';
import type { ProductDoc } from '../types.js';
import { foldCategories, canonicalCategory } from './categoryTaxonomy.js';
import { compareBySort, matchesScope, normaliseBrands, type Facets, type SortKey } from './productFilters.js';
import { ProductStore } from './store.js';

/**
 * Catalog is the read surface the API is written against. It is backed by
 * either the JSONL-derived in-memory index or MongoDB, chosen at boot by
 * whether MONGO_URI is set. Response shapes are identical either way, so
 * clients (including the mobile app) cannot tell the difference.
 */
export interface BrowseOpts {
  brand?: string;
  /** Multi-brand selection; takes precedence over `brand` when both are given. */
  brands?: string[];
  category?: string;
  availableOnly?: boolean;
  minPrice?: number;
  maxPrice?: number;
  sort?: SortKey;
}

export interface BrowseResult<T> {
  paging: { page: number; limit: number; offset: number; total: number };
  items: T[];
}

export interface BrandRow {
  brand_name: string;
  website?: string;
  image?: string;
  products: number;
  available: number;
  categories: number;
}

/** A product category, folded from the merchants' raw `product_type` values. */
export interface CategoryRow {
  name: string;
  slug: string;
  products: number;
  brands: number;
  image?: string;
}

export interface Catalog {
  readonly source: 'jsonl' | 'mongodb';
  count(): Promise<number>;
  brandCount(): Promise<number>;
  bySlug(slug: string, brand?: string): Promise<ProductDoc | null>;
  browse(opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>>;
  search(q: string, opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>>;
  brands(page: number, limit: number): Promise<BrowseResult<BrandRow>>;
  categories(page: number, limit: number): Promise<BrowseResult<CategoryRow>>;
  /**
   * Brand counts and a price range for the current scope, so a client can show
   * filter options without downloading the whole category. Brand/price
   * selections are deliberately ignored here: a facet must describe what can
   * still be chosen.
   */
  facets(opts: BrowseOpts): Promise<Facets>;
  close(): Promise<void>;
}

function pagingOf(page: number, limit: number, total: number) {
  return { page, limit, offset: (page - 1) * limit, total };
}

function slice<T>(rows: T[], page: number, limit: number) {
  const offset = (page - 1) * limit;
  return rows.slice(offset, offset + limit);
}

/** JSONL-backed catalog: the original in-memory index, async-facade only. */
export class JsonlCatalog implements Catalog {
  readonly source = 'jsonl' as const;

  constructor(private readonly store: ProductStore) {}

  async count(): Promise<number> {
    return this.store.count;
  }

  async brandCount(): Promise<number> {
    return this.store.brands().length;
  }

  async bySlug(slug: string, brand?: string): Promise<ProductDoc | null> {
    return this.store.bySlug(slug, brand);
  }

  /**
   * Candidate rows for a scope. The store indexes a single brand plus the raw
   * category string, so a multi-brand or canonical-category scope falls back to
   * a scan and is then filtered in memory like any other predicate.
   */
  private scopeRows(opts: BrowseOpts): number[] {
    const brands = normaliseBrands(opts.brands ?? (opts.brand ? [opts.brand] : undefined));
    const multiBrand = brands.length > 1;
    const canonicalRequest = Boolean(
      opts.category && canonicalCategory(opts.category) !== opts.category.trim(),
    );
    if (!multiBrand && !canonicalRequest) {
      return this.store.browseRows({
        brand: brands[0],
        category: opts.category,
        availableOnly: opts.availableOnly,
      });
    }
    return this.store.docs.map((_, i) => i);
  }

  private inScope(opts: BrowseOpts, id: number): boolean {
    const doc = this.store.docs[id];
    if (!doc) return false;
    const brands = normaliseBrands(opts.brands ?? (opts.brand ? [opts.brand] : undefined));
    const scope = {
      brands,
      availableOnly: opts.availableOnly,
      minPrice: opts.minPrice,
      maxPrice: opts.maxPrice,
    };
    if (!matchesScope(doc, scope)) return false;
    if (opts.category && canonicalCategory(opts.category) !== canonicalCategory(doc.category)) {
      return false;
    }
    return true;
  }

  async browse(opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>> {
    const candidates = this.scopeRows(opts);
    const matched = candidates.filter((id) => this.inScope(opts, id));
    const docs = matched
      .map((i) => this.store.docs[i])
      .filter((d): d is ProductDoc => Boolean(d))
      .sort(compareBySort(opts.sort ?? 'price_asc'));
    return { paging: pagingOf(page, limit, docs.length), items: slice(docs, page, limit) };
  }

  async search(q: string, opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>> {
    const ids = this.store.searchRows(q, opts.brand, opts.availableOnly !== false);
    const docs = ids
      .filter((id) => this.inScope(opts, id))
      .map((i) => this.store.docs[i])
      .filter((d): d is ProductDoc => Boolean(d))
      .sort(compareBySort(opts.sort ?? 'price_asc'));
    return { paging: pagingOf(page, limit, docs.length), items: slice(docs, page, limit) };
  }

  async brands(
    page: number,
    limit: number,
  ): Promise<BrowseResult<BrandRow>> {
    const all = this.store.brands();
    return { paging: pagingOf(page, limit, all.length), items: slice(all, page, limit) };
  }

  async categories(page: number, limit: number): Promise<BrowseResult<CategoryRow>> {
    const tallies = new Map<string, { products: number; brands: Set<string>; image?: string }>();
    for (const doc of this.store.docs) {
      const key = doc.category ?? '';
      const entry = tallies.get(key) ?? { products: 0, brands: new Set<string>(), image: undefined };
      entry.products += 1;
      if (doc.brand_name) entry.brands.add(doc.brand_name);
      if (!entry.image && doc.primary_image) entry.image = doc.primary_image;
      tallies.set(key, entry);
    }
    const all = foldCategories(
      [...tallies.entries()].map(([name, entry]) => ({
        name,
        products: entry.products,
        brandNames: [...entry.brands],
        image: entry.image,
      })),
    );
    return { paging: pagingOf(page, limit, all.length), items: slice(all, page, limit) };
  }

  async facets(opts: BrowseOpts): Promise<Facets> {
    // Brand/price selections are excluded on purpose: a facet describes what is
    // still selectable, not what the current selection already narrowed to.
    const scope: BrowseOpts = { category: opts.category, availableOnly: opts.availableOnly };
    const counts = new Map<string, number>();
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    let total = 0;
    for (const id of this.scopeRows(scope)) {
      if (!this.inScope(scope, id)) continue;
      const doc = this.store.docs[id];
      if (!doc) continue;
      total += 1;
      const brand = String(doc.brand_name || '').trim();
      if (brand) counts.set(brand, (counts.get(brand) ?? 0) + 1);
      const price = Number(doc.price);
      if (Number.isFinite(price) && price > 0) {
        if (price < min) min = price;
        if (price > max) max = price;
      }
    }
    return {
      brands: [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      price: { min: Number.isFinite(min) ? min : 0, max },
      total,
    };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

/** Seed Mongo from the JSONL catalog when the collection is empty. */
export async function seedMongoFromJsonl(
  store: ProductStore,
  env: Pick<Env, 'mongoUri' | 'mongoDb' | 'mongoCollection'>,
): Promise<{ seeded: number; skipped: boolean }> {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const col = client.db(env.mongoDb).collection(env.mongoCollection);
    const existing = await col.countDocuments();
    if (existing > 0) return { seeded: 0, skipped: true };

    const CHUNK = 500;
    const docs = store.docs;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const chunk = docs.slice(i, i + CHUNK);
      await col.bulkWrite(
        chunk.map((d) => ({
          replaceOne: {
            filter: { brand_name: d.brand_name, handle: d.handle },
            replacement: d,
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    return { seeded: docs.length, skipped: false };
  } finally {
    await client.close().catch(() => {});
  }
}
