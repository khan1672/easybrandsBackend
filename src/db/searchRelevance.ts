import type { ProductDoc } from '../types.js';

const TOKEN_RE = /[A-Za-z0-9]+/g;

export function tokenize(text: string | null | undefined): string[] {
  return String(text || '').toLowerCase().match(TOKEN_RE) || [];
}

/**
 * Splits a raw query into terms. Every term must match somewhere, but not
 * necessarily in the same field, so "sana pret" finds Sana Safinaz pret
 * shirts.
 */
export function searchTerms(q: string): string[] {
  return tokenize(q);
}

/** Normalized form the phrase-level tiers compare against, e.g. "lawn suit". */
export function searchPhrase(terms: string[]): string {
  return terms.join(' ');
}

/**
 * Ranking tiers, highest first. Phrase hits beat token hits so an exact
 * "embroidered lawn" outranks a product that merely has both words somewhere
 * in its description, and a brand hit outranks a description hit because
 * shoppers search brand names deliberately.
 *
 * The Mongo pipeline in `mongoCatalog.ts` builds its `$addFields` stage from
 * these same weights, so the JSONL and Mongo catalogs rank identically.
 */
export const RELEVANCE_WEIGHTS = {
  brandExact: 1000,
  titlePrefix: 800,
  titlePhrase: 600,
  brandPhrase: 400,
  tagExact: 300,
  tagPhrase: 200,
  descriptionPhrase: 120,
  termInTitle: 40,
  termInBrand: 25,
  termInTag: 15,
  termInCategory: 5,
} as const;

/** Escapes a phrase for safe use as a Mongo `$regexMatch` pattern. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagList(doc: ProductDoc): string[] {
  return Array.isArray(doc.tags) ? doc.tags : [];
}

/**
 * Relevance score for one candidate document. Higher is better; 0 means the
 * document does not match at all.
 *
 * Callers must still apply the every-term-must-match filter: this only ranks
 * the survivors, it does not decide membership.
 */
export function scoreProduct(doc: ProductDoc, phrase: string, terms: string[]): number {
  const W = RELEVANCE_WEIGHTS;
  const title = String(doc.title || '').toLowerCase();
  const brand = String(doc.brand_name || '').toLowerCase();
  const category = String(doc.category || '').toLowerCase();
  const description = String(doc.description || '').toLowerCase();
  const tags = tagList(doc).map(t => String(t).toLowerCase());

  let score = 0;
  if (brand && brand === phrase) score += W.brandExact;
  if (title.startsWith(phrase)) score += W.titlePrefix;
  if (title.includes(phrase)) score += W.titlePhrase;
  if (brand.includes(phrase)) score += W.brandPhrase;
  if (tags.some(t => t === phrase)) score += W.tagExact;
  else if (tags.some(t => t.includes(phrase))) score += W.tagPhrase;
  if (description.includes(phrase)) score += W.descriptionPhrase;

  const titleTokens = new Set(tokenize(title));
  const brandTokens = new Set(tokenize(brand));
  const categoryTokens = new Set(tokenize(category));
  const tagTokens = new Set(tags.flatMap(tokenize));
  for (const term of terms) {
    if (titleTokens.has(term)) score += W.termInTitle;
    if (brandTokens.has(term)) score += W.termInBrand;
    if (tagTokens.has(term)) score += W.termInTag;
    if (categoryTokens.has(term)) score += W.termInCategory;
  }
  return score;
}
