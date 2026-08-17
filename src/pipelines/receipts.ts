import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db/client.js'
import {
  items,
  receiptLines,
  receipts,
  settings,
  stores,
} from '../db/schema.js'
import { appendEvents } from '../domain/pantry.js'
import {
  findOrCreateItem,
  lookupAlias,
  relinkUnresolvedIngredients,
  upsertAlias,
} from '../domain/resolve.js'
import { lookupPlu } from '../domain/plu.js'
import {
  type CodeKind,
  codeAliasKey,
  codeIsGlobal,
  parseReceiptStructure,
} from '../domain/receipt-structure.js'
import { normalizeReceiptText, quantityFromReceiptLine } from '../domain/text.js'
import { normalizeUnit, toBase, unitFamily } from '../domain/units.js'
import { enqueue, registerHandler } from '../services/jobs.js'
import { structured } from '../services/ollama.js'
import {
  lookupBarcode,
  openFoodFactsConfigured,
  ProductLookupUnavailableError,
  type ProductFacts,
} from '../services/openfoodfacts.js'
import {
  correspondentName,
  fetchTaggedDocs,
  paperlessConfigured,
  resolveTagId,
  type PaperlessDoc,
} from '../services/paperless.js'

// ---------- settings helpers ----------

function getSetting(key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null
}

function setSetting(key: string, value: string) {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
}

// ---------- store detection ----------

function findOrCreateStore(name: string) {
  const clean = name.trim().slice(0, 60)
  if (!clean) return null
  const existing = db.select().from(stores).where(eq(stores.name, clean)).get()
  if (existing) return existing
  return db.insert(stores).values({ name: clean }).returning().get()
}

async function detectStore(doc: PaperlessDoc) {
  if (doc.correspondent) {
    const name = await correspondentName(doc.correspondent)
    if (name) return findOrCreateStore(name)
  }
  const firstLine = doc.content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 2 && /[a-z]{3}/i.test(l))
  return firstLine ? findOrCreateStore(firstLine) : null
}

// ---------- intake ----------

/** Idempotent by paperless_doc_id: safe to call from poller and webhook. */
export async function ingestDocument(doc: PaperlessDoc) {
  const existing = db
    .select()
    .from(receipts)
    .where(eq(receipts.paperlessDocId, doc.id))
    .get()
  if (existing) return existing

  const store = await detectStore(doc)
  const receipt = db
    .insert(receipts)
    .values({
      paperlessDocId: doc.id,
      storeId: store?.id ?? null,
      purchasedAt: new Date(doc.created),
      rawText: doc.content ?? '',
      status: 'pending_parse',
    })
    .returning()
    .get()

  // Known non-grocery store (learned from a previous dismissal): skip
  // entirely — no review, no LLM call.
  if (store?.nonGrocery) {
    db.update(receipts)
      .set({ status: 'dismissed', note: `auto-skipped: ${store.name} is not groceries` })
      .where(eq(receipts.id, receipt.id))
      .run()
    return receipt
  }

  parseReceiptDeterministic(receipt.id)
  return db.select().from(receipts).where(eq(receipts.id, receipt.id)).get()!
}

/** A receipt that isn't in Paperless: pasted text, or entered by hand. */
export function createManualReceipt(input: {
  storeName?: string | null
  rawText: string
  purchasedAt?: Date | null
}) {
  const store = input.storeName ? findOrCreateStore(input.storeName) : null
  const receipt = db
    .insert(receipts)
    .values({
      storeId: store?.id ?? null,
      purchasedAt: input.purchasedAt ?? new Date(),
      rawText: input.rawText,
      status: 'pending_parse',
    })
    .returning()
    .get()
  parseReceiptDeterministic(receipt.id)
  return db.select().from(receipts).where(eq(receipts.id, receipt.id)).get()!
}

/** Pass 1: structure + learned aliases + PLU. No network, works offline. */
export function parseReceiptDeterministic(receiptId: number) {
  const receipt = db.select().from(receipts).where(eq(receipts.id, receiptId)).get()
  if (!receipt) return
  db.delete(receiptLines).where(eq(receiptLines.receiptId, receiptId)).run()

  const lines = parseReceiptStructure(receipt.rawText)
  let unresolved = 0

  lines.forEach((line, idx) => {
    // The code is the better key: it survives the OCR mangling the name, and a
    // UPC or PLU means the same product in every store.
    const alias =
      (line.code && line.codeKind
        ? lookupAlias(
            'receipt',
            codeAliasKey(line.codeKind, line.code),
            codeIsGlobal(line.codeKind) ? null : receipt.storeId,
          )
        : null) ?? lookupAlias('receipt', normalizeReceiptText(line.rawText), receipt.storeId)

    const embedded = quantityFromReceiptLine(line.rawText)
    // A weight folded up from the line below beats anything embedded in the
    // text — it's the amount the scale actually printed.
    const quantity = line.quantity ?? alias?.defaultQuantity ?? embedded.quantity
    const unit = line.unit ?? alias?.defaultUnit ?? embedded.unit

    // Produce codes are standardised, so a known PLU names the food outright —
    // no model needed, and it's right even when the text reads "LEHON".
    const plu = line.codeKind === 'plu' ? lookupPlu(line.code!) : null
    if (!alias && !plu) unresolved++

    db.insert(receiptLines)
      .values({
        receiptId,
        lineNo: idx,
        rawText: line.rawText,
        code: line.code,
        codeKind: line.codeKind,
        department: line.department,
        itemId: alias?.itemId ?? null,
        proposedName: alias ? null : plu,
        quantity,
        unit,
        unitFamily: unitFamily(unit),
        resolution: alias ? 'alias' : plu ? 'plu' : 'unresolved',
        status: 'proposed',
      })
      .run()
  })

  db.update(receipts)
    .set({ status: 'needs_review', parseMethod: 'alias_only' })
    .where(eq(receipts.id, receiptId))
    .run()

  if (unresolved > 0) enqueue('parse_receipt_lines', { receiptId })
}

// ---------- pass 2: the LLM, for never-seen-before lines only ----------

const ReceiptParse = z.object({
  is_grocery_receipt: z
    .boolean()
    .describe('false for invoices, bills, gas, hardware, restaurants'),
  items: z.array(
    z.object({
      index: z.number().describe('the number shown before the line'),
      is_item: z.boolean().describe('false for totals, discounts, junk'),
      name: z
        .string()
        .describe(
          'the generic food, brand removed, as a recipe would name it: ' +
            '"gnocchi", "chicken broth", "baby spinach", "chicken breast"',
        ),
      quantity: z.number().describe('0 if unknown'),
      unit: z.string().describe('g, kg, lb, ml, l, ea — empty string if unknown'),
      category: z.string().describe(
        'produce, dairy, meat, frozen, bakery, dry, canned, condiment, beverage, or other',
      ),
    }),
  ),
})

const CATEGORIES = new Set([
  'produce', 'dairy', 'meat', 'frozen', 'bakery',
  'dry', 'canned', 'condiment', 'beverage', 'other',
])

/**
 * Look up every barcoded line, and write what comes back to the line before
 * the model is asked anything.
 *
 * Order matters: if forte is asleep the structured() call below throws and the
 * job requeues, and these proposals are already saved. A barcode answer is
 * still a *proposal* — nothing here is ever auto-confirmed.
 *
 * A lookup failure is never fatal. Rate limiting stops the batch (their ask,
 * and the queue will come back to it), anything else just leaves the line for
 * the model.
 */
async function lookupReceiptBarcodes(
  lines: (typeof receiptLines.$inferSelect)[],
): Promise<Map<number, ProductFacts>> {
  const found = new Map<number, ProductFacts>()
  if (!openFoodFactsConfigured()) return found

  for (const line of lines) {
    if (line.codeKind !== 'upc' || !line.code) continue
    let facts: ProductFacts | null
    try {
      facts = await lookupBarcode(line.code)
    } catch (err) {
      if (err instanceof ProductLookupUnavailableError) break
      throw err
    }
    if (!facts?.name) continue
    found.set(line.id, facts)
    db.update(receiptLines)
      .set({
        proposedName: facts.name.toLowerCase(),
        // The pack size is the amount that entered the pantry — but never over
        // a weight the scale actually printed.
        ...(line.quantity == null && facts.quantity != null
          ? {
              quantity: facts.quantity,
              unit: facts.unit,
              unitFamily: unitFamily(facts.unit),
            }
          : {}),
        ...(line.department == null && facts.category ? { department: facts.category } : {}),
        resolution: 'barcode',
      })
      .where(eq(receiptLines.id, line.id))
      .run()
  }
  return found
}

registerHandler('parse_receipt_lines', async (payload: { receiptId: number }) => {
  const receipt = db
    .select()
    .from(receipts)
    .where(eq(receipts.id, payload.receiptId))
    .get()
  if (!receipt || receipt.status === 'confirmed' || receipt.status === 'dismissed') return

  // Barcode-resolved lines come back into the batch on a retry: the lookup is
  // cached so it costs nothing, and it gives the model a second chance to turn
  // "Pâte de tomates" into the English name once forte is awake again.
  const pending = db
    .select()
    .from(receiptLines)
    .where(
      and(
        eq(receiptLines.receiptId, receipt.id),
        inArray(receiptLines.resolution, ['unresolved', 'barcode']),
      ),
    )
    .all()
  if (pending.length === 0) return

  const store = receipt.storeId
    ? db.select().from(stores).where(eq(stores.id, receipt.storeId)).get()
    : null

  // Rung above the model: ask what the barcode actually is. Written to the
  // line straight away so it survives forte being asleep — the model refines
  // these below, it isn't required to produce them.
  const facts = await lookupReceiptBarcodes(pending)

  // One call for the whole receipt: cheaper, and the model does better with
  // sibling lines as context than with isolated ones.
  const result = await structured({
    schema: ReceiptParse,
    system:
      'You read grocery receipt lines and turn abbreviated store text into the generic name a ' +
      'RECIPE would use for that food. ' +
      'Strip the brand, the store label, the pack size and the marketing words — they say who ' +
      'sold it, not what it is: "GRT VAL CHKN BRST 2LB" is chicken breast (quantity 2, unit lb), ' +
      '"VITA SANA POTATO GNOCCHI 500G" is gnocchi, "CAMPBELLS CHKN BROTH" is chicken broth, ' +
      '"EB FARMS ORG BABY SPINACH" is baby spinach. ' +
      'Keep the words that change what the food IS — canned vs fresh, whole vs ground, the cut ' +
      'of meat, the kind of flour — and drop everything else. ' +
      'Set is_item=false for totals, taxes, deposits, discounts, addresses, and anything that is ' +
      'not a purchased food or household product. ' +
      'Some lines are tagged with the department they were printed under — trust it over the ' +
      'abbreviation, so a mangled line under [meat] is a cut of meat, not a ready meal. ' +
      'Use the department for the category too. ' +
      'A line may also carry "barcode:" — the real product, looked up from the barcode printed ' +
      'on it. That is what was actually bought, so trust it over the abbreviation when they ' +
      'disagree, and translate it if it is not in English. Still answer with the generic food: ' +
      'the brand is given separately so you can drop it. ' +
      'Return one entry per numbered line, using that number as index. Never invent items.',
    user:
      `Store: ${store?.name ?? 'unknown'}\n\n` +
      `Receipt lines:\n${pending
        .map((l, i) => {
          const f = facts.get(l.id)
          // Name and brand only. Showing the pack size here made the model
          // copy it into the unit field ("unit": "900 ml") — and the pack size
          // has already been applied deterministically anyway.
          const barcode = f
            ? ` (barcode: ${[f.name, f.brand && `by ${f.brand}`].filter(Boolean).join(', ')})`
            : ''
          return `${i + 1}. ${l.department ? `[${l.department}] ` : ''}${l.rawText}${barcode}`
        })
        .join('\n')}`,
  })

  // Triage: a whole receipt of non-groceries gets flagged, not force-fed
  // into the pantry.
  if (!result.is_grocery_receipt) {
    db.update(receipts)
      .set({ note: 'This does not look like a grocery receipt.' })
      .where(eq(receipts.id, receipt.id))
      .run()
  }

  pending.forEach((line, i) => {
    // Index is the contract; exact-text matching was too brittle because
    // models normalize whitespace and punctuation.
    const match = result.items.find((m) => m.index === i + 1)
    if (!match) return
    if (!match.is_item || !result.is_grocery_receipt) {
      db.update(receiptLines)
        .set({ status: 'ignored', resolution: 'llm' })
        .where(eq(receiptLines.id, line.id))
        .run()
      return
    }
    // Re-read: the barcode pass may have written a quantity onto this line
    // after `pending` was captured.
    const current = db
      .select()
      .from(receiptLines)
      .where(eq(receiptLines.id, line.id))
      .get()!
    // A scale reading or a printed pack size is a measurement; the model's
    // quantity is a guess. Measurements win, and an unrecognised unit is
    // dropped rather than stored — that's how "900 ml" ended up as a unit.
    const modelUnit = normalizeUnit(match.unit)
    const measured = current.quantity != null
    const quantity = measured
      ? current.quantity
      : match.quantity > 0
        ? match.quantity
        : null
    const unit = measured ? current.unit : (modelUnit ?? current.unit)
    db.update(receiptLines)
      .set({
        proposedName: match.name.trim().toLowerCase(),
        quantity,
        unit,
        unitFamily: unitFamily(unit),
        resolution: 'llm',
      })
      .where(eq(receiptLines.id, line.id))
      .run()
  })

  db.update(receipts)
    .set({ parseMethod: 'llm' })
    .where(eq(receipts.id, receipt.id))
    .run()
})

// ---------- confirmation: the learning loop ----------

export type ConfirmLine = {
  id: number
  action: 'confirm' | 'ignore'
  itemId?: number | null
  name?: string | null
  quantity?: number | null
  unit?: string | null
  category?: string | null
}

/**
 * One transaction: purchase events + alias writes + status. Every confirmed
 * line teaches the alias table permanently, which is why the fifth receipt
 * from a store barely needs review.
 */
export function confirmReceipt(receiptId: number, input: ConfirmLine[]) {
  const receipt = db.select().from(receipts).where(eq(receipts.id, receiptId)).get()
  if (!receipt) throw new Error('receipt not found')
  const lines = db
    .select()
    .from(receiptLines)
    .where(eq(receiptLines.receiptId, receiptId))
    .all()
  const byId = new Map(lines.map((l) => [l.id, l]))
  const now = new Date()
  const occurredAt = receipt.purchasedAt ?? now

  db.transaction(() => {
    const events = []
    for (const decision of input) {
      const line = byId.get(decision.id)
      if (!line) continue
      if (decision.action === 'ignore') {
        db.update(receiptLines)
          .set({ status: 'ignored' })
          .where(eq(receiptLines.id, line.id))
          .run()
        // Learn that this line is noise for this store? No — a line the user
        // skips today might matter tomorrow. Only item mappings are learned.
        continue
      }

      const name = decision.name?.trim() || line.proposedName || line.rawText
      // The department the line was printed under is a better default than
      // "other" when nobody picked a category.
      const category = decision.category ?? line.department ?? undefined
      const quantity = decision.quantity ?? line.quantity ?? 1
      const unit = decision.unit ?? line.unit ?? 'ea'
      const base = toBase(quantity, unit)
      const item = decision.itemId
        ? db.select().from(items).where(eq(items.id, decision.itemId)).get()!
        : findOrCreateItem(name, {
            category,
            unitFamily: base?.family ?? 'count',
          })

      db.update(receiptLines)
        .set({
          status: 'confirmed',
          itemId: item.id,
          quantity,
          unit,
          unitFamily: base?.family ?? null,
          resolution: 'human',
        })
        .where(eq(receiptLines.id, line.id))
        .run()

      // Learn the text, and — when the line carried one — the code as well.
      // The code is what makes the lesson stick: next month the OCR will read
      // the name differently, but the digits will be the same.
      upsertAlias({
        domain: 'receipt',
        rawTextNormalized: normalizeReceiptText(line.rawText),
        storeId: receipt.storeId,
        itemId: item.id,
        defaultQuantity: quantity,
        defaultUnit: unit,
        source: 'human',
      })
      if (line.code && line.codeKind) {
        const kind = line.codeKind as CodeKind
        upsertAlias({
          domain: 'receipt',
          rawTextNormalized: codeAliasKey(kind, line.code),
          // A weight varies shop to shop, so a loose-produce code teaches the
          // item but never a default amount.
          storeId: codeIsGlobal(kind) ? null : receipt.storeId,
          itemId: item.id,
          defaultQuantity: kind === 'plu' ? null : quantity,
          defaultUnit: kind === 'plu' ? null : unit,
          source: 'human',
        })
      }

      events.push({
        itemId: item.id,
        type: 'purchase' as const,
        quantity,
        unit,
        quantityBase: base?.quantityBase ?? null,
        unitFamily: base?.family ?? null,
        occurredAt,
        sourceType: 'receipt_line',
        sourceId: line.id,
      })
    }
    appendEvents(events, now)
    db.update(receipts)
      .set({ status: 'confirmed', confirmedAt: now })
      .where(eq(receipts.id, receiptId))
      .run()
  })
  // Groceries just landed: recipes that wanted them should say so now, rather
  // than waiting to be re-imported.
  relinkUnresolvedIngredients()
}

/** Dismissing teaches too: "not groceries" is remembered per store. */
export function dismissReceipt(receiptId: number, markStoreNonGrocery = false) {
  const receipt = db.select().from(receipts).where(eq(receipts.id, receiptId)).get()
  if (!receipt) throw new Error('receipt not found')
  db.update(receipts)
    .set({ status: 'dismissed' })
    .where(eq(receipts.id, receiptId))
    .run()
  if (markStoreNonGrocery && receipt.storeId) {
    db.update(stores)
      .set({ nonGrocery: true })
      .where(eq(stores.id, receipt.storeId))
      .run()
  }
}

// ---------- the poller ----------

const CURSOR_KEY = 'paperless_cursor_added'
const TAG_KEY = 'paperless_tag_id'

export async function pollPaperless(): Promise<number> {
  if (!paperlessConfigured()) return 0
  let tagId = Number(getSetting(TAG_KEY) ?? '') || null
  if (!tagId) {
    tagId = await resolveTagId(config.PAPERLESS_RECEIPT_TAG!)
    if (!tagId) throw new Error(`Paperless tag "${config.PAPERLESS_RECEIPT_TAG}" not found`)
    setSetting(TAG_KEY, String(tagId))
  }
  const cursorRaw = getSetting(CURSOR_KEY)
  const cursor = cursorRaw ? new Date(cursorRaw) : null
  const docs = await fetchTaggedDocs(tagId, cursor)
  let ingested = 0
  for (const doc of docs) {
    await ingestDocument(doc)
    ingested++
    setSetting(CURSOR_KEY, doc.added)
  }
  return ingested
}

export function startPaperlessPoller(intervalMs = 180_000) {
  const tick = async () => {
    try {
      const n = await pollPaperless()
      if (n > 0) console.log(`[paperless] ingested ${n} document(s)`)
    } catch (err) {
      console.warn('[paperless] poll failed:', String(err))
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return timer
}
