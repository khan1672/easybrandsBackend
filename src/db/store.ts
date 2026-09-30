import { loadJsonl } from '../loaders/jsonl.js';
import type { ProductDoc, BrandSummary } from '../types.js';
import { scoreProduct, searchPhrase, searchTerms, tokenize } from './searchRelevance.js';

/**
 * In-memory read model of the full catalog. Built once at boot from the
 * durable JSONL; every query family is then sub-ms with zero I/O.
 */
export class ProductStore {
  readonly docs: ProductDoc[];
  private readonly slugCache = new Map<string, ProductDoc>();
  private readonly slugIndex = new Map<string, number>();
  private readonly browse = new Map<string, number[]>();
  private readonly postings = new Map<string, number[]>();

  constructor(docs: ProductDoc[]) {
    this.docs = docs;
    this.index();
    Object.freeze(this.docs);
  }

  get count(): number {
    return this.docs.length;
  }

  private index(): void {
    const docs = this.docs;
    for (let i = 0; i < docs.length; i += 1) {
      const d = docs[i]!;
      const brandKey = String(d.brand_name || '').trim().toLowerCase();
      const handle = String(d.handle || '').trim().toLowerCase();
      const slugKey = `${brandKey}:${handle}`;
      this.slugIndex.set(slugKey, i);
      if (!this.slugCache.has(slugKey)) this.slugCache.set(slugKey, d);

      const catKey = String(d.category || '').trim().toLowerCase();
      const push = (key: string, id: number) => {
        const arr = this.browse.get(key);
        if (arr) arr.push(id);
        else this.browse.set(key, [id]);
      };
      // An empty brand or category segment is the wildcard for "any", so a
      // scope with no brand (a global facets call, or browsing one category
      // across all brands) is still a single index hit instead of a miss.
      push(`||0`, i);
      if (d.available !== false) push(`||1`, i);
      if (catKey) {
        push(`|${catKey}|0`, i);
        if (d.available !== false) push(`|${catKey}|1`, i);
      }
      push(`${brandKey}||0`, i);
      if (d.available !== false) push(`${brandKey}||1`, i);
      if (catKey) {
        push(`${brandKey}|${catKey}|0`, i);
        if (d.available !== false) push(`${brandKey}|${catKey}|1`, i);
      }

      for (const tok of tokenize(
        [d.brand_name, d.title, d.category, ...(d.tags || []), d.description].join(' '),
      )) {
        const arr = this.postings.get(tok);
        if (arr) arr.push(i);
        else this.postings.set(tok, [i]);
      }
    }

    for (const ids of this.browse.values()) {
      ids.sort((a, b) => {
        const da = this.docs[a]!;
        const db = this.docs[b]!;
        const priceA = Number.isFinite(da.price) ? da.price! : Infinity;
        const priceB = Number.isFinite(db.price) ? db.price! : Infinity;
        if (priceA !== priceB) return priceA - priceB;
        return 0;
      });
    }
  }

  bySlug(slug: string, brand?: string): ProductDoc | null {
    const raw = String(slug || '').trim();
    const handle = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    if (!handle) return null;
    const hKey = handle.trim().toLowerCase();
    const b = brand ? String(brand).trim().toLowerCase() : raw.includes(':') ? raw.slice(0, raw.indexOf(':')).trim().toLowerCase() : '';
    const hit = this.slugIndex.get(`${b}:${hKey}`);
    if (hit === undefined) return null;
    return this.docs[hit] ?? null;
  }

  /**
   * True when `category` is stored verbatim for this brand.
   *
   * The browse index is keyed by the raw `category` value, but callers send
   * canonical names ("Ready to Wear" for raw "RTW"), so a raw-key lookup can
   * legitimately miss. Callers use this to decide whether the fast path is
   * safe or whether they must fall back to a canonical comparison.
   */
  hasRawCategory(brand: string | undefined, category: string): boolean {
    const b = String(brand || '').trim().toLowerCase();
    const c = category.trim().toLowerCase();
    return this.browse.has(`${b}|${c}|1`) || this.browse.has(`${b}|${c}|0`);
  }

  browseRows(opts: { brand?: string; category?: string; availableOnly?: boolean }): number[] {
    const b = String(opts.brand || '').trim().toLowerCase();
    const c = String(opts.category || '').trim().toLowerCase();
    const a = opts.availableOnly === false ? 0 : 1;
    const hit = this.browse.get(`${b}|${c}|${a}`);
    if (hit) return hit;
    const fallback = this.browse.get(`${b}|${c}|0`);
    return fallback || [];
  }

  searchRows(q: string, brand?: string, availableOnly = true): number[] {
    const toks = searchTerms(q);
    if (toks.length === 0) return [];
    const phrase = searchPhrase(toks);
    let candidate: number[] | null = null;
    for (const t of toks) {
      const ids = this.postings.get(t);
      if (!ids || ids.length === 0) return [];
      candidate = candidate === null ? [...ids] : candidate.filter((x) => ids.includes(x));
      if (candidate.length === 0) return [];
    }
    const b = String(brand || '').trim().toLowerCase();
    const out = (candidate || []).filter((i) => {
      const d = this.docs[i]!;
      if (b && String(d.brand_name || '').toLowerCase() !== b) return false;
      if (availableOnly && d.available === false) return false;
      return true;
    });
    // Relevance first, then the shorter title (a more specific product), then
    // price, so equal-relevance hits come back in a stable order.
    out.sort((x, y) => {
      const dx = this.docs[x]!;
      const dy = this.docs[y]!;
      const sx = scoreProduct(dx, phrase, toks);
      const sy = scoreProduct(dy, phrase, toks);
      if (sx !== sy) return sy - sx;
      const lx = String(dx.title || '').length;
      const ly = String(dy.title || '').length;
      if (lx !== ly) return lx - ly;
      const px = Number.isFinite(dx.price) ? dx.price! : Infinity;
      const py = Number.isFinite(dy.price) ? dy.price! : Infinity;
      return px - py;
    });
    return out;
  }

  brands(): BrandSummary[] {
    const map = new Map<string, BrandSummary & { cats: Set<string> }>();
    for (const d of this.docs) {
      const key = String(d.brand_name || '').trim();
      if (!key) continue;
      let row = map.get(key);
      if (!row) {
        row = { brand_name: key, website: String(d.website || ''), image: '', products: 0, available: 0, categories: 0, cats: new Set() };
        map.set(key, row);
      }
      if (!row.image && typeof d.primary_image === 'string' && d.primary_image.trim()) {
        row.image = d.primary_image.trim();
      }
      row.products += 1;
      if (d.available !== false) row.available += 1;
      if (d.category) row.cats.add(String(d.category).trim());
    }
    return [...map.values()]
      .map((r) => ({ brand_name: r.brand_name, website: r.website, image: r.image, products: r.products, available: r.available, categories: r.cats.size }))
      .sort((a, b) => a.brand_name.localeCompare(b.brand_name));
  }
}

export async function buildStore(dataFile: string): Promise<ProductStore> {
  const docs = await loadJsonl(dataFile);
  return new ProductStore(docs);
}

export default ProductStore;
