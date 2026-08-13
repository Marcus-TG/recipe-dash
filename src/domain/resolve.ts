import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  aliases,
  cookSessionLines,
  itemState,
  items,
  pantryEvents,
  receiptLines,
  recipeIngredients,
} from '../db/schema.js'
import { CATEGORY_DEFAULTS, recomputeItemState } from './pantry.js'
import {
  foodTokens,
  normalizeItemName,
  parseIngredientLine,
  singularize,
} from './text.js'

export type AliasDomain = 'receipt' | 'ingredient'

/** Look up a learned mapping. Store-scoped first, then global. */
export function lookupAlias(
  domain: AliasDomain,
  rawNormalized: string,
  storeId: number | null,
) {
  const rows = db
    .select()
    .from(aliases)
    .where(
      and(
        eq(aliases.domain, domain),
        eq(aliases.rawTextNormalized, rawNormalized),
      ),
    )
    .all()
  if (rows.length === 0) return null
  const scoped = storeId != null ? rows.find((r) => r.storeId === storeId) : null
  const global = rows.find((r) => r.storeId == null)
  const hit = scoped ?? global ?? rows[0]!
  db.update(aliases)
    .set({ hitCount: hit.hitCount + 1, lastUsedAt: new Date() })
    .where(eq(aliases.id, hit.id))
    .run()
  return hit
}

/**
 * Write the permanent memory. Human corrections always overwrite LLM guesses;
 * LLM guesses never overwrite a human's.
 */
export function upsertAlias(input: {
  domain: AliasDomain
  rawTextNormalized: string
  storeId: number | null
  itemId: number
  defaultQuantity?: number | null
  defaultUnit?: string | null
  source: 'human' | 'llm'
}) {
  if (!input.rawTextNormalized) return
  const existing = db
    .select()
    .from(aliases)
    .where(
      and(
        eq(aliases.domain, input.domain),
        eq(aliases.rawTextNormalized, input.rawTextNormalized),
        input.storeId == null
          ? isNull(aliases.storeId)
          : eq(aliases.storeId, input.storeId),
      ),
    )
    .get()

  if (existing) {
    if (existing.source === 'human' && input.source === 'llm') return
    db.update(aliases)
      .set({
        itemId: input.itemId,
        defaultQuantity: input.defaultQuantity ?? existing.defaultQuantity,
        defaultUnit: input.defaultUnit ?? existing.defaultUnit,
        source: input.source,
      })
      .where(eq(aliases.id, existing.id))
      .run()
    return
  }
  db.insert(aliases)
    .values({
      domain: input.domain,
      storeId: input.storeId,
      rawTextNormalized: input.rawTextNormalized,
      itemId: input.itemId,
      defaultQuantity: input.defaultQuantity ?? null,
      defaultUnit: input.defaultUnit ?? null,
      source: input.source,
    })
    .run()
}

export function findItemByName(name: string) {
  const normalized = normalizeItemName(name)
  if (!normalized) return null
  const exact = db
    .select()
    .from(items)
    .where(sql`lower(${items.name}) = ${normalized}`)
    .get()
  if (exact) return exact
  const singular = singularize(normalized)
  const all = db.select().from(items).all()
  return (
    all.find((i) => singularize(normalizeItemName(i.name)) === singular) ?? null
  )
}

export function findOrCreateItem(
  name: string,
  opts: { category?: string; unitFamily?: string } = {},
) {
  const existing = findItemByName(name)
  if (existing) return existing
  const category = opts.category ?? 'other'
  const defaults = CATEGORY_DEFAULTS[category] ?? CATEGORY_DEFAULTS.other!
  return db
    .insert(items)
    .values({
      name: normalizeItemName(name) || name.trim(),
      category,
      unitFamily: opts.unitFamily ?? 'count',
      shelfLifeDays: defaults.shelfLifeDays,
      stalenessHalfLifeDays: defaults.stalenessHalfLifeDays,
    })
    .returning()
    .get()
}

/**
 * Rename an item, absorbing any item that already owns the new name.
 *
 * Renaming "vita sana potato gnocchi" to "gnocchi" is the whole point of the
 * feature, and the moment two brands of the same thing are in the pantry that
 * rename is a collision. Merging rather than refusing is the honest answer:
 * they were always the same food. The ledger MOVES — it is never rewritten or
 * dropped, so "why does it think that?" still traces back to the receipt.
 */
export function renameItem(id: number, rawName: string) {
  const item = db.select().from(items).where(eq(items.id, id)).get()
  if (!item) return null
  const name = normalizeItemName(rawName) || rawName.trim()
  if (!name) throw new Error('a name is required')
  if (name === item.name) return item

  const collision = db.select().from(items).where(eq(items.name, name)).get()
  db.transaction(() => {
    if (!collision) {
      db.update(items).set({ name }).where(eq(items.id, id)).run()
      return
    }
    const target = collision.id
    // Aliases are uniquely keyed on (domain, store, text); the same wording
    // may already point at the target, in which case the loser is redundant.
    for (const alias of db.select().from(aliases).where(eq(aliases.itemId, id)).all()) {
      const taken = db
        .select()
        .from(aliases)
        .where(
          and(
            eq(aliases.domain, alias.domain),
            eq(aliases.rawTextNormalized, alias.rawTextNormalized),
            alias.storeId == null
              ? isNull(aliases.storeId)
              : eq(aliases.storeId, alias.storeId),
            eq(aliases.itemId, target),
          ),
        )
        .get()
      if (taken) db.delete(aliases).where(eq(aliases.id, alias.id)).run()
      else db.update(aliases).set({ itemId: target }).where(eq(aliases.id, alias.id)).run()
    }
    db.update(pantryEvents).set({ itemId: target }).where(eq(pantryEvents.itemId, id)).run()
    db.update(receiptLines).set({ itemId: target }).where(eq(receiptLines.itemId, id)).run()
    db.update(recipeIngredients)
      .set({ itemId: target })
      .where(eq(recipeIngredients.itemId, id))
      .run()
    db.update(cookSessionLines)
      .set({ itemId: target })
      .where(eq(cookSessionLines.itemId, id))
      .run()
    db.delete(itemState).where(eq(itemState.itemId, id)).run()
    db.delete(items).where(eq(items.id, id)).run()
    recomputeItemState(target)
  })
  relinkUnresolvedIngredients()
  const finalId = collision?.id ?? id
  return db.select().from(items).where(eq(items.id, finalId)).get() ?? null
}

/**
 * Does this pantry item satisfy an ingredient the recipe asked for?
 *
 * One-directional on purpose. A pantry name may carry EXTRA words the recipe
 * doesn't — brand, store, pack size — so "gnocchi" is answered by "vita sana
 * potato gnocchi". The reverse is not allowed: extra words on the RECIPE side
 * are usually meaningful, so pantry "cream" must not answer "sour cream".
 * Both must agree on the head noun, which is what stops "corn" matching
 * "cornstarch" and "ham" matching "graham crackers".
 *
 * Returns how many spare words the pantry name carries (lower = closer), or
 * null for no match.
 */
export function containmentDistance(
  ingredientTokens: string[],
  itemTokens: string[],
): number | null {
  if (ingredientTokens.length === 0 || itemTokens.length === 0) return null
  if (ingredientTokens.at(-1) !== itemTokens.at(-1)) return null
  const have = new Set(itemTokens)
  if (!ingredientTokens.every((t) => have.has(t))) return null
  return itemTokens.length - ingredientTokens.length
}

/**
 * The resolution ladder for a recipe ingredient name, cheapest first.
 * Returns null rather than guessing — unresolved is a legal state.
 */
export function resolveIngredientName(name: string): number | null {
  const normalized = normalizeItemName(name)
  if (!normalized) return null
  const alias = lookupAlias('ingredient', normalized, null)
  if (alias) return alias.itemId
  const item = findItemByName(normalized)
  if (item) return item.id

  const wanted = foodTokens(normalized)
  if (wanted.length === 0) return null
  // Closest wins — the item with the fewest spare words is the least of a
  // stretch. Name breaks ties so the answer doesn't depend on row order.
  const ranked = db
    .select()
    .from(items)
    .all()
    .map((i) => ({ item: i, distance: containmentDistance(wanted, foodTokens(i.name)) }))
    .filter((c): c is { item: typeof c.item; distance: number } => c.distance != null)
    .sort((a, b) => a.distance - b.distance || a.item.name.localeCompare(b.item.name))
  return ranked[0]?.item.id ?? null
}

/**
 * Re-run the cheap rungs for every ingredient still unlinked. Called whenever
 * the pantry gains or renames an item: buying gnocchi should light up the
 * recipes that wanted gnocchi, without re-importing them.
 */
export function relinkUnresolvedIngredients(): number {
  const pending = db
    .select()
    .from(recipeIngredients)
    .where(isNull(recipeIngredients.itemId))
    .all()
  let linked = 0
  for (const ing of pending) {
    const itemId = resolveIngredientName(parseIngredientLine(ing.rawText).name)
    if (!itemId) continue
    db.update(recipeIngredients)
      .set({ itemId, resolution: 'parsed' })
      .where(eq(recipeIngredients.id, ing.id))
      .run()
    linked++
  }
  return linked
}
