import { and, asc, desc, eq, gte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { itemState, items, pantryEvents } from '../db/schema.js'
import { formatBase, type UnitFamily } from './units.js'

export type Level = 'plenty' | 'some' | 'low' | 'out'

// Rough per-family thresholds for turning a number into a word. These are
// deliberately coarse: the app must never imply precision it doesn't have.
const THRESHOLDS: Record<UnitFamily, { low: number; some: number }> = {
  mass: { low: 150, some: 600 },
  volume: { low: 150, some: 600 },
  count: { low: 1, some: 3 },
}

// Category defaults: how fast our belief about an item goes stale, and roughly
// how long the thing itself lasts.
export const CATEGORY_DEFAULTS: Record<
  string,
  { stalenessHalfLifeDays: number; shelfLifeDays: number | null }
> = {
  produce: { stalenessHalfLifeDays: 4, shelfLifeDays: 7 },
  dairy: { stalenessHalfLifeDays: 10, shelfLifeDays: 14 },
  meat: { stalenessHalfLifeDays: 5, shelfLifeDays: 4 },
  frozen: { stalenessHalfLifeDays: 60, shelfLifeDays: 180 },
  bakery: { stalenessHalfLifeDays: 4, shelfLifeDays: 5 },
  dry: { stalenessHalfLifeDays: 90, shelfLifeDays: 365 },
  canned: { stalenessHalfLifeDays: 120, shelfLifeDays: 730 },
  condiment: { stalenessHalfLifeDays: 90, shelfLifeDays: 365 },
  beverage: { stalenessHalfLifeDays: 30, shelfLifeDays: 180 },
  other: { stalenessHalfLifeDays: 30, shelfLifeDays: null },
}

export function levelFromQuantity(
  quantityBase: number | null | undefined,
  family: string | null | undefined,
): Level | null {
  if (quantityBase == null) return null
  const t = THRESHOLDS[(family as UnitFamily) ?? 'count'] ?? THRESHOLDS.count
  if (quantityBase <= 0) return 'out'
  if (quantityBase < t.low) return 'low'
  if (quantityBase < t.some) return 'some'
  return 'plenty'
}

const DAY_MS = 86_400_000

/**
 * Confidence decays from the last time a human confirmed the item.
 * Derived at read time from timestamps — never stored, so it can't go stale.
 */
export function freshness(
  lastConfirmedAt: Date | null | undefined,
  halfLifeDays: number,
  now = new Date(),
): { confidence: number; ageDays: number | null; stale: boolean } {
  if (!lastConfirmedAt) return { confidence: 0, ageDays: null, stale: true }
  const ageDays = (now.getTime() - lastConfirmedAt.getTime()) / DAY_MS
  const confidence = Math.pow(0.5, ageDays / Math.max(halfLifeDays, 0.5))
  return { confidence, ageDays, stale: confidence < 0.25 }
}

export function describeAge(ageDays: number | null): string | null {
  if (ageDays == null) return null
  if (ageDays < 1) return 'today'
  if (ageDays < 2) return 'yesterday'
  if (ageDays < 14) return `${Math.round(ageDays)} days ago`
  if (ageDays < 60) return `${Math.round(ageDays / 7)} weeks ago`
  return `${Math.round(ageDays / 30)} months ago`
}

export type ItemView = {
  id: number
  name: string
  category: string
  unitFamily: string
  level: Level | 'unknown'
  levelLabel: string
  quantityBase: number | null
  quantityLabel: string
  stale: boolean
  ageDays: number | null
  lastConfirmedLabel: string | null
  useBySoon: boolean
}

const LEVEL_LABEL: Record<Level | 'unknown', string> = {
  plenty: 'plenty',
  some: 'some',
  low: 'low',
  out: 'out',
  unknown: 'not sure',
}

export function buildItemView(
  item: typeof items.$inferSelect,
  state: typeof itemState.$inferSelect | undefined,
  now = new Date(),
): ItemView {
  const { confidence, ageDays, stale } = freshness(
    state?.lastHumanConfirmedAt ?? null,
    item.stalenessHalfLifeDays,
    now,
  )
  const rawLevel =
    (state?.levelEstimate as Level | null) ??
    levelFromQuantity(state?.quantityBaseEstimate, state?.unitFamily) ??
    null

  // Honesty rule: a confident-looking number we haven't confirmed in ages
  // gets demoted rather than displayed as fact.
  let level: Level | 'unknown' = rawLevel ?? 'unknown'
  if (rawLevel && rawLevel !== 'out' && confidence < 0.12) level = 'unknown'

  const label =
    level === 'unknown'
      ? stale && ageDays != null
        ? 'stale info'
        : 'not sure'
      : level === 'out'
        ? 'out'
        : stale
          ? `probably ${LEVEL_LABEL[level]}`
          : LEVEL_LABEL[level]

  const shelfLife = item.shelfLifeDays
  const useBySoon =
    shelfLife != null &&
    ageDays != null &&
    level !== 'out' &&
    level !== 'unknown' &&
    ageDays > shelfLife * 0.6

  return {
    id: item.id,
    name: item.name,
    category: item.category,
    unitFamily: item.unitFamily,
    level,
    levelLabel: label,
    quantityBase: state?.quantityBaseEstimate ?? null,
    quantityLabel: formatBase(
      state?.quantityBaseEstimate,
      state?.unitFamily ?? item.unitFamily,
    ),
    stale,
    ageDays,
    lastConfirmedLabel: describeAge(ageDays),
    useBySoon,
  }
}

export type NewEvent = {
  itemId: number
  type: 'purchase' | 'consume' | 'spoilage' | 'adjust_delta' | 'snapshot'
  quantity?: number | null
  unit?: string | null
  quantityBase?: number | null
  unitFamily?: string | null
  level?: Level | null
  occurredAt?: Date
  sourceType?: string
  sourceId?: number | null
  note?: string | null
  /** Human-confirmed events reset the confidence clock. */
  humanConfirmed?: boolean
}

/** Append events and refresh the projection. Call inside a transaction. */
export function appendEvents(events: NewEvent[], now = new Date()) {
  if (events.length === 0) return
  for (const e of events) {
    db.insert(pantryEvents)
      .values({
        itemId: e.itemId,
        type: e.type,
        quantity: e.quantity ?? null,
        unit: e.unit ?? null,
        quantityBase: e.quantityBase ?? null,
        unitFamily: e.unitFamily ?? null,
        level: e.level ?? null,
        occurredAt: e.occurredAt ?? now,
        recordedAt: now,
        sourceType: e.sourceType ?? 'api',
        sourceId: e.sourceId ?? null,
        note: e.note ?? null,
      })
      .run()
  }
  const touched = [...new Set(events.map((e) => e.itemId))]
  for (const itemId of touched) recomputeItemState(itemId)
}

/** Fold the ledger for one item into item_state. */
export function recomputeItemState(itemId: number) {
  const events = db
    .select()
    .from(pantryEvents)
    .where(eq(pantryEvents.itemId, itemId))
    .orderBy(asc(pantryEvents.occurredAt), asc(pantryEvents.id))
    .all()

  let quantityBase: number | null = null
  let family: string | null = null
  let level: Level | null = null
  let lastEventAt: Date | null = null
  let lastHumanConfirmedAt: Date | null = null

  // Losing a step of a fuzzy level is what happens when something was used
  // but we can't say how much.
  const degrade = (current: Level | null): Level | null =>
    current === 'plenty' ? 'some' : current === 'some' ? 'low' : current === 'low' ? null : current

  for (const e of events) {
    lastEventAt = e.occurredAt
    // Any event whose source is a human confirmation resets the clock.
    if (e.sourceType !== 'system') lastHumanConfirmedAt = e.occurredAt

    if (e.type === 'snapshot') {
      // Absolute assertion — replaces everything before it.
      quantityBase = e.quantityBase ?? null
      level = (e.level as Level | null) ?? null
      if (e.unitFamily) family = e.unitFamily
      if (e.level === 'out') quantityBase = 0
      continue
    }

    const isAddition = e.type === 'purchase' || e.type === 'adjust_delta'

    // THE UNIT RULE: never do arithmetic across unit families. A recipe
    // measured in grams cannot be subtracted from a pantry tracked in
    // millilitres — doing so silently corrupts the ledger, which is exactly
    // the failure mode this design exists to prevent. When the families
    // disagree we keep the fuzzy level and drop the number, because "some"
    // is true and "396 g" would be a lie.
    const familyMismatch =
      e.quantityBase != null &&
      e.unitFamily != null &&
      family != null &&
      e.unitFamily !== family

    if (e.quantityBase != null && !familyMismatch) {
      if (e.unitFamily) family = e.unitFamily
      quantityBase = Math.max(
        0,
        (quantityBase ?? 0) + (isAddition ? e.quantityBase : -e.quantityBase),
      )
      level = null // a number supersedes a fuzzy level
    } else if (familyMismatch) {
      level = isAddition ? 'plenty' : degrade(levelFromQuantity(quantityBase, family) ?? level)
      quantityBase = null
    } else if (!isAddition) {
      // Used an unmeasured amount: we now know less than we did.
      level = degrade(level ?? levelFromQuantity(quantityBase, family))
      if (level != null) quantityBase = null
    }
  }

  const row = {
    itemId,
    quantityBaseEstimate: quantityBase,
    unitFamily: family,
    levelEstimate: level,
    lastEventAt,
    lastHumanConfirmedAt,
  }
  db.insert(itemState)
    .values(row)
    .onConflictDoUpdate({ target: itemState.itemId, set: row })
    .run()
}

/** Ledger is the only truth: this rebuilds the projection from scratch. */
export function rebuildAllItemState() {
  const all = db.select({ id: items.id }).from(items).all()
  for (const { id } of all) recomputeItemState(id)
  return all.length
}

export function itemLedger(itemId: number, limit = 100) {
  return db
    .select()
    .from(pantryEvents)
    .where(eq(pantryEvents.itemId, itemId))
    .orderBy(desc(pantryEvents.occurredAt), desc(pantryEvents.id))
    .limit(limit)
    .all()
}

/** Items whose belief is fresh enough to be worth showing as "use these up". */
export function recentlyPurchased(sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * DAY_MS)
  return db
    .select()
    .from(pantryEvents)
    .where(
      and(eq(pantryEvents.type, 'purchase'), gte(pantryEvents.occurredAt, since)),
    )
    .all()
}
