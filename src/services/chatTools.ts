import type { Catalog } from '../db/catalog.js';
import type { ProductDoc } from '../types.js';

export interface SearchProductsArgs {
  /** Free text, e.g. "black lawn suit" or "summer". */
  query?: string;
  /** Exact merchant brand name, e.g. "HSY". */
  brand?: string;
  /** Canonical category, e.g. "Ready to Wear". */
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
  sort?: 'relevance' | 'price_asc' | 'price_desc';
}


const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;

/**
 * A product trimmed for the model and the client.
 *
 * The client renders these cards instead of anything the model wrote, so a
 * hallucinated price or brand cannot reach the shopper. Products whose price
 * the merchant did not publish are marked, never coerced to zero.
 */
export interface ChatProduct {
  id: string;
  name: string;
  brand: string;
  price: number | null;
  compareAtPrice?: number;
  currency: string;
  category: string;
  imageUrl?: string;
  productUrl?: string;
  inStock: boolean;
}

/** The product id used everywhere in the API and the app: `brand:handle`. */
const productId = (product: ProductDoc): string => `${product.brand_name}:${product.handle}`;

const firstImage = (product: ProductDoc): string | undefined => {
  const raw = product.primary_image;
  return typeof raw === 'string' && raw ? raw : undefined;
};

export const toChatProduct = (product: ProductDoc): ChatProduct => ({
  id: productId(product),
  name: product.title,
  brand: product.brand_name,
  price: typeof product.price === 'number' ? product.price : null,
  compareAtPrice:
    typeof product.compare_at_price === 'number' ? product.compare_at_price : undefined,
  currency: product.currency || 'PKR',
  category: product.category ?? '',
  imageUrl: firstImage(product),
  productUrl: typeof product.product_url === 'string' ? product.product_url : undefined,
  inStock: product.available !== false,
});

/** Comparable price for range filtering, ignoring unpublished prices. */
const priceForSort = (product: ProductDoc): number | null =>
  typeof product.price === 'number' ? product.price : null;

export const MIN_PLAUSIBLE_PRICE = 50;

/**
 * Runs the model's search request against the in-memory catalog.
 *
 * Applied filters are enforced here rather than trusted from the arguments, so
 * a wrong price or out-of-stock item never reaches the reply.
 */
export async function runSearchProducts(
  catalog: Catalog,
  args: SearchProductsArgs,
): Promise<ChatProduct[]> {
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const availableOnly = true;

  const scope = {
    brand: args.brand,
    category: args.category,
    availableOnly,
  };

  const query = (args.query ?? '').trim();
  const result = query
    ? await catalog.search(query, scope, 1, 200)
    : await catalog.browse(scope, 1, 200);

  let products = result.items;

  products = products.filter((product) => {
    const price = priceForSort(product);
    if (price !== null && price < MIN_PLAUSIBLE_PRICE) return false;
    if (args.minPrice !== undefined) {
      if (price === null || price < args.minPrice) return false;
    }
    if (args.maxPrice !== undefined) {
      if (price === null || price > args.maxPrice) return false;
    }
    return true;
  });

  if (args.sort === 'price_asc') {
    products = [...products].sort((a, b) => (priceForSort(a) ?? Infinity) - (priceForSort(b) ?? Infinity));
  } else if (args.sort === 'price_desc') {
    products = [...products].sort((a, b) => (priceForSort(b) ?? Infinity) - (priceForSort(a) ?? Infinity));
  }

  return products.slice(0, limit).map(toChatProduct);
}

export const describeProducts = (products: ChatProduct[]): string => {
  if (products.length === 0) return 'No products matched those filters.';

  return products
    .map(product => {
      const price =
        product.price === null
          ? 'price not published'
          : `${product.currency} ${product.price}`;
      const stock = product.inStock ? '' : ' | out of stock';
      return `[${product.id}] ${product.brand} — ${product.name} | ${price} | ${product.category}${stock}`;
    })
    .join('\n');
};

export default { runSearchProducts, toChatProduct, describeProducts };
