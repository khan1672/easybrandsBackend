import type { Env } from '../config/env.js';
import type { ProductDoc } from '../types.js';
import { foldCategories } from './categoryTaxonomy.js';
import { ProductStore } from './store.js';

/**
 * Catalog is the read surface the API is written against. It is backed by
 * either the JSONL-derived in-memory index or MongoDB, chosen at boot by
 * whether MONGO_URI is set. Response shapes are identical either way, so
 * clients (including the mobile app) cannot tell the difference.
 */
export interface BrowseOpts {
  brand?: string;
  category?: string;
  availableOnly?: boolean;
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

  async browse(opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>> {
    const ids = this.store.browseRows(opts);
    const items = slice(
      ids.map((i) => this.store.docs[i]).filter((d): d is ProductDoc => Boolean(d)),
      page,
      limit,
    );
    return { paging: pagingOf(page, limit, ids.length), items };
  }

  async search(q: string, opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>> {
    const ids = this.store.searchRows(q, opts.brand, opts.availableOnly !== false);
    const items = slice(
      ids.map((i) => this.store.docs[i]).filter((d): d is ProductDoc => Boolean(d)),
      page,
      limit,
    );
    return { paging: pagingOf(page, limit, ids.length), items };
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
