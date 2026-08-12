import { inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { itemState, items, recipeIngredients, recipes } from '../db/schema.js'
import { buildItemView, type ItemView } from './pantry.js'
import { toBase } from './units.js'

export type IngredientVerdict =
  | 'have'
  | 'short'
  | 'uncertain'
  | 'missing'
  | 'untracked'

export type RecipeVerdict = 'cookable' | 'check_shelf' | 'almost' | 'not_tonight'

export type IngredientCheck = {
  ingredientId: number
  label: string
  itemId: number | null
  itemName: string | null
  verdict: IngredientVerdict
  detail: string | null
  optional: boolean
}

export type RecipeMatch = {
  recipeId: number
  title: string
  thumbnail: string | null
  verdict: RecipeVerdict
  missing: string[]
  uncertain: string[]
  untracked: string[]
  usesUp: string[]
  checks: IngredientCheck[]
}

/**
 * Presence gates, quantity refines. Cross-unit-family comparison NEVER
 * happens without a per-item density — we degrade to "do you have it at all"
 * instead of inventing a conversion.
 */
function checkIngredient(
  ing: typeof recipeIngredients.$inferSelect,
  view: ItemView | undefined,
  density: number | null,
): IngredientCheck {
  const base = {
    ingredientId: ing.id,
    label: ing.rawText,
    itemId: ing.itemId,
    itemName: view?.name ?? null,
    optional: ing.optional,
  }
  if (!ing.itemId || !view) {
    return { ...base, verdict: 'untracked', detail: 'not tracked' }
  }
  if (view.level === 'out') {
    return { ...base, verdict: 'missing', detail: 'out' }
  }
  if (view.level === 'unknown') {
    return {
      ...base,
      verdict: 'uncertain',
      detail: view.lastConfirmedLabel
        ? `last seen ${view.lastConfirmedLabel}`
        : 'never confirmed',
    }
  }

  // Quantity comparison only when the families line up (or a human gave us a
  // density for this specific item).
  const needBase = convertNeeded(ing, view.unitFamily, density)
  if (needBase != null && view.quantityBase != null) {
    // 10% slack: recipes round, humans scoop.
    if (view.quantityBase + 1e-9 >= needBase * 0.9) {
      return { ...base, verdict: 'have', detail: view.levelLabel }
    }
    return {
      ...base,
      verdict: view.stale ? 'uncertain' : 'short',
      detail: `have ${view.quantityLabel}`,
    }
  }

  return {
    ...base,
    verdict: view.stale ? 'uncertain' : 'have',
    detail: view.stale
      ? `last seen ${view.lastConfirmedLabel ?? 'a while ago'}`
      : view.levelLabel,
  }
}

function convertNeeded(
  ing: typeof recipeIngredients.$inferSelect,
  pantryFamily: string | null,
  density: number | null,
): number | null {
  if (ing.quantity == null || !ing.unitFamily || !pantryFamily) return null
  const need = baseOf(ing)
  if (need == null) return null
  if (ing.unitFamily === pantryFamily) return need
  if (density && ing.unitFamily === 'volume' && pantryFamily === 'mass') {
    return need * density
  }
  if (density && ing.unitFamily === 'mass' && pantryFamily === 'volume') {
    return need / density
  }
  return null // refuse to guess
}

function baseOf(ing: typeof recipeIngredients.$inferSelect): number | null {
  if (ing.quantity == null) return null
  return toBase(ing.quantity, ing.unit)?.quantityBase ?? null
}

export function matchRecipes(now = new Date()): RecipeMatch[] {
  const allRecipes = db.select().from(recipes).all()
  const cookable = allRecipes.filter(
    (r) => r.status === 'active' || r.status === 'needs_review',
  )
  if (cookable.length === 0) return []

  const ings = db
    .select()
    .from(recipeIngredients)
    .where(
      inArray(
        recipeIngredients.recipeId,
        cookable.map((r) => r.id),
      ),
    )
    .all()

  const allItems = db.select().from(items).all()
  const states = db.select().from(itemState).all()
  const stateById = new Map(states.map((s) => [s.itemId, s]))
  const viewById = new Map<number, ItemView>()
  const densityById = new Map<number, number | null>()
  for (const item of allItems) {
    viewById.set(item.id, buildItemView(item, stateById.get(item.id), now))
    densityById.set(item.id, item.densityGPerMl)
  }

  const byRecipe = new Map<number, typeof ings>()
  for (const ing of ings) {
    const list = byRecipe.get(ing.recipeId) ?? []
    list.push(ing)
    byRecipe.set(ing.recipeId, list)
  }

  const results: RecipeMatch[] = cookable.map((recipe) => {
    const list = byRecipe.get(recipe.id) ?? []
    const checks = list.map((ing) =>
      checkIngredient(
        ing,
        ing.itemId ? viewById.get(ing.itemId) : undefined,
        ing.itemId ? (densityById.get(ing.itemId) ?? null) : null,
      ),
    )
    const required = checks.filter((c) => !c.optional)
    const missing = required.filter(
      (c) => c.verdict === 'missing' || c.verdict === 'short',
    )
    const uncertain = required.filter((c) => c.verdict === 'uncertain')
    const usesUp = required
      .filter((c) => c.itemId && viewById.get(c.itemId)?.useBySoon)
      .map((c) => c.itemName!)
      .filter(Boolean)

    const untracked = required.filter((c) => c.verdict === 'untracked')

    let verdict: RecipeVerdict
    if (missing.length === 0 && uncertain.length === 0) verdict = 'cookable'
    else if (missing.length === 0) verdict = 'check_shelf'
    else if (missing.length <= 2) verdict = 'almost'
    else verdict = 'not_tonight'

    // Honesty check: if most of the ingredients aren't things we track, we
    // haven't really vouched for this recipe — say "probably", not "yes".
    if (
      verdict === 'cookable' &&
      required.length > 0 &&
      untracked.length / required.length >= 0.4
    ) {
      verdict = 'check_shelf'
    }

    return {
      recipeId: recipe.id,
      title: recipe.title,
      thumbnail: recipe.imageFile ? `/uploads/${recipe.imageFile}` : null,
      verdict,
      missing: missing.map((c) => c.itemName ?? c.label),
      uncertain: uncertain.map((c) => c.itemName ?? c.label),
      untracked: untracked.map((c) => c.label),
      usesUp,
      checks,
    }
  })

  const order: Record<RecipeVerdict, number> = {
    cookable: 0,
    check_shelf: 1,
    almost: 2,
    not_tonight: 3,
  }
  // Spoilage nudge is a SORT ORDER, never a notification.
  return results.sort(
    (a, b) =>
      order[a.verdict] - order[b.verdict] ||
      b.usesUp.length - a.usesUp.length ||
      a.missing.length - b.missing.length ||
      a.title.localeCompare(b.title),
  )
}
