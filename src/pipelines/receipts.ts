import { and, eq } from 'drizzle-orm'
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
import { findOrCreateItem, lookupAlias, upsertAlias } from '../domain/resolve.js'
import {
  normalizeReceiptText,
  quantityFromReceiptLine,
  segmentReceipt,
} from '../domain/text.js'
import { toBase, unitFamily } from '../domain/units.js'
import { enqueue, registerHandler } from '../services/jobs.js'
import { structured } from '../services/ollama.js'
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

/** Pass 1: segmentation + learned aliases. No network, works offline. */
export function parseReceiptDeterministic(receiptId: number) {
  const receipt = db.select().from(receipts).where(eq(receipts.id, receiptId)).get()
  if (!receipt) return
  db.delete(receiptLines).where(eq(receiptLines.receiptId, receiptId)).run()

  const lines = segmentReceipt(receipt.rawText)
  let unresolved = 0

  lines.forEach((raw, idx) => {
    const normalized = normalizeReceiptText(raw)
    const alias = lookupAlias('receipt', normalized, receipt.storeId)
    const embedded = quantityFromReceiptLine(raw)
    const quantity = alias?.defaultQuantity ?? embedded.quantity
    const unit = alias?.defaultUnit ?? embedded.unit
    if (!alias) unresolved++
    db.insert(receiptLines)
      .values({
        receiptId,
        lineNo: idx,
        rawText: raw,
        itemId: alias?.itemId ?? null,
        quantity,
        unit,
        unitFamily: unitFamily(unit),
        resolution: alias ? 'alias' : 'unresolved',
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
      name: z.string().describe('plain English item name, e.g. "chicken breast"'),
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

registerHandler('parse_receipt_lines', async (payload: { receiptId: number }) => {
  const receipt = db
    .select()
    .from(receipts)
    .where(eq(receipts.id, payload.receiptId))
    .get()
  if (!receipt || receipt.status === 'confirmed' || receipt.status === 'dismissed') return

  const pending = db
    .select()
    .from(receiptLines)
    .where(
      and(
        eq(receiptLines.receiptId, receipt.id),
        eq(receiptLines.resolution, 'unresolved'),
      ),
    )
    .all()
  if (pending.length === 0) return

  const store = receipt.storeId
    ? db.select().from(stores).where(eq(stores.id, receipt.storeId)).get()
    : null

  // One call for the whole receipt: cheaper, and the model does better with
  // sibling lines as context than with isolated ones.
  const result = await structured({
    schema: ReceiptParse,
    system:
      'You read grocery receipt lines and turn abbreviated store text into plain English item names. ' +
      'Example: "GRT VAL CHKN BRST 2LB" is chicken breast, quantity 2, unit lb. ' +
      'Set is_item=false for totals, taxes, deposits, discounts, addresses, and anything that is ' +
      'not a purchased food or household product. ' +
      'Return one entry per numbered line, using that number as index. Never invent items.',
    user:
      `Store: ${store?.name ?? 'unknown'}\n\n` +
      `Receipt lines:\n${pending.map((l, i) => `${i + 1}. ${l.rawText}`).join('\n')}`,
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
    const unit = match.unit?.trim() || null
    db.update(receiptLines)
      .set({
        proposedName: match.name.trim().toLowerCase(),
        quantity: match.quantity > 0 ? match.quantity : line.quantity,
        unit: unit ?? line.unit,
        unitFamily: unitFamily(unit ?? line.unit),
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
      const category = decision.category ?? undefined
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

      upsertAlias({
        domain: 'receipt',
        rawTextNormalized: normalizeReceiptText(line.rawText),
        storeId: receipt.storeId,
        itemId: item.id,
        defaultQuantity: quantity,
        defaultUnit: unit,
        source: 'human',
      })

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
