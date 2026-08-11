import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aliases, items } from '../db/schema.js'
import { CATEGORY_DEFAULTS } from './pantry.js'
import { normalizeItemName, singularize } from './text.js'

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
  // Loose containment: "diced tomatoes" vs item "tomatoes"
  const singular = singularize(normalized)
  const all = db.select().from(items).all()
  const contained = all.find((i) => {
    const n = singularize(normalizeItemName(i.name))
    return n.length > 3 && (singular.includes(n) || n.includes(singular))
  })
  return contained?.id ?? null
}
