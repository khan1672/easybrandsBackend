import type { Catalog, BrowseOpts, BrowseResult, CategoryRow } from './catalog.js';
import type { ProductDoc } from '../types.js';
import { buildMongoCollection, type MongoContext } from './mongo.js';
import { canonicalCategory, foldCategories, type RawCategoryTally } from './categoryTaxonomy.js';

/**
 * MongoDB-backed catalog. This is the source of truth when MONGO_URI is set:
 * every read (by slug, browse, search, brands) is a real query, so the API and
 * therefore the mobile app are served from Mongo rather than from memory.
 */
export class MongoCatalog implements Catalog {
  readonly source = 'mongodb' as const;

  constructor(private readonly ctx: MongoContext) {}

  private get col() {
    return this.ctx.collection();
  }

  async count(): Promise<number> {
    return this.col.countDocuments();
  }

  async brandCount(): Promise<number> {
    const rows = await this.col.aggregate([{ $group: { _id: '$brand_name' } }]).toArray();
    return rows.length;
  }

  async bySlug(slug: string, brand?: string): Promise<ProductDoc | null> {
    const raw = String(slug || '').trim();
    const hasBrandPrefix = raw.includes(':');
    const handle = hasBrandPrefix ? raw.slice(raw.indexOf(':') + 1) : raw;
    const brandName = brand
      ? String(brand).trim()
      : hasBrandPrefix
        ? raw.slice(0, raw.indexOf(':')).trim()
        : undefined;
    if (!handle) return null;

    const filter: Record<string, unknown> = { handle };
    if (brandName) filter.brand_name = brandName;
    return (await this.col.findOne(filter)) as ProductDoc | null;
  }

  /**
   * Resolves a requested category to the raw values that fold into it, so
   * `?category=Ready to Wear` also returns products the merchant labelled
   * "RTW", "RTW Basic", "Stitched Lawn" and so on. Falls back to a literal
   * match when the value is not part of the taxonomy at all.
   */
  private async categoryFilter(category: string): Promise<Record<string, unknown>> {
    const wanted = String(category).trim();
    const values = (await this.col.distinct('category')) as string[];
    const canonical = canonicalCategory(wanted);
    const matches = values.filter((value) => canonicalCategory(value) === canonical);
    return matches.length > 0 ? { category: { $in: matches } } : { category: wanted };
  }

  private async browseFilter(opts: BrowseOpts): Promise<Record<string, unknown>> {
    const filter: Record<string, unknown> = {};
    if (opts.brand) filter.brand_name = String(opts.brand).trim();
    if (opts.category) Object.assign(filter, await this.categoryFilter(opts.category));
    if (opts.availableOnly !== false) filter.available = { $ne: false };
    return filter;
  }

  async browse(opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>> {
    const filter = await this.browseFilter(opts);
    const total = await this.col.countDocuments(filter);
    const docs = (await this.col
      .aggregate([
        { $match: filter },
        // Products with no real price must sort last, not first (Mongo sorts
        // missing/null before numbers on an ascending price sort).
        { $addFields: { __sortPrice: { $cond: [{ $gt: [{ $ifNull: ['$price', 0] }, 0] }, '$price', 1e15] } } },
        { $sort: { __sortPrice: 1, _id: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: { __sortPrice: 0 } },
      ])
      .toArray()) as ProductDoc[];
    return { paging: { page, limit, offset: (page - 1) * limit, total }, items: docs };
  }

  async search(q: string, opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>> {
    const terms = String(q || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || [];
    if (terms.length === 0) return { paging: { page, limit, offset: 0, total: 0 }, items: [] };

    const and: Record<string, unknown>[] = terms.map((t) => ({
      $or: [
        { title: { $regex: t, $options: 'i' } },
        { category: { $regex: t, $options: 'i' } },
        { tags: { $regex: t, $options: 'i' } },
        { description: { $regex: t, $options: 'i' } },
      ],
    }));
    const filter: Record<string, unknown> = { $and: and };
    if (opts.brand) filter.brand_name = String(opts.brand).trim();
    if (opts.category) Object.assign(filter, await this.categoryFilter(opts.category));
    if (opts.availableOnly !== false) filter.available = { $ne: false };

    const total = await this.col.countDocuments(filter);
    const docs = (await this.col
      .aggregate([
        { $match: filter },
        { $addFields: { __sortPrice: { $cond: [{ $gt: [{ $ifNull: ['$price', 0] }, 0] }, '$price', 1e15] } } },
        { $sort: { __sortPrice: 1, _id: 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: { __sortPrice: 0 } },
      ])
      .toArray()) as ProductDoc[];
    return { paging: { page, limit, offset: (page - 1) * limit, total }, items: docs };
  }

  async brands(
    page: number,
    limit: number,
  ): Promise<BrowseResult<{ brand_name: string; website?: string; image?: string; products: number; available: number; categories: number }>> {
    const rows = (await this.col
      .aggregate([
        {
          $group: {
            _id: '$brand_name',
            website: { $first: '$website' },
            image: { $top: { sortBy: { primary_image: -1 }, output: '$primary_image' } },
            products: { $sum: 1 },
            cats: { $addToSet: '$category' },
          },
        },
        {
          $project: {
            _id: 0,
            brand_name: '$_id',
            website: 1,
            image: 1,
            products: 1,
            categories: { $size: { $filter: { input: '$cats', cond: { $ne: ['$$this', null] } } } },
          },
        },
        { $sort: { brand_name: 1 } },
      ])
      .toArray()) as { brand_name: string; website?: string; image?: string; products: number; categories: number }[];

    const withAvailable = rows.map((r) => ({ ...r, available: r.products }));
    const offset = (page - 1) * limit;
    return {
      paging: { page, limit, offset, total: withAvailable.length },
      items: withAvailable.slice(offset, offset + limit),
    };
  }

  async categories(page: number, limit: number): Promise<BrowseResult<CategoryRow>> {
    // One pass over the raw values; the folding into canonical buckets is done
    // in TypeScript so the taxonomy rules stay in a single place.
    const rows = (await this.col
      .aggregate([
        {
          $group: {
            _id: { $ifNull: ['$category', ''] },
            products: { $sum: 1 },
            brandNames: { $addToSet: '$brand_name' },
            image: { $top: { sortBy: { primary_image: -1 }, output: '$primary_image' } },
          },
        },
        { $project: { _id: 0, name: '$_id', products: 1, brandNames: 1, image: 1 } },
      ])
      .toArray()) as RawCategoryTally[];

    const all = foldCategories(rows);
    const offset = (page - 1) * limit;
    return {
      paging: { page, limit, offset, total: all.length },
      items: all.slice(offset, offset + limit),
    };
  }

  async close(): Promise<void> {
    await this.ctx.close();
  }
}

export default MongoCatalog;
