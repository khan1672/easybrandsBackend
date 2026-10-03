import { canonicalCategory, CATEGORIES, type CanonicalCategory } from '../db/categoryTaxonomy.js';
import type { SearchProductsArgs } from './chatTools.js';

/**
 * What a shopper's message is asking the catalogue for, worked out locally.
 *
 * The point of this module is that almost nothing here needs a language model.
 * "lawn suit under 5000" is not a creative writing task: it is two filters and a
 * bag of keywords, and a regex gets there faster, for free, and identically every
 * time. Gemini is only asked to talk about results we already fetched.
 */
export interface ProductIntent {
  /** Filters for the catalogue search. */
  args: SearchProductsArgs;
  /** Keywords worth searching on, after the filters were lifted out. */
  query: string;
  /** True when the message asks about products at all. */
  isProductQuery: boolean;
  /** Phrases lifted out of the message and replaced with nothing. */
  priceHint: string | null;
  categoryHint: CanonicalCategory | null;
  brandHint: string | null;
  sortHint: SearchProductsArgs['sort'] | undefined;
}

const BRAND_HINTS: readonly { pattern: RegExp; brand: string }[] = [
  { pattern: /\balkaram\b/i, brand: 'Alkaram (Alkaram Studio)' },
  { pattern: /\bbeech\s?tree\b/i, brand: 'Beechtree' },
  { pattern: /\bbonanza\b|\bsatrangi\b/i, brand: 'Bonanza Satrangi' },
  { pattern: /\bcharizma\b/i, brand: 'Charizma' },
  { pattern: /\bcross\s?stitch\b/i, brand: 'Cross Stitch' },
  { pattern: /\bedenrobe\b/i, brand: 'Edenrobe' },
  { pattern: /\bgul\s?ahmed\b/i, brand: 'Gul Ahmed' },
  { pattern: /\bhsy\b/i, brand: 'HSY' },
  { pattern: /\bjunaid\s?jamshed\b|\bjj\b/i, brand: 'J. (Junaid Jamshed)' },
  { pattern: /\blimelight\b/i, brand: 'Limelight' },
  { pattern: /\bmaria\s?b\b/i, brand: 'Maria B' },
  { pattern: /\bnishat\b/i, brand: 'Nishat Linen' },
  { pattern: /\bsana\s?safinaz\b/i, brand: 'Sana Safinaz' },
  { pattern: /\bzellbury\b/i, brand: 'Zellbury' },
];

/**
 * Category words, mapped to the canonical bucket the catalogue actually uses.
 *
 * Reusing the catalogue's own folding rules means "lawn" and "3 piece" land in
 * the same buckets the browse and filter endpoints use, so a chat hit and a
 * browse hit for the same word agree.
 */
const CATEGORY_HINTS: readonly { pattern: RegExp; category: CanonicalCategory }[] = [
  { pattern: /\blastitched\b|\bun-?stitched\b|\b3\s?piece\b|\b3pc\b|\bdupatta\b/i, category: 'Unstitched' },
  { pattern: /\bpret\b/i, category: 'Pret' },
  { pattern: /\bkurta\b|\bkurti\b|\bshalwar\b|\bkameez\b|\bkameez\b/i, category: 'Kurta & Shalwar' },
  { pattern: /\bt-?shirt\b|\btee\b|\btops?\b|\bpolo\b|\bjacket\b|\bsweat/i, category: 'Shirts & Tops' },
  { pattern: /\btrouser|\bpants?\b|\bshirting\b|\bjeans?\b/i, category: 'Trousers & Pants' },
  { pattern: /\bready to wear\b|\brtw\b|\bformal|\bsuit\b|\bdress\b|\bco-?ord\b/i, category: 'Ready to Wear' },
  { pattern: /\bfabric\b|\bcloth\b/i, category: 'Fabric' },
  { pattern: /\bkids?\b|\bchildren\b|\bbaby\b|\bgirl\b|\bboy\b/i, category: 'Kids' },
  { pattern: /\bmens?\b|\bmen's\b|\bgents?\b/i, category: 'Menswear' },
  { pattern: /\baccessor|\b dupatta\b|\bstoles?\b|\bcaps?\b/i, category: 'Accessories' },
  { pattern: /\bbeauty\b|\bfragrance\b|\bperfume\b/i, category: 'Beauty & Fragrance' },
  { pattern: /\bhome\b|\bbedding\b|\btowels?\b/i, category: 'Home' },
];

const SORT_HINTS: readonly { pattern: RegExp; sort: SearchProductsArgs['sort'] }[] = [
  { pattern: /\bcheapest\b|\bbudget\b|\bshortest\b|\blowest\b|\bsort:? ?asc/i, sort: 'price_asc' },
  { pattern: /\bmost expensive\b|\bpremium\b|\bluxur/i, sort: 'price_desc' },
];

/**
 * Price phrases, captured rather than removed.
 *
 * `5k`, `5000`, `1,500`, `2.5k` and `5000-8000` are all how Pakistani shoppers
 * actually write a budget, and all of them need to turn into real numbers.
 */
/** Words that belong to a price phrase and must not stay in the search text. */
const KEYWORD_BEFORE_RE =
  /(?:\b(?:under|below|less than|lesser than|upto|up to|within|max|maximum|budget|cheaper than|not more than|over|above|more than|greater than|min|minimum|at least|starting at|around|about|approximately|roughly|near|between|pkrs?|rs\.?|ruppees?|rupees?)\s*:?\s*)$/i;

/**
 * Words that sit next to a number but are never a price.
 *
 * "3 piece" is a product name, and "size 10" is a size. Reading those as PKR
 * 3 or PKR 10 would silently destroy the search, so the price scanner skips any
 * number followed by one of these.
 */
const NON_PRICE_WORD =
  'piece|pieces|pc|pcs|size|sizes|no|number|num|pack|packs|packet|packets|dozen|set|sets|colou?r|colou?rs|day|days|month|months|year|years|week|weeks|hour|hours';

const NON_PRICE_WORD_RE = new RegExp(`^(?:${NON_PRICE_WORD})$`, 'i');

/** The word immediately after the digits, if any. */
const afterWord = (text: string, at: number): string =>
  /^\s*([A-Za-z]+)/.exec(text.slice(at))?.[1] ?? '';

/** The word immediately before the digits, if any. */
const beforeWord = (text: string, at: number): string =>
  /([A-Za-z]+)\s*$/.exec(text.slice(0, at))?.[1] ?? '';

const PRICE_BOUND_RE =
  /\b(?:pkr|rs\.?|ruppees?|rupees?)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|thousand|thousands|lakh|lacs|lac)?\b/gi;

const UNDER_RE = /\b(?:under|below|less than|lesser than|upto|up to|within|max|maximum|budget(?: is)?|cheaper than|not more than|<)\s*:?/i;
const OVER_RE = /\b(?:over|above|more than|greater than|from|min|minimum|at least|starting at|>)\s*:?/i;
const BETWEEN_RE = /\b(?:between|and)\b/i;

const PRICE_UNITS: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  thousands: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
};

const toNumber = (raw: string, unit: string | undefined): number => {
  const value = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(value)) return NaN;
  return value * (unit ? (PRICE_UNITS[unit.toLowerCase()] ?? 1) : 1);
};

/** Every number in the message, with its unit, in the order written. */
interface Money {
  value: number;
  /** Start of the whole phrase, including any "under" or "pkrs" around it. */
  start: number;
  /** Start of the digits, so the direction word before them is still readable. */
  numberStart: number;
  /** End of the number itself. */
  end: number;
}

export const findAllMoney = (text: string): Money[] => {
  const found: Money[] = [];
  for (const match of text.matchAll(PRICE_BOUND_RE)) {
    const raw = match[1];
    const unit = match[2];
    if (!raw) continue;
    const value = toNumber(raw, unit);
    if (!Number.isFinite(value) || value <= 0) continue;
    const numberStart = match.index ?? 0;
    const numberEnd = numberStart + match[0].length;
    // A "k" unit is a deliberate price signal. Without one, a number sitting
    // next to a counting word is something else: "3 piece" and "size 10" must
    // not become a budget of PKR 3 or PKR 10.
    if (!unit) {
      const next = afterWord(text, numberEnd).toLowerCase();
      const previous = beforeWord(text, numberStart).toLowerCase();
      if (next.match(NON_PRICE_WORD_RE) || previous.match(NON_PRICE_WORD_RE)) continue;
    }
    // "under 5000" and "pkrs 5k" are one filter; leaving "under" behind would
    // put a non-product word into the search text.
    const before = text.slice(Math.max(0, numberStart - 24), numberStart);
    const keyword = before.match(KEYWORD_BEFORE_RE);
    found.push({
      value,
      start: keyword ? numberStart - keyword[0].length : numberStart,
      numberStart,
      end: numberEnd,
    });
  }
  return found;
};

/** The spans of the message that were consumed as filters, so they cannot leak
 *  into the free-text query and skew the search. */
interface Consumed extends Array<{ start: number; end: number }> {
  covered: (start: number, end: number) => boolean;
}

const consumedSpans = (spans: ReadonlyArray<{ start: number; end: number }>): Consumed => {
  const list = spans as Consumed;
  list.covered = (start, end) => spans.some(s => start < s.end && end > s.start);
  return list;
};

/**
 * Pulls price bounds out of the message.
 *
 * Returns the bounds plus the spans consumed, because "under 5000" must not
 * remain in the search text: searching for the literal word "under" would drag
 * in unrelated products and dilute the ranking.
 */
function parsePrice(text: string): {
  min?: number;
  max?: number;
  hint: string | null;
  spans: Consumed;
} {
  const spans = consumedSpans([]);
  const all = findAllMoney(text);
  if (all.length === 0) return { hint: null, spans };

  // A range such as "5000-8000" or "between 3000 and 8000".
  const betweenAt = text.search(BETWEEN_RE);
  const joined = UNDER_RE.test(text) || OVER_RE.test(text);

  // Counts ("2 people", "3 sizes") must not pair up into a fake price range.
  const prices = all.filter(m => m.value >= 100);
  const low = prices[0];
  const high = prices[1];
  if (low && high) {
    const between = text.slice(low.end, high.start);
    const hyphenated = /-|\bto\b|\band\b/i.test(between);
    // Anything else between the two numbers means they are not a range: "3
    // piece suit for 2 people under 8000" has three numbers, not a budget.
    const onlyConnectors = /^[\s]*(-|to|and|between|[\d,.]*)?[\s]*$/i.test(between);
    if ((hyphenated && onlyConnectors) || (betweenAt >= 0 && onlyConnectors)) {
      spans.push({ start: low.start, end: high.end });
      return {
        min: Math.min(low.value, high.value),
        max: Math.max(low.value, high.value),
        hint: `between PKR ${low.value.toLocaleString('en-PK')} and PKR ${high.value.toLocaleString('en-PK')}`,
        spans,
      };
    }
  }

  const only = all.find(m => m.value >= 100) ?? all[0];
  if (only && joined) {
    // Read the direction from the words right before the digits, not before the
    // span: the span already swallowed them.
    const window = text.slice(Math.max(0, only.numberStart - 40), only.numberStart);
    // "under 5000" bounds above; "over 5000" bounds below.
    if (OVER_RE.test(window) && !UNDER_RE.test(window)) {
      spans.push({ start: only.start, end: only.end });
      return { min: only.value, hint: `over PKR ${only.value.toLocaleString('en-PK')}`, spans };
    }
    spans.push({ start: only.start, end: only.end });
    return { max: only.value, hint: `under PKR ${only.value.toLocaleString('en-PK')}`, spans };
  }

  // A bare number with no direction is treated as a ceiling: shoppers asking
  // "lawn 5000" mean "up to 5000", not "from 5000".
  if (only) {
    spans.push({ start: only.start, end: only.end });
    return { max: only.value, hint: `under PKR ${only.value.toLocaleString('en-PK')}`, spans };
  }
  return { hint: null, spans };
}

/**
 * Words that carry no product meaning.
 *
 * Dropping these leaves a search string made only of things a shopper would
 * recognise as describing a garment. Everything here is a question word, a
 * politeness, or a fragment of the sentence rather than a product.
 */
const STOPWORDS = new Set([
  'a', 'about', 'all', 'also', 'am', 'an', 'and', 'any', 'anything', 'anymore', 'are', 'as',
  'at', 'be', 'been', 'best', 'better', 'buy', 'can', 'could', 'do', 'does', 'for', 'from',
  'get', 'give', 'good', 'great', 'has', 'have', 'help', 'her', 'him', 'his', 'how', 'i',
  'im', 'in', 'is', 'it', 'its', 'just', 'kindly', 'like', 'looking', 'me', 'might', 'mine',
  'more', 'most', 'much', 'my', 'need', 'nice', 'of', 'on', 'one', 'or', 'our', 'out',
  'please', 'pls', 'prefer', 'recommend', 'show', 'should', 'show', 'some', 'something',
  'suggest', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'to', 'u', 'us', 'want', 'was', 'we', 'were', 'what', 'whats', 'which',
  'who', 'will', 'with', 'would', 'you', 'your', 'yours',
]);

const SMALL_TALK_RE =
  /^\s*(hi|hey|hello|salaam|assalam|salam|thanks|thank you|thx|ok|okay|cool|great|bye|goodbye|good morning|good evening)\b[\s!.?]*$/i;

/** Messages that are pure greeting or thanks: nothing to search for. */
export const isSmallTalk = (text: string): boolean => SMALL_TALK_RE.test(text.trim());

/**
 * Reads a shopper message as a catalogue query, without calling any API.
 *
 * Filters are pulled out first, then the leftover words become the search text,
 * so a query like "show me Sana Safinaz pret under 5000" searches for
 * "pret" with `brand=Sana Safinaz, maxPrice=5000` instead of searching for the
 * whole sentence.
 */
export function parseIntent(message: string): ProductIntent {
  const text = message.trim();
  const lower = text.toLowerCase();

  if (text === '' || isSmallTalk(text)) {
    return {
      args: {},
      query: '',
      isProductQuery: false,
      priceHint: null,
      categoryHint: null,
      brandHint: null,
      sortHint: undefined,
    };
  }

  const consumed: Consumed = consumedSpans([]);
  const { min, max, hint: priceHint, spans: priceSpans } = parsePrice(text);
  consumed.push(...priceSpans);

  let brandHint: string | null = null;
  for (const { pattern, brand } of BRAND_HINTS) {
    const match = pattern.exec(text);
    if (match) {
      brandHint = brand;
      consumed.push({ start: match.index, end: match.index + match[0].length });
      break;
    }
  }

  // Only the first category word is used, and it is deliberately NOT consumed:
  // "jacket" and "frock" are the words that actually find the product. The
  // category is kept as a fallback for when no searchable text is left.
  let categoryHint: CanonicalCategory | null = null;
  for (const { pattern, category } of CATEGORY_HINTS) {
    if (pattern.test(text)) {
      categoryHint = category;
      break;
    }
  }

  let sortHint: SearchProductsArgs['sort'];
  for (const { pattern, sort } of SORT_HINTS) {
    const match = pattern.exec(text);
    if (match) {
      sortHint = sort;
      consumed.push({ start: match.index, end: match.index + match[0].length });
      break;
    }
  }

  // Occasion and season words are not product vocabulary: searching for
  // "wedding" or "summer" matches almost nothing, so they are removed here and
  // handed to Gemini separately as wording context.
  for (const match of text.matchAll(OCCASION_RE)) {
    const index = match.index ?? 0;
    consumed.push({ start: index, end: index + match[0].length });
  }

  // Whatever survives the filters is the search text, with the stopwords
  // removed word by word rather than by span, so a leftover "a" or "for" cannot
  // survive just because it sits next to a consumed span.
  const kept: string[] = [];
  let cursor = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && !consumed.covered(i, i + 1)) continue;
    if (i > cursor) kept.push(text.slice(cursor, i));
    cursor = i + 1;
  }

  const query = kept
    .join(' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length > 0)
    .filter(word => !STOPWORDS.has(word.toLowerCase()))
    .join(' ')
    .trim();

  // A category word that only exists in the filter should not be searched for
  // again, but a word like "lawn" is genuine product vocabulary, so it stays.
  const args: SearchProductsArgs = {
    ...(query ? { query } : {}),
    ...(min !== undefined ? { minPrice: min } : {}),
    ...(max !== undefined ? { maxPrice: max } : {}),
    ...(brandHint ? { brand: brandHint } : {}),
    // The category is only used to filter when there is no search text to go on.
    // "lawn suit" folds to Ready to Wear, but lawn suits are also sold unstitched;
    // filtering on it would throw away the very products the shopper meant.
    ...(categoryHint && !query ? { category: categoryHint } : {}),
    ...(sortHint ? { sort: sortHint } : {}),
  };

  return {
    args,
    query,
    isProductQuery: true,
    priceHint,
    categoryHint,
    brandHint,
    sortHint,
  };
}

/**
 * Words that describe the occasion or the season rather than the garment.
 *
 * These matter to the shopper and nothing to the index, so they are dropped from
 * the search text and handed to Gemini separately as context for the wording.
 */
export const OCCASION_RE =
  /\b(wedding|weddings|mehl|mehndi|dholki|baraat|valima|reception|engagement|nikah|sangeet|eid|ramzan|ramadan|summer|spring|autumn|fall|monsoon|office|work|professional|everyday|daily|college|university|party|gift|gifting|bride|groom|newlywed|newly\s?wed|travel|vacation)\b/gi;

/** Colour words, kept because they are genuine product vocabulary. */
const COLOUR_RE = /\b(black|white|red|blue|green|pink|yellow|orange|purple|grey|gray|beige|brown|navy|maroon|cream|ivory|gold|silver|rose|mustard|olive|teal|burgundy|fuchsia|peach|lilac|mauve|charcoal|off[- ]?white|multi|multicolou?r|floral|printed|striped|plain|solid|check(ed)?|embroidered)\b/gi;

/** Categories a shopper might plausibly ask for by a word we do not fold. */
export const ALL_CATEGORIES = CATEGORIES;

/** Exposed so the search step can confirm a guessed category really exists. */
export const resolveCategory = (raw: string | null | undefined): CanonicalCategory =>
  canonicalCategory(raw);