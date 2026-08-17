import { lookupPlu } from './plu.js'
import { normalizeUnit } from './units.js'

/**
 * A receipt is not a list of items — it's a list of items interleaved with
 * department headers and with the weight of anything sold loose printed on the
 * NEXT line. Reading it line-by-line throws both of those away: the department
 * is free category information, and the weight line is the only place the
 * quantity exists.
 *
 * Everything here is deterministic and offline. The model only ever sees what
 * this pass couldn't work out.
 */

export type CodeKind = 'upc' | 'plu' | 'sku'

export type StructuredLine = {
  lineNo: number
  rawText: string
  code: string | null
  codeKind: CodeKind | null
  /** Our category vocabulary, from the department header above this line. */
  department: string | null
  quantity: number | null
  unit: string | null
}

// Department headers appear as "27-PRODUCE" (Fortinos) or a bare "PRODUCE" /
// "Meat" (Martlu's). The OCR mangles them — "31-HEATS" is meats, "35-DELT" is
// deli — so matching is fuzzy rather than exact.
const DEPARTMENTS: { match: string[]; category: string | null }[] = [
  { match: ['produce', 'fruit', 'vegetable', 'veg'], category: 'produce' },
  { match: ['meat', 'meats', 'butcher', 'poultry'], category: 'meat' },
  { match: ['seafood', 'fish'], category: 'meat' },
  { match: ['deli', 'delicatessen'], category: 'other' },
  { match: ['dairy', 'creamery'], category: 'dairy' },
  { match: ['frozen'], category: 'frozen' },
  { match: ['bakery', 'bake shop', 'bread'], category: 'bakery' },
  { match: ['grocery', 'natural foods', 'centre store', 'center store'], category: null },
  { match: ['beverage', 'beverages', 'drinks'], category: 'beverage' },
  { match: ['household', 'general merchandise', 'health', 'beauty'], category: 'other' },
]

/** One substitution/insertion/deletion apart — enough for OCR letter swaps. */
function nearlyEqual(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false
    return diff === 1
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a]
  for (let i = 0; i < long.length; i++) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true
  }
  return false
}

/**
 * A numbered department header: "21-GROCERY", "36-HOME MEAL REPLACEMENT".
 *
 * The shape is the signal, not the words. Matching on the words alone can't
 * survive OCR — "36-HOME MEAL REPLACEMENT" arrives as "36-HONE WEAL
 * REPLACENENT", three letters wrong, and got treated as something bought. Two
 * digits, a dash, then capitals and no price is a header whether or not we
 * recognise the department.
 *
 * The no-price rule is what keeps a real item like "12-GRAIN BREAD 4.99" out.
 */
const NUMBERED_DEPARTMENT = /^\d{2}\s*[-–—]\s*([A-Z][A-Z\s.&'-]{2,})$/

/**
 * A department header, or null. Requires the line to be nothing BUT the
 * header — "MEAT PIE 4.99" is an item, not the meat department.
 *
 * Three-way return: a category string, `null` for "a header, but not one of
 * our categories", and `undefined` for "not a header at all". Both of the
 * first two mean the line is structure rather than shopping.
 */
export function departmentOf(raw: string): string | null | undefined {
  const line = raw.trim()
  const numbered = NUMBERED_DEPARTMENT.exec(line)
  if (numbered && !/\d+[.,]\d{2}/.test(line)) {
    return categoryForWords(numbered[1]!)
  }
  const text = normalizeDepartmentWords(line)
  if (!text || text.length > 20) return undefined
  for (const dept of DEPARTMENTS) {
    if (dept.match.some((m) => nearlyEqual(text, m))) return dept.category
  }
  return undefined
}

function normalizeDepartmentWords(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^\d{1,3}\s*[-–—]\s*/, '') // "27-PRODUCE"
    .replace(/\bnon[- ]?taxable\b|\btaxable\b/g, '') // "Grocery Non Taxable"
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Best category for a known-header's words; null when none of ours fit. */
function categoryForWords(words: string): string | null {
  const text = normalizeDepartmentWords(words)
  for (const dept of DEPARTMENTS) {
    if (dept.match.some((m) => text.split(' ').some((w) => nearlyEqual(w, m)))) {
      return dept.category
    }
  }
  return null
}

/**
 * The weight line printed under a loose item: "0.125 kg @ $8.80/kg 1.10".
 *
 * When OCR destroys the weight itself ("i a kg @ $17.61/kg 8.28") the rate and
 * the line total both survive, and weight = total / rate. That division is
 * exactly the arithmetic you'd otherwise be doing by hand at the review screen.
 */
export function parseWeightLine(
  raw: string,
): { quantity: number; unit: string } | null {
  if (!raw.includes('@')) return null
  // "/1b" and "/ib" are how OCR renders "/lb".
  const text = raw.replace(/\/\s*[1il]b\b/gi, '/lb')

  const rateMatch = text.match(/@\s*\$?\s*(\d+[.,]\d{1,2})\s*\/\s*(kg|lb|g|100\s*g)\b/i)
  if (!rateMatch) return null
  const unit = normalizeUnit(rateMatch[2]!.replace(/\s+/g, ''))
  if (!unit) return null

  // Preferred: the weight is printed before the "@".
  const before = text.slice(0, text.indexOf('@'))
  const explicit = before.match(/(\d+[.,]\d+|\d+)\s*(kg|lb|g)?\s*$/i)
  if (explicit) {
    const q = Number(explicit[1]!.replace(',', '.'))
    // A bare integer before "@" is usually a mangled price, not a weight;
    // only trust it when it carries a unit or a decimal point.
    if (Number.isFinite(q) && q > 0 && (explicit[2] || explicit[1]!.match(/[.,]/))) {
      return { quantity: q, unit: normalizeUnit(explicit[2] ?? unit) ?? unit }
    }
  }

  // Fall back to total ÷ rate.
  const rate = Number(rateMatch[1]!.replace(',', '.'))
  const after = text.slice(text.indexOf(rateMatch[0]!) + rateMatch[0]!.length)
  const total = after.match(/\$?\s*(\d+[.,]\d{2})\b/)
  if (!rate || !total) return null
  const quantity = Number(total[1]!.replace(',', '.')) / rate
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100) return null
  return { quantity: Math.round(quantity * 1000) / 1000, unit }
}

/**
 * The product code a line leads with, if any.
 *
 * A code is worth far more than the text beside it: it survives OCR, it
 * doesn't change when the store rewords its abbreviations, and a UPC or PLU
 * means the same thing in every store. Which is why the alias table keys on it
 * when it's there.
 */
export function productCode(
  raw: string,
  inItemBody: boolean,
): { code: string; kind: CodeKind; multiplier: number | null } | null {
  // Fortinos prefixes a multi-buy with its count: "(2)05590000399" is two of
  // them. Leaving it attached hid the code completely, so nothing was looked
  // up and the count was lost as well.
  const m = raw.match(/^\s*(?:\((\d{1,2})\)\s*)?(\d{4,14})\s+(?=\S*[A-Za-z])/)
  if (!m) return null
  const multiplier = m[1] ? Number(m[1]) : null
  const code = m[2]!
  if (code.length >= 11) return { code, kind: 'upc', multiplier }
  // A short code is a PLU only once the receipt has started listing things.
  // The guard is about POSITION, not department: stores file produce under
  // their grocery header often enough that requiring "produce" missed real
  // limes and jalapeños, while the thing it was written to stop — a shop's
  // own address, "4025 New Street" being PLU 4025, Anjou pears — is always up
  // in the letterhead, before any department header has appeared.
  if (inItemBody && code.length <= 5 && lookupPlu(code)) {
    return { code, kind: 'plu', multiplier }
  }
  return { code, kind: 'sku', multiplier }
}

const JUNK_LINE =
  /^(sub\s*total|total|tax|gst|pst|hst|qst|balance|change|cash|debit|credit|visa|master|interac|amex|auth|approved|appr|ref\s*#|term(inal)?|merchant|thank|points|loyalty|air\s*miles|pc\s*optimum|store\s*#|tel|phone|www\.|http|survey|customer copy|tender|amount|savings|you saved|# ?items|items? sold|item count|no\.? of items|cardholder|account|aid:|tvr|tsi|entry method|contactless|invoice|receipt|order|date|time|cashier|register|lane|transaction|purchase|payment|round|deposit|bottle|enviro|recycl|sequence|batch|response|trans|signature|retain|refund|return|exchange|discount|follow us|visit|scan|coupon|learn|win a|full contest|code:|create a|own offers|use them|owner)/i

const PRICE_ONLY = /^[\s$\d.,-]+$/

// Everything below the total is payment terminal output, loyalty marketing and
// returns policy — never an item. Cutting there removes most of the noise the
// model would otherwise have to rule out one line at a time.
const END_OF_ITEMS = /^\s*(sub\s*-?\s*total|total|balance|amount\s+due)\b/i

// Rate lines belong to the item above even when OCR wrecked them beyond
// arithmetic ("on 060 kg @ $15. a 1223"). Dropping one costs a quantity;
// keeping it invents an item that was never bought.
const RATE_LINE = /(\d\s*(kg|lbs?|g)\s*@)|(@\s*\$?\s*\d+[.,]\d)/i

/**
 * Split raw OCR text into item lines, carrying the department down and folding
 * each weight line up into the item it belongs to.
 */
export function parseReceiptStructure(rawText: string): StructuredLine[] {
  const out: StructuredLine[] = []
  let department: string | null = null
  // The letterhead is over once the first department header appears. Until
  // then a four-digit number is an address, not a PLU.
  let inItemBody = false

  for (const raw of rawText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length < 3 || !/[a-z]{2}/i.test(line)) continue

    // Only once we've actually seen items, so a "TOTAL SAVINGS" banner printed
    // above the list can't truncate the whole receipt.
    if (out.length > 0 && END_OF_ITEMS.test(line) && /\d/.test(line)) break

    const dept = departmentOf(line)
    if (dept !== undefined) {
      department = dept
      inItemBody = true
      continue
    }

    // Belongs to the item above it, not to itself.
    if (RATE_LINE.test(line)) {
      const weight = parseWeightLine(line)
      const previous = out.at(-1)
      // A scale reading is a measurement, so it also replaces a multi-buy
      // count — but never another weight.
      if (weight && previous && (previous.quantity == null || previous.unit === 'ea')) {
        previous.quantity = weight.quantity
        previous.unit = weight.unit
      }
      continue
    }

    if (JUNK_LINE.test(line) || PRICE_ONLY.test(line)) continue

    const code = productCode(line, inItemBody)
    out.push({
      lineNo: out.length,
      rawText: line,
      code: code?.code ?? null,
      codeKind: code?.kind ?? null,
      department,
      // A multi-buy count is a real count of packages; a weight line further
      // down can still overwrite it with what the scale said.
      quantity: code?.multiplier ?? null,
      unit: code?.multiplier != null ? 'ea' : null,
    })
  }
  return out
}

/** The alias key for a code. UPCs and PLUs mean the same thing everywhere. */
export function codeAliasKey(kind: CodeKind, code: string): string {
  return `#${kind}:${code}`
}

/** SKUs are the store's own numbering; UPCs and PLUs are universal. */
export function codeIsGlobal(kind: CodeKind): boolean {
  return kind !== 'sku'
}
