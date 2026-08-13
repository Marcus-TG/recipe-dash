// Unit physics lives in code, not the database — it never varies per
// deployment. Per-ITEM density is data (items.density_g_per_ml) because it
// genuinely differs by ingredient.

export type UnitFamily = 'mass' | 'volume' | 'count'

// Base units: mass = g, volume = ml, count = each
const UNITS: Record<string, { family: UnitFamily; toBase: number }> = {
  g: { family: 'mass', toBase: 1 },
  gram: { family: 'mass', toBase: 1 },
  grams: { family: 'mass', toBase: 1 },
  kg: { family: 'mass', toBase: 1000 },
  kilogram: { family: 'mass', toBase: 1000 },
  kilograms: { family: 'mass', toBase: 1000 },
  oz: { family: 'mass', toBase: 28.3495 },
  ounce: { family: 'mass', toBase: 28.3495 },
  ounces: { family: 'mass', toBase: 28.3495 },
  lb: { family: 'mass', toBase: 453.592 },
  lbs: { family: 'mass', toBase: 453.592 },
  pound: { family: 'mass', toBase: 453.592 },
  pounds: { family: 'mass', toBase: 453.592 },

  ml: { family: 'volume', toBase: 1 },
  millilitre: { family: 'volume', toBase: 1 },
  milliliter: { family: 'volume', toBase: 1 },
  l: { family: 'volume', toBase: 1000 },
  litre: { family: 'volume', toBase: 1000 },
  liter: { family: 'volume', toBase: 1000 },
  liters: { family: 'volume', toBase: 1000 },
  litres: { family: 'volume', toBase: 1000 },
  tsp: { family: 'volume', toBase: 4.92892 },
  teaspoon: { family: 'volume', toBase: 4.92892 },
  teaspoons: { family: 'volume', toBase: 4.92892 },
  tbsp: { family: 'volume', toBase: 14.7868 },
  tablespoon: { family: 'volume', toBase: 14.7868 },
  tablespoons: { family: 'volume', toBase: 14.7868 },
  cup: { family: 'volume', toBase: 236.588 },
  cups: { family: 'volume', toBase: 236.588 },
  'fl oz': { family: 'volume', toBase: 29.5735 },
  pint: { family: 'volume', toBase: 473.176 },
  quart: { family: 'volume', toBase: 946.353 },

  // Countable things — deliberately all "1 each". A clove is not a gram and
  // we refuse to pretend otherwise.
  ea: { family: 'count', toBase: 1 },
  each: { family: 'count', toBase: 1 },
  count: { family: 'count', toBase: 1 },
  clove: { family: 'count', toBase: 1 },
  cloves: { family: 'count', toBase: 1 },
  can: { family: 'count', toBase: 1 },
  cans: { family: 'count', toBase: 1 },
  package: { family: 'count', toBase: 1 },
  pkg: { family: 'count', toBase: 1 },
  pack: { family: 'count', toBase: 1 },
  loaf: { family: 'count', toBase: 1 },
  bag: { family: 'count', toBase: 1 },
  box: { family: 'count', toBase: 1 },
  jar: { family: 'count', toBase: 1 },
  bottle: { family: 'count', toBase: 1 },
  tin: { family: 'count', toBase: 1 },
  carton: { family: 'count', toBase: 1 },
  tub: { family: 'count', toBase: 1 },
  container: { family: 'count', toBase: 1 },
  bunch: { family: 'count', toBase: 1 },
  head: { family: 'count', toBase: 1 },
  slice: { family: 'count', toBase: 1 },
  slices: { family: 'count', toBase: 1 },
  stalk: { family: 'count', toBase: 1 },
  stick: { family: 'count', toBase: 1 },
  dozen: { family: 'count', toBase: 12 },
  large: { family: 'count', toBase: 1 },
  medium: { family: 'count', toBase: 1 },
  small: { family: 'count', toBase: 1 },
  whole: { family: 'count', toBase: 1 },
}

/**
 * Plurals the table doesn't spell out. Worth doing generically rather than
 * listing every form: an unrecognized unit doesn't just lose the amount, it
 * leaks into the ingredient NAME ("2 packages gnocchi" → "packages gnocchi"),
 * and then nothing in the pantry can ever match it.
 */
function depluralize(u: string): string | null {
  if (u.endsWith('ves')) return `${u.slice(0, -3)}f` // loaves → loaf
  if (u.endsWith('es') && UNITS[u.slice(0, -2)]) return u.slice(0, -2) // boxes → box
  if (u.endsWith('s')) return u.slice(0, -1) // packages → package
  return null
}

export function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) return null
  const u = unit.trim().toLowerCase().replace(/\.$/, '')
  if (!u) return null
  if (UNITS[u]) return u
  // "fl. oz." and friends
  const collapsed = u.replace(/[.\s]+/g, ' ').trim()
  if (UNITS[collapsed]) return collapsed
  const singular = depluralize(collapsed)
  return singular && UNITS[singular] ? singular : null
}

export function unitFamily(unit: string | null | undefined): UnitFamily | null {
  const u = normalizeUnit(unit)
  return u ? UNITS[u]!.family : null
}

/** Convert to the family's base unit (g / ml / each). Null if unknown. */
export function toBase(
  quantity: number | null | undefined,
  unit: string | null | undefined,
): { quantityBase: number; family: UnitFamily } | null {
  if (quantity == null || !Number.isFinite(quantity)) return null
  const u = normalizeUnit(unit)
  if (!u) return null
  const def = UNITS[u]!
  return { quantityBase: quantity * def.toBase, family: def.family }
}

/** Human-friendly rendering of a base quantity. */
export function formatBase(
  quantityBase: number | null | undefined,
  family: UnitFamily | string | null | undefined,
): string {
  if (quantityBase == null) return '—'
  const q = quantityBase
  if (family === 'mass') {
    return q >= 1000 ? `${round(q / 1000)} kg` : `${round(q)} g`
  }
  if (family === 'volume') {
    return q >= 1000 ? `${round(q / 1000)} L` : `${round(q)} ml`
  }
  return `${round(q)}`
}

function round(n: number) {
  return Math.round(n * 100) / 100
}
