/**
 * Canonical product taxonomy.
 *
 * `product.category` comes straight from each merchant's Shopify `product_type`,
 * so the raw values are long, inconsistent and full of duplicates:
 *
 *     Ready to Wear (252) + Ready To Wear (154) + RTW (66) + RTW Basic (66) …
 *     PRET (84) + Luxury Pret (113) + LUXURY PRET (50) + EXCLUSIVE PRET (103) …
 *     Uncategorized (721), easify_addon_product (1), Payment Link (1) …
 *
 * 192 distinct values for 5,475 products is unusable as a category rail, so we
 * fold them into a small, stable set of canonical categories. The mapping is
 * data-driven and ordered — first match wins — so it can be tuned without
 * touching query code.
 *
 * Two behaviours worth knowing:
 *   * values matching JUNK are dropped entirely (store plugins, internal
 *     helper products, retired duplicates flagged with "-Old"/"-1"/"-2").
 *   * anything unmatched falls into `OTHERS`, so products are never hidden
 *     just because their category string was not recognised.
 */

/** Canonical buckets surfaced by /api/v1/categories. */
export const CATEGORIES = [
  'Ready to Wear',
  'Unstitched',
  'Pret',
  '3 Piece',
  'Kurta & Shalwar',
  'Shirts & Tops',
  'Trousers & Pants',
  'Shirt, Trouser & Dupatta',
  'Fabric',
  'Winter & Outerwear',
  'Kids',
  'Menswear',
  'Accessories',
  'Beauty & Fragrance',
  'Home',
  'Others',
] as const;

export type CanonicalCategory = (typeof CATEGORIES)[number];

export const OTHERS: CanonicalCategory = 'Others';

interface Rule {
  canonical: CanonicalCategory;
  pattern: RegExp;
}

/** Lower-cased and whitespace-collapsed form used for all matching. */
export const normaliseCategory = (raw: string | null | undefined): string =>
  (raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Ordered rules — specific before general. `Unstitched` must be tested before
 * `Women`, and `3 Piece` before `Unstitched`, or products land in the wrong
 * bucket.
 */
const RULES: Rule[] = [
  // --- discarded: merchant tooling / retired rows -----------------------
  { canonical: OTHERS, pattern: /^(easify_addon_product|payment link)$/ },
  { canonical: OTHERS, pattern: /-(old|new|1|2)$/ },

  // --- specific multi-piece sets (before the Unstitched/Pret buckets) ---
  { canonical: '3 Piece', pattern: /(^|\b)(3|2)\s*piece|combo\s*\(?3pc/ },
  { canonical: '3 Piece', pattern: /\b3pc\b/ },

  // --- fabric sold by the metre ----------------------------------------
  { canonical: 'Fabric', pattern: /fabric|meter|poly viscose|loose fabric/ },

  // --- unstitched --------------------------------------------------------
  { canonical: 'Unstitched', pattern: /unstitched|un stitched|btk?-?east|btk?-?west/ },
  { canonical: 'Unstitched', pattern: /lawn$|chiffon$|m\.?prints$/ },
  { canonical: 'Unstitched', pattern: /^women? un/ },

  // --- pret --------------------------------------------------------------
  { canonical: 'Pret', pattern: /pret/ },

  // --- ready to wear -----------------------------------------------------
  { canonical: 'Ready to Wear', pattern: /ready to wear|\brtw\b|ready to wea/ },
  { canonical: 'Ready to Wear', pattern: /luxury formals?|luxury suits?|stitched/ },
  { canonical: 'Ready to Wear', pattern: /western|couture|^\s*flow|^\s*salt|^\s*fashion/ },
  { canonical: 'Ready to Wear', pattern: /^women$|womensclothing|^\s*dresses$/ },
  { canonical: 'Ready to Wear', pattern: /eastern top|waistcoat|blazer|suit$/ },
  { canonical: 'Ready to Wear', pattern: /waist coat suit/ },

  // --- shirt/trouser/dupatta bundles -------------------------------------
  // Must be tested before the generic shirt and trouser rules, otherwise
  // "SHIRT, TROUSER & DUPATTA" is swallowed by the `trouser` pattern.
  { canonical: 'Shirt, Trouser & Dupatta', pattern: /shirt.*(trouser|dupatta|cullet|cullotte|shawl|lining)/ },

  // --- kameez / shalwar --------------------------------------------------
  { canonical: 'Kurta & Shalwar', pattern: /kameez|kurta|shalwar|shalwar kameez/ },

  // --- shirts & tops -----------------------------------------------------
  { canonical: 'Shirts & Tops', pattern: /t-?shirt|tee|sweat|hoodie|polo|jacket|vest|sweatshirt/ },
  { canonical: 'Shirts & Tops', pattern: /^(shirt|men shirts|boys shirts)$/ },

  // --- trousers & bottoms ------------------------------------------------
  { canonical: 'Trousers & Pants', pattern: /trouser|pants|chinos|denim|bottoms|cullotte|culotte/ },
  { canonical: 'Trousers & Pants', pattern: /lowers/ },

  // --- winter ------------------------------------------------------------
  { canonical: 'Winter & Outerwear', pattern: /winter|jacket|blazer/ },

  // --- kids --------------------------------------------------------------
  { canonical: 'Kids', pattern: /kids|^\s*boys|^\s*girls|children/ },

  // --- menswear ----------------------------------------------------------
  { canonical: 'Menswear', pattern: /^\s*men|men's|menswear|mensclothing|sherwani|peeshawari|chappal/ },

  // --- accessories -------------------------------------------------------
  { canonical: 'Accessories', pattern: /accessor|bag|wallet|jewel|earring|necklace|bangle|scarf|dupatta|cap|head wear|tie clip|muffler|shoes|footwear|watch/ },

  // --- beauty & fragrance ------------------------------------------------
  { canonical: 'Beauty & Fragrance', pattern: /beauty|fragrance|perfume|body mist|deodorant|nail|skin care|lipstick|makeup/ },

  // --- home --------------------------------------------------------------
  { canonical: 'Home', pattern: /home|towel|bed ?sheet|bedsheet|place mat|table runner|cushion|decor/ },
];

/** Merchant tooling and retired rows that must never become a category. */
const JUNK = new Set([
  'easify_addon_product',
  'payment link',
  'other-acc',
]);

/** Map one raw `product.category` value to its canonical bucket. */
export const canonicalCategory = (raw: string | null | undefined): CanonicalCategory => {
  const value = normaliseCategory(raw);
  if (!value) return OTHERS;
  if (JUNK.has(value)) return OTHERS;
  for (const rule of RULES) {
    if (rule.pattern.test(value)) return rule.canonical;
  }
  return OTHERS;
};

/** Stable, URL-safe id for a canonical category. */
export const categorySlug = (canonical: string): string =>
  canonical
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Every raw category value that folds into `canonical`. Used when a client
 * filters by a category name, so tapping "Ready to Wear" also returns the
 * products the merchant labelled `RTW` or `RTW Basic`.
 */
export const rawValuesFor = (
  canonical: string,
  knownValues: readonly string[],
): string[] => {
  const target = normaliseCategory(canonical);
  return knownValues.filter((value) => canonicalCategory(value) === target);
};

/** Display order for the canonical set, so the rail is stable. */
export const categoryOrder = (canonical: string): number => {
  const index = CATEGORIES.indexOf(canonical as CanonicalCategory);
  return index === -1 ? CATEGORIES.length : index;
};

export interface CategoryTally {
  name: string;
  slug: string;
  products: number;
  brands: number;
  image?: string;
}

export interface RawCategoryTally {
  /** Raw `product.category` value as stored. */
  name: string;
  products: number;
  /** Brands seen for this raw value, so the union per bucket stays exact. */
  brandNames: readonly string[];
  image?: string;
}

/**
 * Fold per-raw-category tallies into the canonical set. Shared by both catalog
 * backends so /categories is identical whether Mongo or the JSONL index is
 * serving, and so the raw→canonical mapping has exactly one implementation.
 */
export const foldCategories = (raw: readonly RawCategoryTally[]): CategoryTally[] => {
  const folded = new Map<string, { products: number; brands: Set<string>; image?: string }>();

  for (const row of raw) {
    const canonical = canonicalCategory(row.name);
    const entry = folded.get(canonical) ?? { products: 0, brands: new Set<string>(), image: undefined };
    entry.products += row.products;
    for (const brand of row.brandNames) entry.brands.add(brand);
    if (!entry.image && row.image) entry.image = row.image;
    folded.set(canonical, entry);
  }

  return [...folded.entries()]
    .map(([name, entry]) => ({
      name,
      slug: categorySlug(name),
      products: entry.products,
      brands: entry.brands.size,
      image: entry.image,
    }))
    .sort((a, b) => b.products - a.products || categoryOrder(a.name) - categoryOrder(b.name));
};
