import type { Catalog, BrowseOpts, BrowseResult, CategoryRow } from './catalog.js';
import type { ProductDoc } from '../types.js';
import { buildMongoCollection, type MongoContext } from './mongo.js';
import { canonicalCategory, foldCategories, type RawCategoryTally } from './categoryTaxonomy.js';
import { scopeFilter, type Facets } from './productFilters.js';
import type { SortKey } from './productFilters.js';
import {
  escapeRegex,
  RELEVANCE_WEIGHTS,
  searchPhrase,
  searchTerms,
} from './searchRelevance.js';

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
    const filter: Record<string, unknown> = {
      ...scopeFilter({
        brands: opts.brands ?? (opts.brand ? [opts.brand] : undefined),
        minPrice: opts.minPrice,
        maxPrice: opts.maxPrice,
        availableOnly: opts.availableOnly,
      }),
    };
    if (opts.category) Object.assign(filter, await this.categoryFilter(opts.category));
    return filter;
  }

  /** Mongo sort document for a `SortKey`, keeping priceless products last. */
  private sortStage(sort: SortKey | undefined): Record<string, 1 | -1> {
    if (sort === 'name_asc') return { title: 1, handle: 1 };
    if (sort === 'price_desc') return { __sortPrice: -1, _id: 1 };
    return { __sortPrice: 1, _id: 1 };
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
        { $sort: this.sortStage(opts.sort) },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: { __sortPrice: 0 } },
      ])
      .toArray()) as ProductDoc[];
    return { paging: { page, limit, offset: (page - 1) * limit, total }, items: docs };
  }

  async search(q: string, opts: BrowseOpts, page: number, limit: number): Promise<BrowseResult<ProductDoc>> {
    const terms = searchTerms(q);
    if (terms.length === 0) return { paging: { page, limit, offset: 0, total: 0 }, items: [] };
    const phrase = searchPhrase(terms);

    const and: Record<string, unknown>[] = terms.map((t: string) => ({
      $or: [
        { title: { $regex: t, $options: 'i' } },
        { brand_name: { $regex: t, $options: 'i' } },
        { category: { $regex: t, $options: 'i' } },
        { tags: { $regex: t, $options: 'i' } },
        { description: { $regex: t, $options: 'i' } },
      ],
    }));
    const filter: Record<string, unknown> = { $and: and };
    Object.assign(
      filter,
      scopeFilter({
        brands: opts.brands ?? (opts.brand ? [opts.brand] : undefined),
        minPrice: opts.minPrice,
        maxPrice: opts.maxPrice,
        availableOnly: opts.availableOnly,
      }),
    );
    if (opts.category) Object.assign(filter, await this.categoryFilter(opts.category));

    const total = await this.col.countDocuments(filter);
    const docs = (await this.col
      .aggregate([
        { $match: filter },
        {
          $addFields: {
            __relevance: this.relevanceExpr(phrase, terms),
            __titleLen: { $strLenCP: { $ifNull: ['$title', ''] } },
            // Products with no real price must sort last, not first (Mongo
            // sorts missing/null before numbers on an ascending price sort).
            __sortPrice: { $cond: [{ $gt: [{ $ifNull: ['$price', 0] }, 0] }, '$price', 1e15] },
          },
        },
        { $sort: { __relevance: -1, __titleLen: 1, ...this.sortStage(opts.sort) } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: { __relevance: 0, __titleLen: 0, __sortPrice: 0 } },
      ])
      .toArray()) as ProductDoc[];
    return { paging: { page, limit, offset: (page - 1) * limit, total }, items: docs };
  }

  /**
   * Server-side mirror of `scoreProduct`, built from the shared
   * `RELEVANCE_WEIGHTS` so both catalogs rank the same results identically.
   * Emitted as a `$cond` per tier that contributes its weight when the pattern
   * matches, summed with `$add`.
   */
  private relevanceExpr(phrase: string, terms: string[]): Record<string, unknown> {
    const W = RELEVANCE_WEIGHTS;
    const title = '$title';
    const brand = { $ifNull: ['$brand_name', ''] };
    const category = { $ifNull: ['$category', ''] };
    const description = { $ifNull: ['$description', ''] };

    // `$regexMatch` only accepts a string, and `tags` is an array, so array
    // matching maps the regex over the elements and reduces with
    // `$anyElementTrue`. Doing it per element also keeps `^tag$` meaning
    // "equals this whole tag" instead of "starts with the joined list".
    const matches = (input: unknown, pattern: string): Record<string, unknown> => ({
      $regexMatch: { input, regex: pattern, options: 'i' },
    });
    const anyTag = (pattern: string): Record<string, unknown> => ({
      $anyElementTrue: {
        $map: { input: { $ifNull: ['$tags', []] }, as: 'tag', in: matches('$$tag', pattern) },
      },
    });
    const hit = (cond: unknown, weight: number): Record<string, unknown> => ({
      $cond: [cond, weight, 0],
    });

    const p = escapeRegex(phrase);
    const parts: unknown[] = [
      hit(matches(brand, `^${p}$`), W.brandExact),
      hit(matches(title, `^${p}`), W.titlePrefix),
      hit(matches(title, p), W.titlePhrase),
      hit(matches(brand, p), W.brandPhrase),
      hit(anyTag(`^${p}$`), W.tagExact),
      hit(anyTag(p), W.tagPhrase),
      hit(matches(description, p), W.descriptionPhrase),
    ];
    for (const t of terms) {
      const rx = escapeRegex(t);
      parts.push(hit(matches(title, rx), W.termInTitle));
      parts.push(hit(matches(brand, rx), W.termInBrand));
      parts.push(hit(anyTag(rx), W.termInTag));
      parts.push(hit(matches(category, rx), W.termInCategory));
    }
    return { $add: parts };
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

  async facets(opts: BrowseOpts): Promise<Facets> {
    // Brand and price selections are intentionally ignored: a facet must list
    // what can still be chosen, not what the current selection already cut down.
    const filter: Record<string, unknown> = { available: { $ne: false } };
    if (opts.category) Object.assign(filter, await this.categoryFilter(opts.category));

    const [brandRows, bounds] = await Promise.all([
      this.col
        .aggregate([
          { $match: filter },
          { $group: { _id: '$brand_name', count: { $sum: 1 } } },
          { $match: { _id: { $type: 'string', $ne: '' } } },
          { $sort: { count: -1, _id: 1 } },
        ])
        .toArray() as Promise<{ _id: string; count: number }[]>,
      this.col
        .aggregate([
          { $match: filter },
          { $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' }, total: { $sum: 1 } } },
        ])
        .toArray() as Promise<
          { _id: null; min: number | null; max: number | null; total: number }[]
        >,
    ]);

    const row = bounds[0];
    const min = Number(row?.min ?? 0);
    const max = Number(row?.max ?? 0);
    return {
      brands: brandRows.map((b) => ({ name: b._id, count: b.count })),
      // A category can legitimately contain only priceless products, in which
      // case there is no meaningful range to offer.
      price: { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 },
      total: row?.total ?? 0,
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
