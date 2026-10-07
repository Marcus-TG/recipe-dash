import { formatBase, metricSymbol, normalizeUnit, toBase, unitFamily } from './units.js'

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

export const OPTIONAL_HINT = /\b(optional|to taste|for serving|garnish|if desired)\b/i

/**
 * Recipe sites that build one meal out of sub-recipes ("For the pico de
 * gallo:", "Sauce") put the headings inside the ingredient list itself. A
 * heading is a line with no amount that either ends in a colon or announces
 * what follows with "for the ...". Treating one as an ingredient would give it
 * a pantry verdict, a shopping-list line and a cook-confirm row it doesn't
 * deserve.
 */
export function ingredientHeading(raw: string): string | null {
  const line = raw.replace(/\s+/g, ' ').trim()
  if (!line) return null
  const endsWithColon = /:$/.test(line)
  const forThe = /^for (the |a |an )?[^,]+:?$/i.test(line)
  if (!endsWithColon && !forThe) return null
  // A leading amount means it's an ingredient after all ("1 cup rice:" is a
  // typo, not a heading).
  if (/^[\d½⅓⅔¼¾⅕⅙⅛⅜⅝⅞]/.test(line)) return null
  let label = line
    .replace(/:$/, '')
    .replace(/^for (the |a |an )?/i, '')
    .replace(/^to (make |assemble |serve |finish )?(the )?/i, '')
    .trim()
  if (!label) return null
  if (
    /^(rest|remainder|everything else|assembl[ey]|assembling|serving|serve|finish|the bowls?)$/i.test(
      label,
    )
  ) {
    return 'Everything else'
  }
  // Shouty sites ("FOR THE DRESSING") get the same voice as everyone else.
  if (label === label.toUpperCase()) label = label.toLowerCase()
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export type SectionedLine = { rawText: string; section: string | null }

/**
 * Walk an ingredient list, folding headings into a `section` on the lines
 * that follow them. Lines before the first heading keep no section.
 */
export function splitIngredientSections(lines: string[]): SectionedLine[] {
  const out: SectionedLine[] = []
  let section: string | null = null
  for (const raw of lines) {
    const heading = ingredientHeading(raw)
    if (heading) {
      section = heading
      continue
    }
    if (raw.trim()) out.push({ rawText: raw, section })
  }
  return out
}

/**
 * "Serves 4!" and "Enjoy!" show up as the last instruction on chatty blogs.
 * They're not a step, so they don't belong on a cook-mode screen of their own.
 */
export function dropTrailingNonSteps(steps: string[]): string[] {
  const out = [...steps]
  while (out.length > 1) {
    const last = out[out.length - 1]!.trim()
    const isYield = /^(serves|makes|yields?|yield)\b[^.]{0,30}[.!]*$/i.test(last)
    const isSignoff = /^(enjoy|bon app[ée]tit)[!. ]*$/i.test(last)
    if (!isYield && !isSignoff) break
    out.pop()
  }
  return out
}

// One amount as recipes write it: 2, 1.5, ½, 1½, 1/3, 1 1/2, 2-3, and "1+"
// for "at least". Mixed forms go first, or "1 1/2" would stop at the 1.
const AMOUNT = new RegExp(
  '^(' +
    [
      '\\d+\\s*[½⅓⅔¼¾⅕⅙⅛⅜⅝⅞]',
      '\\d+\\s+\\d+\\/\\d+',
      '\\d+\\/\\d+',
      '\\d+(?:[.,]\\d+)?(?:\\s*[-–]\\s*\\d+(?:[.,]\\d+)?)?',
      '[½⅓⅔¼¾⅕⅙⅛⅜⅝⅞]',
    ].join('|') +
    ')(\\+?)\\s*',
)

// The unit after an amount. It can touch the number ("40g") or the measure
// that follows it ("1 cup/125 grams").
const UNIT_WORD = /^(fl\.?\s?oz\.?|[a-zA-Z]+\.?)(\+?)(?=[\s/(),]|$)\s*/

type Measure = {
  number: string | null // as written, e.g. "1 1/2"
  numberPlus: string // "1+ cups" — at least this much
  quantity: number | null
  unit: string | null // normalized
  unitText: string // as written, e.g. "Tbs."
  unitPlus: string // "100 g+"
  rest: string
}

/** Read "1/3 cup" off the front of a line. Null if there's no amount or unit. */
function readMeasure(text: string): Measure | null {
  const n = text.match(AMOUNT)
  let rest = n ? text.slice(n[0].length) : text
  const u = rest.match(UNIT_WORD)
  const unit = u ? normalizeUnit(u[1]) : null
  if (!n && !unit) return null
  if (u && unit) rest = rest.slice(u[0].length)
  return {
    number: n ? n[1]! : null,
    numberPlus: n?.[2] ?? '',
    quantity: n ? parseNumber(n[1]!) : null,
    unit,
    unitText: u && unit ? u[1]! : '',
    unitPlus: u && unit ? u[2]! : '',
    rest,
  }
}

/** Parentheses inside parentheses too: "(peeled, cut into cubes (Note 1))". */
function dropAsides(text: string): string {
  let prev: string
  do {
    prev = text
    text = text.replace(/\([^()]*\)/g, ' ')
  } while (text !== prev)
  return text
}

/**
 * Deterministic ingredient-line parse: "2 cups diced tomatoes" →
 * {2, cup, "diced tomatoes"}. Falls back to name-only, which is fine —
 * presence matching doesn't need a quantity.
 */
export function parseIngredientLine(raw: string): ParsedIngredient {
  const optional = OPTIONAL_HINT.test(raw)
  let text = dropAsides(raw).replace(/\s+/g, ' ').trim()

  let quantity: number | null = null
  let unit: string | null = null

  const measure = readMeasure(text)
  if (measure) {
    quantity = measure.quantity
    unit = measure.unit
    text = measure.rest
    // "40g / 3 tbsp butter": the second measure is the same butter again,
    // not the start of its name.
    if (text.startsWith('/')) {
      const second = readMeasure(text.slice(1).trimStart())
      if (second?.number && second.unit) text = second.rest
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

/**
 * An ingredient line taken apart for reading in the kitchen:
 *
 *   amount    how the recipe measures it — "⅓ cup", "2", "1½ pounds"
 *   metric    what the scale or jug reads — "50 g", "680 g", "≈ 125 g" — or null
 *   estimate  where an "≈" figure came from; null when it isn't one
 *   text      the ingredient — "boneless, skinless chicken thighs"
 *   note      the aside, shown quieter — "finely chopped"
 *
 * The metric figure is, in order of trust:
 *   1. the recipe's own — "1/3 cup (50g) flour", "40g / 3 tbsp butter" —
 *      moved to the same place on every line;
 *   2. exact arithmetic inside one family — pounds and ounces to grams;
 *   3. an estimate, from a density the caller looked up in measured data
 *      (see weights.ts). Always marked "≈", always says where it came from.
 * A cup never becomes millilitres here: "1 cup · 237 ml" beside flour is a
 * number someone with a scale will weigh out.
 *
 * Derived on every read, never stored, so a better parser improves every
 * recipe without re-importing anything.
 */
export type IngredientDisplay = {
  amount: string | null
  metric: string | null
  estimate: string | null
  text: string
  note: string | null
}

/** Grams per millilitre for one ingredient, and the words for where it came from. */
export type Density = { gPerMl: number; source: string }

// "1 small onion": the size describes the onion; it isn't a measure.
const SIZE_WORDS = new Set(['large', 'medium', 'small', 'whole'])

/**
 * Whether two measures are the same amount said twice in a way worth having:
 * one is metric, or one is a volume and the other a weight. "1 cup (2 sticks)"
 * isn't — there's no scale reading in it.
 */
function pairable(a: Measure, b: Measure): boolean {
  if (metricSymbol(a.unit) || metricSymbol(b.unit)) return true
  const families = [unitFamily(a.unit), unitFamily(b.unit)]
  return families.includes('volume') && families.includes('mass')
}

/**
 * The leading measure, plus the recipe's second measure of the same thing:
 * straight after it ("40g / 3 tbsp", "1/3 cup (50 g)") or in brackets further
 * along ("1 1/2 cups flour (6.75 ounces)").
 */
function readAmounts(line: string): { m: Measure; alt: Measure | null; rest: string } | null {
  const m = readMeasure(line)
  if (!m?.number) return null
  if (m.unit && SIZE_WORDS.has(m.unit)) {
    m.rest = `${m.unitText} ${m.rest}`
    m.unit = null
    m.unitText = ''
    m.unitPlus = ''
  }
  const rest = m.rest
  if (!m.unit) return { m, alt: null, rest }
  if (rest.startsWith('/')) {
    const second = readMeasure(rest.slice(1).trimStart())
    if (second?.number && second.unit && pairable(m, second)) {
      return { m, alt: second, rest: second.rest }
    }
  }
  for (const paren of rest.matchAll(/\(([^()]*)\)/g)) {
    const second = readMeasure(paren[1]!.trim())
    if (second?.number && second.unit && !second.rest.trim() && pairable(m, second)) {
      const without = rest.slice(0, paren.index) + rest.slice(paren.index! + paren[0].length)
      return { m, alt: second, rest: without.replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim() }
    }
  }
  return { m, alt: null, rest }
}

export function describeIngredient(
  raw: string,
  density?: Density | null,
): IngredientDisplay {
  const line = raw.replace(/\s+/g, ' ').trim()
  const read = readAmounts(line)
  if (!read) return { amount: null, metric: null, estimate: null, ...splitNote(line) }
  const { m, alt, rest } = read

  if (alt) {
    // The scale reading always lands in the metric slot, whichever order the
    // recipe wrote them in: the metric one, or else the weight, in grams.
    const scale = metricSymbol(m.unit)
      ? m
      : metricSymbol(alt.unit) || unitFamily(alt.unit) === 'mass'
        ? alt
        : m
    return {
      amount: writeMeasure(scale === m ? alt : m),
      metric: metricSymbol(scale.unit) ? writeMetric(scale) : exactMetric(scale),
      estimate: null,
      ...splitNote(rest),
    }
  }
  const exact = metricSymbol(m.unit) ? null : exactMetric(m)
  // "5 cups broccoli (1 large head, ~300g)": the author already said what it
  // weighs, in their own words. An estimate beside it would argue with them.
  const authorWeighed = /\d\s*(?:g|kg|grams?|ml|oz|ounces?|lbs?)\b/i.test(rest)
  const estimated = exact || authorWeighed ? null : estimateMetric(m, density)
  return {
    amount: writeMeasure(m),
    metric: exact ?? estimated,
    estimate: estimated ? density!.source : null,
    ...splitNote(rest),
  }
}

/**
 * The recipe author's own pair, when a line has a volume and a weight side
 * by side — "1/3 cup (50 g) flour". That's a measurement of the ingredient's
 * density, and weights.ts learns from it.
 */
export function authorPair(raw: string): { ml: number; grams: number } | null {
  const read = readAmounts(raw.replace(/\s+/g, ' ').trim())
  if (!read?.alt) return null
  const a = toBase(read.m.quantity, read.m.unit)
  const b = toBase(read.alt.quantity, read.alt.unit)
  if (!a || !b) return null
  if (a.family === 'volume' && b.family === 'mass') return { ml: a.quantityBase, grams: b.quantityBase }
  if (a.family === 'mass' && b.family === 'volume') return { ml: b.quantityBase, grams: a.quantityBase }
  return null
}

// Below a tablespoon, or under 5 g, a scale reading isn't worth having: the
// spoon is the better tool, and kitchen scales wobble by a gram or two.
const SMALLEST_ESTIMATE_ML = 14.7
const SMALLEST_ESTIMATE_G = 5

/** "≈ 125 g" for "1 cup flour", given a density from measured data. */
function estimateMetric(m: Measure, density: Density | null | undefined): string | null {
  if (!density || !m.number || unitFamily(m.unit) !== 'volume') return null
  const ends = m.number.split(/\s*[-–]\s*/).map((part) => toBase(parseNumber(part), m.unit))
  if (ends.some((e) => !e)) return null
  const ml = ends.map((e) => e!.quantityBase)
  if (ml[0]! < SMALLEST_ESTIMATE_ML) return null
  const grams = ml.map((v) => v * density.gPerMl)
  if (grams[0]! < SMALLEST_ESTIMATE_G) return null
  const shown = grams.map(roughGrams)
  // "≈ 125–250 g" rather than "≈ 125 g–250 g".
  const both = shown.length === 2 && shown.every((g) => g.endsWith(' g'))
  const figure = both ? `${shown[0]!.slice(0, -2)}–${shown[1]}` : shown.join('–')
  return `≈ ${figure}${m.numberPlus || m.unitPlus}`
}

/**
 * An estimate rounded to what it can honestly claim. "≈ 487 g" pretends to a
 * precision the cup it came from never had; "≈ 490 g" doesn't.
 */
function roughGrams(g: number): string {
  if (g >= 1000) return formatBase(g, 'mass')
  const step = g < 30 ? 1 : g < 300 ? 5 : 10
  return `${Math.round(g / step) * step} g`
}

const FRACTION_GLYPHS: Record<string, string> = {
  '1/2': '½',
  '1/3': '⅓',
  '2/3': '⅔',
  '1/4': '¼',
  '3/4': '¾',
  '1/5': '⅕',
  '1/6': '⅙',
  '1/8': '⅛',
  '3/8': '⅜',
  '5/8': '⅝',
  '7/8': '⅞',
}

/** "1 1/2" → "1½". Easier to read at arm's length than slashes. */
function prettyNumber(n: string): string {
  return n.replace(/(?:(\d+)\s+)?(\d+)\/(\d+)/g, (match, whole, num, den) => {
    const glyph = FRACTION_GLYPHS[`${num}/${den}`]
    return glyph ? `${whole ?? ''}${glyph}` : match
  })
}

function writeMeasure(m: Measure): string {
  const number = `${prettyNumber(m.number ?? '')}${m.numberPlus}`
  return m.unitText ? `${number} ${m.unitText}${m.unitPlus}` : number
}

function writeMetric(m: Measure): string {
  return `${prettyNumber(m.number ?? '')}${m.numberPlus} ${metricSymbol(m.unit)}${m.unitPlus}`
}

/**
 * Grams for a weight given in pounds or ounces, millilitres for fluid ounces.
 * Same family, so it's arithmetic rather than an estimate. A range converts
 * both ends — "1–2 lb" is not 454 g.
 */
function exactMetric(m: Measure): string | null {
  if (!m.unit || !m.number) return null
  const family = unitFamily(m.unit)
  if (family !== 'mass' && m.unit !== 'fl oz') return null
  const ends = m.number
    .split(/\s*[-–]\s*/)
    .map((part) => toBase(parseNumber(part), m.unit))
  if (ends.some((e) => !e)) return null
  const shown = ends.map((e) => formatBase(e!.quantityBase, e!.family))
  const plus = m.numberPlus || m.unitPlus
  if (shown.length === 2) {
    const [low, high] = shown as [string, string]
    const lowUnit = low.split(' ')[1]
    const sameUnit = lowUnit === high.split(' ')[1]
    return `${sameUnit ? low.split(' ')[0] : low}–${high}${plus}`
  }
  return `${shown[0]}${plus}`
}

// What tends to open the quiet part of a line, after a comma: how it's
// prepared ("minced", "thinly sliced"), or a qualifier ("plus more for
// serving", "any fat %"). A comma before anything else is part of the name —
// "boneless, skinless chicken thighs" is one ingredient.
const NOTE_START =
  /^(?:[a-z]+(?:ed|ly)|cut|plus|or|to|for|at|about|such|preferably|ideally|optional|any|low|from|if|into|in|with|without|see|divided|room|cold|warm|hot|more|less|approx\w*|i|use|note|each|as|torn)\b/i

function splitNote(rest: string): { text: string; note: string | null } {
  const s = rest.trim()
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ',' && depth === 0) {
      const before = s.slice(0, i).trim()
      const after = s.slice(i + 1).trim()
      if (before && after && NOTE_START.test(after)) return { text: before, note: after }
    }
  }
  // Otherwise a trailing "(…)" is the aside: "broccoli (1 large head, Note 1)".
  // It keeps its parentheses so it reads the way it was written.
  const aside = s.match(/^(.*\S)\s*(\((?:[^()]|\([^()]*\))*\))$/)
  if (aside) return { text: aside[1]!, note: aside[2]! }
  return { text: s, note: null }
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
