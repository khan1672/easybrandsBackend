/**
 * Guards the taxonomy invariants that the /products?category= filter depends
 * on. Run with `npm run check:taxonomy`.
 *
 * Uses tsx (already a devDependency) rather than a test runner, because the
 * backend has no test framework and adding one needs sign-off.
 */
import {
  CATEGORIES,
  canonicalCategory,
  normaliseCategory,
  OTHERS,
  type CanonicalCategory,
} from '../src/db/categoryTaxonomy.js';

let failures = 0;

const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('canonicalCategory(c) === c for every advertised category');
for (const name of CATEGORIES) {
  const got: CanonicalCategory = canonicalCategory(name);
  check(name, got === name, got === name ? '' : `resolved to "${got}"`);
}

console.log('\ncanonical names are not treated as junk');
for (const name of CATEGORIES) {
  check(`${name} is not swallowed by Others`, canonicalCategory(name) !== OTHERS || name === OTHERS);
}

console.log('\nnormaliseCategory is stable under repeated use');
for (const name of CATEGORIES) {
  const once = normaliseCategory(name);
  check(`${name} normalises idempotently`, normaliseCategory(once) === once);
}

console.log('\nevery canonical category is reachable from at least one raw value');
const SAMPLES = [
  'shirt', 't-shirt', 'tee', 'sweatshirt', 'hoodie', 'polo', 'vest', 'Boys Shirts', 'Tops & Tees',
  'kurta', 'kameez', 'shalwar', 'kurti', 'unstitched', 'lawn', 'pret', 'RTW', 'Ready to Wear',
  'stitched', 'western', 'trouser', 'pants', 'chinos', 'lowers', '3pc', '3 piece', 'fabric',
  'meter', 'winter', 'jacket', 'kids', 'boys', 'girls', 'men', 'menswear', 'sherwani',
  'accessories', 'wallet', 'earrings', 'dupatta', 'scarf', 'watch', 'beauty', 'fragrance',
  'perfume', 'home', 'towel', 'bed sheet', 'cushion', 'easify_addon_product', 'payment link',
  'other-acc', 'Uncategorized', 'BASIC SUITS', 'Wedding Wear', 'co-ords',
];
const seen = new Set(CATEGORIES.map(canonicalCategory));
for (const name of CATEGORIES) {
  check(`${name} has a sample raw value`, seen.has(name));
}

console.log(`\n${failures === 0 ? 'all taxonomy invariants hold' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
