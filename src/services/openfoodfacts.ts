import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { productCodes } from '../db/schema.js'
import { normalizeUnit } from '../domain/units.js'
import { version } from '../version.js'

/**
 * Open Food Facts turns a barcode into a product. Optional by design: when
 * it's switched off or unreachable, receipt parsing carries on exactly as it
 * did before, one rung further down the ladder.
 *
 * Two properties make it worth the network call. It returns the brand as its
 * OWN field, so stripping it from the name is exact rather than guesswork —
 * which is the whole "vita sana potato gnocchi" problem solved at the source.
 * And it returns the pack size, so a carton of broth enters the pantry as
 * 900 ml instead of "1 each".
 */

export type ProductFacts = {
  code: string
  name: string | null
  brand: string | null
  quantityText: string | null
  quantity: number | null
  unit: string | null
  category: string | null
}

export function openFoodFactsConfigured() {
  return config.OPENFOODFACTS_ENABLED && Boolean(config.OPENFOODFACTS_URL)
}

/**
 * The check digit a receipt doesn't print.
 *
 * A UPC-A is 1 number-system digit + 5 manufacturer + 5 product + 1 check, but
 * receipts print only the 11 significant digits — Fortinos shows
 * "06321112114" for a barcode that is really 063211121148. Without recomputing
 * that last digit nothing here would ever match.
 */
export function upcCheckDigit(digits: string): string {
  const sum = digits
    .split('')
    .reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0)
  return String((10 - (sum % 10)) % 10)
}

/** Barcodes to try for a code as printed, best guess first. */
export function barcodeCandidates(raw: string): string[] {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8) return []
  const out = new Set<string>()
  if (digits.length === 11) out.add(digits + upcCheckDigit(digits))
  if (digits.length === 12 || digits.length === 13) out.add(digits)
  if (digits.length === 12) out.add(`0${digits}`) // UPC-A stored as EAN-13
  if (digits.length === 13 && digits.startsWith('0')) out.add(digits.slice(1))
  if (digits.length === 8) out.add(digits) // EAN-8
  return [...out]
}

// Their documented ceiling is 15 product reads per minute per IP. One receipt
// is a handful of codes and every answer is cached forever, so pacing at 4.5s
// keeps us comfortably under it without ever needing a burst.
const MIN_INTERVAL_MS = 4_500
let lastRequestAt = 0

async function pace() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
}

/** Thrown when Open Food Facts is rate-limiting us — retry later, don't fail. */
export class ProductLookupUnavailableError extends Error {}

const FIELDS = [
  'product_name',
  'product_name_en',
  'brands',
  'quantity',
  'categories_tags',
].join(',')

// Umbrella tags that sit above nearly everything and decide nothing. They have
// to be skipped explicitly: "en:plant-based-foods-and-beverages" is on every
// tin of tomatoes, and reading it as a drink filed sundried tomatoes under
// beverages.
const UMBRELLA_TAG = /^(groceries|foods|plant-based-foods|.*-based-foods|.*-and-beverages)$/

// Within one tag, first match wins — how a thing is stored beats what it's
// made of, because shelf life is what the pantry actually reasons about.
const CATEGORY_TAGS: [RegExp, string][] = [
  [/frozen/, 'frozen'],
  [/canned|tinned|jarred|preserved|pickled/, 'canned'],
  [/broth|stock|bouillon|soup/, 'canned'],
  [/dried|dehydrated/, 'dry'],
  [/dairy|milk|cheese|yogurt|yoghurt|cream|butter/, 'dairy'],
  [/meat|poultry|chicken|beef|pork|lamb|sausage|fish|seafood|charcuterie/, 'meat'],
  [/bread|bakery|pastr|viennoiserie|cake/, 'bakery'],
  [/beverage|drink|water|juice|soda|coffee|tea/, 'beverage'],
  [/sauce|condiment|spread|vinegar|mustard|ketchup|mayonnaise|oil/, 'condiment'],
  [/fresh-vegetable|fresh-fruit|fresh-produce|herb/, 'produce'],
  [/pasta|rice|cereal|flour|legume|grain|snack|biscuit|cracker|chip/, 'dry'],
  [/vegetable|fruit/, 'produce'],
]

/**
 * Open Food Facts orders categories general → specific, so the answer is at
 * the END of the list: "en:canned-peas" tells you far more than "en:foods".
 */
function categoryFromTags(tags: string[] | undefined): string | null {
  for (const tag of [...(tags ?? [])].reverse()) {
    const name = tag.toLowerCase().replace(/^[a-z]{2}:/, '')
    if (!name || UMBRELLA_TAG.test(name)) continue
    for (const [pattern, category] of CATEGORY_TAGS) {
      if (pattern.test(name)) return category
    }
  }
  return null
}

/** "900ml" / "398 g" / "2 x 500 g" → the first real amount we can use. */
export function parsePackSize(
  text: string | null | undefined,
): { quantity: number; unit: string } | null {
  if (!text) return null
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(mg|kg|g|ml|cl|dl|l|oz|lb|lbs)\b/i)
  if (!m) return null
  let quantity = Number(m[1]!.replace(',', '.'))
  let raw = m[2]!.toLowerCase()
  // Units our own table doesn't carry, folded into ones it does.
  if (raw === 'mg') return null // too small to be a pack size worth tracking
  if (raw === 'cl') {
    quantity *= 10
    raw = 'ml'
  }
  if (raw === 'dl') {
    quantity *= 100
    raw = 'ml'
  }
  const unit = normalizeUnit(raw)
  if (!unit || !Number.isFinite(quantity) || quantity <= 0) return null
  return { quantity, unit }
}

/**
 * The brand as its own words, so it can be cut from the product name.
 * OFF writes a literal "null" string when a product has no brand.
 */
function cleanBrand(brands: string | undefined): string | null {
  const first = (brands ?? '').split(',')[0]?.trim()
  if (!first || first.toLowerCase() === 'null') return null
  return first
}

/**
 * "Chicken Broth" with brand "Campbell's" is already the generic food, but
 * plenty of products repeat the brand in the name. Cutting it is safe here
 * precisely because OFF told us what the brand is.
 */
export function stripBrand(name: string, brand: string | null): string {
  if (!brand) return name.trim()
  const words = brand
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2)
  if (words.length === 0) return name.trim()
  const kept = name
    .split(/\s+/)
    .filter((w) => !words.includes(w.toLowerCase().replace(/[^a-z0-9]/g, '')))
    .join(' ')
    .trim()
  // Never strip a name down to nothing — "Oreo" by "Oreo" is still Oreo.
  return kept.length >= 3 ? kept : name.trim()
}

function cached(code: string) {
  return db.select().from(productCodes).where(eq(productCodes.code, code)).get()
}

function remember(code: string, facts: ProductFacts | null) {
  db.insert(productCodes)
    .values({
      code,
      found: facts != null,
      name: facts?.name ?? null,
      brand: facts?.brand ?? null,
      quantityText: facts?.quantityText ?? null,
      quantity: facts?.quantity ?? null,
      unit: facts?.unit ?? null,
      category: facts?.category ?? null,
    })
    .onConflictDoNothing()
    .run()
}

async function fetchOne(barcode: string): Promise<ProductFacts | null> {
  await pace()
  let res: Response
  try {
    res = await fetch(
      `${config.OPENFOODFACTS_URL}/api/v2/product/${barcode}.json?fields=${FIELDS}`,
      {
        headers: {
          // Their API asks to be told who is calling; anonymous traffic gets
          // treated as a bot.
          'user-agent': `recipe-dash/${version} (${config.OPENFOODFACTS_CONTACT})`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      },
    )
  } catch {
    throw new ProductLookupUnavailableError('open food facts unreachable')
  }
  // Backing off is their explicit ask, and the job queue already knows how.
  if (res.status === 429 || res.status === 503) {
    throw new ProductLookupUnavailableError(`open food facts ${res.status}`)
  }
  if (res.status === 404) return null
  if (!res.ok) throw new ProductLookupUnavailableError(`open food facts ${res.status}`)

  const body = (await res.json()) as {
    status?: number
    product?: Record<string, unknown>
  }
  if (body.status !== 1 || !body.product) return null

  const p = body.product
  const brand = cleanBrand(p.brands as string | undefined)
  const rawName = ((p.product_name_en as string) || (p.product_name as string) || '').trim()
  const pack = parsePackSize(p.quantity as string | undefined)
  return {
    code: barcode,
    name: rawName ? stripBrand(rawName, brand) : null,
    brand,
    quantityText: (p.quantity as string) ?? null,
    quantity: pack?.quantity ?? null,
    unit: pack?.unit ?? null,
    category: categoryFromTags(p.categories_tags as string[] | undefined),
  }
}

/**
 * What is this barcode? Cache first — a barcode never changes its meaning, so
 * the same code is only ever fetched once, misses included.
 */
export async function lookupBarcode(printed: string): Promise<ProductFacts | null> {
  if (!openFoodFactsConfigured()) return null
  const candidates = barcodeCandidates(printed)
  if (candidates.length === 0) return null

  for (const barcode of candidates) {
    const hit = cached(barcode)
    if (hit) {
      if (!hit.found) continue
      return {
        code: hit.code,
        name: hit.name,
        brand: hit.brand,
        quantityText: hit.quantityText,
        quantity: hit.quantity,
        unit: hit.unit,
        category: hit.category,
      }
    }
    const facts = await fetchOne(barcode)
    remember(barcode, facts)
    if (facts) return facts
  }
  return null
}

export async function openFoodFactsReachable(): Promise<boolean> {
  if (!openFoodFactsConfigured()) return false
  try {
    const res = await fetch(`${config.OPENFOODFACTS_URL}/api/v2/product/737628064502.json?fields=code`, {
      headers: { 'user-agent': `recipe-dash/${version} (${config.OPENFOODFACTS_CONTACT})` },
      signal: AbortSignal.timeout(2500),
    })
    return res.ok
  } catch {
    return false
  }
}
