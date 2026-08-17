import { normalizeUnit, unitFamily } from './units.js'

/**
 * Alias key normalization. Deliberately KEEPS embedded pack sizes ("2LB",
 * "796ML") — they're part of the product's identity; stripping them would
 * merge distinct products.
 */
export function normalizeReceiptText(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\s+/g, ' ')
    // trailing price + tax flag: "... 4.99 MRJ"
    .replace(/\s+\$?\d+[.,]\d{2}\s*[A-Z]{0,3}$/, '')
    .replace(/^\d{6,}\s+/, '') // leading SKU/PLU code
    .replace(/[*#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeItemName(raw: string): string {
  return (
    raw
      .toLowerCase()
      // Accents are folded, not deleted: "pâte" must become "pate", not
      // "p te". Canadian packaging is bilingual and half of what a barcode
      // lookup returns is French.
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      // Variant detail belongs in the alias, not the canonical item:
      // "milk (2%)" and "olive oil (extra virgin)" are milk and olive oil.
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * Words that describe how a thing was cut, graded, branded or sold — never
 * what it IS. Dropped before matching so "2 packages gnocchi" and "vita sana
 * potato gnocchi" can meet in the middle.
 *
 * Deliberately does NOT include form words (canned, dried, fresh, frozen,
 * ground, smoked): those change the ingredient, and the schema's rule is that
 * canned tomatoes are not fresh tomatoes. Better to leave those unmatched and
 * let the model decide than to invent a match.
 */
const DESCRIPTOR_WORDS = new Set([
  // preparation
  'chopped', 'diced', 'sliced', 'minced', 'grated', 'shredded', 'crushed',
  'peeled', 'trimmed', 'halved', 'quartered', 'cubed', 'crumbled', 'melted',
  'softened', 'beaten', 'divided', 'packed', 'rinsed', 'drained', 'scrubbed',
  'cut', 'torn', 'julienned', 'zested', 'juiced',
  // manner
  'freshly', 'finely', 'coarsely', 'thinly', 'roughly', 'lightly', 'well',
  // grade / marketing / variant detail
  'extra', 'virgin', 'pure', 'organic', 'natural', 'premium', 'plain',
  'unsalted', 'salted', 'reduced', 'skim', 'lowfat', 'nonfat', 'light',
  'baby', 'jumbo', 'large', 'medium', 'small', 'mini', 'giant', 'family',
  'size', 'sized', 'value', 'brand', 'style',
  // leftovers of quantity phrasing
  'about', 'approximately', 'plus', 'more', 'taste', 'optional', 'each',
])

/**
 * The comparable core of an item or ingredient name: lowercased, singular,
 * with descriptors removed. Falls back to the plain words rather than
 * returning nothing when a name is all descriptor.
 */
export function foodTokens(raw: string): string[] {
  const words = normalizeItemName(raw)
    .split(' ')
    .map((w) => singularize(w))
    .filter((w) => w.length > 1)
  const kept = words.filter((w) => !DESCRIPTOR_WORDS.has(w))
  return kept.length > 0 ? kept : words
}

/** Crude singularization, good enough for ingredient matching. */
export function singularize(name: string): string {
  return name
    .split(' ')
    .map((w) =>
      w.endsWith('ies') && w.length > 4
        ? `${w.slice(0, -3)}y`
        : w.endsWith('oes') && w.length > 4
          ? w.slice(0, -2)
          : // "ss" and "us" are never plural endings — molasses, asparagus,
            // couscous, hummus, citrus.
            w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length > 3
            ? w.slice(0, -1)
            : w,
    )
    .join(' ')
}

// Segmenting a receipt lives in receipt-structure.ts now: reading it line by
// line lost the department headers and the weight lines, which is where the
// category and the quantity actually are.

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 0.5,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 0.25,
  '¾': 0.75,
  '⅕': 0.2,
  '⅙': 1 / 6,
  '⅛': 0.125,
  '⅜': 0.375,
  '⅝': 0.625,
  '⅞': 0.875,
}

function parseNumber(token: string): number | null {
  let t = token.trim()
  for (const [glyph, value] of Object.entries(UNICODE_FRACTIONS)) {
    if (t.includes(glyph)) {
      const rest = t.replace(glyph, '').trim()
      const whole = rest ? Number(rest) : 0
      if (Number.isFinite(whole)) return whole + value
      return value
    }
  }
  // "2 1/2"
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
  const frac = t.match(/^(\d+)\/(\d+)$/)
  if (frac) return Number(frac[1]) / Number(frac[2])
  // range "2-3" → take the low end, we don't pretend to know
  const range = t.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*\d+(?:\.\d+)?$/)
  if (range) return Number(range[1])
  const n = Number(t.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export type ParsedIngredient = {
  quantity: number | null
  unit: string | null
  unitFamily: string | null
  name: string
  optional: boolean
}

const OPTIONAL_HINT = /\b(optional|to taste|for serving|garnish|if desired)\b/i

/**
 * Deterministic ingredient-line parse: "2 cups diced tomatoes" →
 * {2, cup, "diced tomatoes"}. Falls back to name-only, which is fine —
 * presence matching doesn't need a quantity.
 */
export function parseIngredientLine(raw: string): ParsedIngredient {
  const optional = OPTIONAL_HINT.test(raw)
  let text = raw
    .replace(/\([^)]*\)/g, ' ') // drop parenthetical asides
    .replace(/\s+/g, ' ')
    .trim()

  let quantity: number | null = null
  let unit: string | null = null

  const qtyMatch = text.match(
    /^((?:\d+\s+\d+\/\d+)|(?:\d+\/\d+)|(?:\d+(?:[.,]\d+)?\s*[-–]\s*\d+(?:[.,]\d+)?)|(?:\d+(?:[.,]\d+)?)|[½⅓⅔¼¾⅕⅙⅛⅜⅝⅞])\s*/,
  )
  if (qtyMatch) {
    quantity = parseNumber(qtyMatch[1]!)
    text = text.slice(qtyMatch[0].length)
  } else {
    const glyph = text.match(/^([½⅓⅔¼¾⅕⅙⅛⅜⅝⅞])\s*/)
    if (glyph) {
      quantity = UNICODE_FRACTIONS[glyph[1]!] ?? null
      text = text.slice(glyph[0].length)
    }
  }

  const unitMatch = text.match(/^([a-zA-Z.]+)\s+/)
  if (unitMatch) {
    const candidate = normalizeUnit(unitMatch[1]!)
    if (candidate) {
      unit = candidate
      text = text.slice(unitMatch[0].length)
    }
  }

  const name = text
    .replace(/^(of\s+)/i, '')
    .replace(/,.*$/, '') // "tomatoes, diced" → "tomatoes"
    .replace(OPTIONAL_HINT, '')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    quantity,
    unit,
    unitFamily: unitFamily(unit),
    name: name || raw.trim(),
    optional,
  }
}

/** Strip an amount embedded in a receipt line, e.g. "CHKN BRST 2LB". */
export function quantityFromReceiptLine(raw: string): {
  quantity: number | null
  unit: string | null
} {
  const m = raw.match(
    /(\d+(?:[.,]\d+)?)\s*(kg|g|lb|lbs|oz|ml|l|litre|liter)\b/i,
  )
  if (!m) return { quantity: null, unit: null }
  return {
    quantity: Number(m[1]!.replace(',', '.')),
    unit: normalizeUnit(m[2]!),
  }
}
