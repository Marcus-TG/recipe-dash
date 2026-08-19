import { desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  groceryListLines,
  groceryListRecipes,
  groceryLists,
  itemState,
  items,
  recipeIngredients,
  recipes,
} from '../db/schema.js'
import { buildItemView, type ItemView } from './pantry.js'
import { findItemByName } from './resolve.js'
import { normalizeItemName, parseIngredientLine } from './text.js'
import { formatBase, toBase } from './units.js'

/**
 * The order you actually walk a shop in, not alphabetical. This is the whole
 * point of grouping: the reason a paper list makes you scroll up and back down
 * is that it's in the order you wrote it, and you're standing in the produce
 * aisle wondering if there was anything else here.
 */
const AISLE_ORDER = [
  'produce',
  'bakery',
  'meat',
  'dairy',
  'frozen',
  'canned',
  'dry',
  'condiment',
  'beverage',
  'other',
]

const AISLE_LABEL: Record<string, string> = {
  produce: 'Produce',
  bakery: 'Bakery',
  meat: 'Meat & fish',
  dairy: 'Dairy & eggs',
  frozen: 'Frozen',
  canned: 'Tins & jars',
  dry: 'Dry goods',
  condiment: 'Condiments & oils',
  beverage: 'Drinks',
  other: 'Everything else',
}

export type GroceryReason =
  | 'missing'
  | 'short'
  | 'uncertain'
  | 'untracked'
  | 'manual'

export type GroceryLine = {
  key: string
  label: string
  itemId: number | null
  category: string
  source: 'recipe' | 'manual'
  reason: GroceryReason
  /** The total the recipes want, when we can honestly add them up. */
  needLabel: string | null
  /** What each recipe asked for, when we can't — never a guessed total. */
  asks: string[]
  /** What the pantry reckons is already home. */
  haveLabel: string | null
  forRecipes: string[]
  optional: boolean
  checked: boolean
}

export type GroceryAisle = {
  category: string
  label: string
  lines: GroceryLine[]
}

export type GroceryListView = {
  listId: number
  name: string
  recipes: {
    recipeId: number
    title: string
    thumbnail: string | null
    servings: number | null
    recipeServings: number | null
    status: string
  }[]
  aisles: GroceryAisle[]
  /** Things the recipes need that you already have — proof, not clutter. */
  covered: { label: string; detail: string | null }[]
  counts: { total: number; checked: number; remaining: number }
}

/** The one open list, created on first use. */
export function activeList() {
  const existing = db
    .select()
    .from(groceryLists)
    .where(eq(groceryLists.status, 'active'))
    .orderBy(desc(groceryLists.id))
    .get()
  if (existing) return existing
  return db.insert(groceryLists).values({}).returning().get()
}

type Contribution = {
  quantityBase: number | null
  family: string | null
  ask: string | null
  recipeTitle: string
}

type Need = {
  key: string
  label: string
  itemId: number | null
  optional: boolean
  contributions: Contribution[]
}

/**
 * Presence gates, quantity refines — the same ladder the "cookable tonight"
 * screen climbs, but asked of the WHOLE list at once. That difference matters:
 * two recipes each wanting 200 g of butter are individually satisfied by the
 * 300 g in the fridge and jointly are not, and a shopping list that answered
 * per-recipe would send you home 100 g short.
 *
 * Cross-family conversion still never happens without a per-item density. When
 * one recipe measures in cups and another in grams we stop totalling and print
 * both asks, because "1 cup + 200 g" is true and a single number would be a lie.
 */
function judge(
  need: Need,
  view: ItemView | undefined,
  density: number | null,
): { reason: GroceryReason | 'have'; haveLabel: string | null } {
  if (!need.itemId || !view) {
    return { reason: 'untracked', haveLabel: null }
  }
  if (view.level === 'out') {
    return { reason: 'missing', haveLabel: 'out' }
  }
  if (view.level === 'unknown') {
    return {
      reason: 'uncertain',
      haveLabel: view.lastConfirmedLabel
        ? `last seen ${view.lastConfirmedLabel}`
        : 'never confirmed',
    }
  }

  const needBase = totalBase(need, view.unitFamily, density)

  // We were handed numbers on both sides and still couldn't line them up —
  // one recipe says cups, the other says grams. Presence-only would answer
  // "you have butter", and you'd get home 300 g short of the 400 g and a cup
  // the two recipes between them wanted. Say "check the shelf" and print both
  // asks instead; an unreconcilable comparison is not the same as no
  // comparison, and only the second one is safe to shrug at.
  const unreconciled =
    needBase == null &&
    view.quantityBase != null &&
    need.contributions.some((c) => c.quantityBase != null)

  if (needBase != null && view.quantityBase != null) {
    // Same 10% slack as the cookable check: recipes round, humans scoop.
    if (view.quantityBase + 1e-9 >= needBase * 0.9) {
      return { reason: 'have', haveLabel: view.levelLabel }
    }
    return {
      reason: view.stale ? 'uncertain' : 'short',
      haveLabel: `have ${view.quantityLabel}`,
    }
  }

  // No comparable number: presence is all we've got, and stale presence is
  // worth a look in the shop rather than a confident "you have it".
  if (view.stale) {
    return {
      reason: 'uncertain',
      haveLabel: `last seen ${view.lastConfirmedLabel ?? 'a while ago'}`,
    }
  }
  if (unreconciled) {
    return { reason: 'uncertain', haveLabel: `have ${view.quantityLabel}` }
  }
  return { reason: 'have', haveLabel: view.levelLabel }
}

/** Sum the asks, but only when every one of them is in the same family. */
function totalBase(
  need: Need,
  pantryFamily: string | null,
  density: number | null,
): number | null {
  const measured = need.contributions.filter((c) => c.quantityBase != null)
  if (measured.length === 0 || measured.length !== need.contributions.length) {
    return null
  }
  const family = measured[0]!.family
  if (!family || measured.some((c) => c.family !== family)) return null
  const total = measured.reduce((sum, c) => sum + c.quantityBase!, 0)

  if (!pantryFamily) return null
  if (family === pantryFamily) return total
  if (density && family === 'volume' && pantryFamily === 'mass') {
    return total * density
  }
  if (density && family === 'mass' && pantryFamily === 'volume') {
    return total / density
  }
  return null // refuse to guess
}

function needLabelFor(need: Need): { needLabel: string | null; asks: string[] } {
  const measured = need.contributions.filter((c) => c.quantityBase != null)
  if (
    measured.length === need.contributions.length &&
    measured.length > 0 &&
    measured.every((c) => c.family === measured[0]!.family)
  ) {
    const total = measured.reduce((sum, c) => sum + c.quantityBase!, 0)
    return {
      needLabel: formatBase(total, measured[0]!.family),
      asks: [],
    }
  }
  return {
    needLabel: null,
    asks: need.contributions
      .map((c) => c.ask)
      .filter((a): a is string => a != null),
  }
}

function round(n: number) {
  return Math.round(n * 100) / 100
}

export function buildGroceryList(now = new Date()): GroceryListView {
  const list = activeList()

  const onList = db
    .select()
    .from(groceryListRecipes)
    .where(eq(groceryListRecipes.listId, list.id))
    .all()
  const recipeRows = onList.length
    ? db
        .select()
        .from(recipes)
        .where(
          inArray(
            recipes.id,
            onList.map((r) => r.recipeId),
          ),
        )
        .all()
    : []
  const recipeById = new Map(recipeRows.map((r) => [r.id, r]))

  const ings = recipeRows.length
    ? db
        .select()
        .from(recipeIngredients)
        .where(
          inArray(
            recipeIngredients.recipeId,
            recipeRows.map((r) => r.id),
          ),
        )
        .all()
    : []

  const allItems = db.select().from(items).all()
  const stateById = new Map(
    db
      .select()
      .from(itemState)
      .all()
      .map((s) => [s.itemId, s]),
  )
  const viewById = new Map<number, ItemView>()
  const densityById = new Map<number, number | null>()
  const itemById = new Map<number, (typeof allItems)[number]>()
  for (const item of allItems) {
    viewById.set(item.id, buildItemView(item, stateById.get(item.id), now))
    densityById.set(item.id, item.densityGPerMl)
    itemById.set(item.id, item)
  }

  const scaleByRecipe = new Map<number, number>()
  for (const entry of onList) {
    const recipe = recipeById.get(entry.recipeId)
    const base = recipe?.servings ?? null
    scaleByRecipe.set(
      entry.recipeId,
      entry.servings && base ? entry.servings / base : 1,
    )
  }

  // ---- gather every ask, keyed so the same food from two recipes merges ----
  const needs = new Map<string, Need>()
  for (const ing of ings) {
    const recipe = recipeById.get(ing.recipeId)
    if (!recipe) continue
    const parsed = parseIngredientLine(ing.rawText)
    const key = ing.itemId
      ? `item:${ing.itemId}`
      : `text:${normalizeItemName(parsed.name)}`
    const scale = scaleByRecipe.get(ing.recipeId) ?? 1
    const qty = ing.quantity != null ? ing.quantity * scale : null
    const base = toBase(qty, ing.unit)

    const need = needs.get(key) ?? {
      key,
      label: ing.itemId
        ? (itemById.get(ing.itemId)?.name ?? parsed.name)
        : parsed.name,
      itemId: ing.itemId,
      optional: true, // becomes false as soon as any recipe requires it
      contributions: [],
    }
    need.optional = need.optional && ing.optional
    need.contributions.push({
      quantityBase: base?.quantityBase ?? null,
      family: base?.family ?? null,
      ask:
        qty != null
          ? `${round(qty)}${ing.unit ? ` ${ing.unit}` : ''}`
          : null,
      recipeTitle: recipe.title,
    })
    needs.set(key, need)
  }

  // ---- the stored half: manual additions and which rows are in the cart ----
  const stored = db
    .select()
    .from(groceryListLines)
    .where(eq(groceryListLines.listId, list.id))
    .all()
  const decisionByKey = new Map(stored.map((l) => [l.key, l]))

  const lines: GroceryLine[] = []
  const covered: { label: string; detail: string | null }[] = []

  for (const need of needs.values()) {
    const decision = decisionByKey.get(need.key)
    if (decision?.dismissed) continue

    const view = need.itemId ? viewById.get(need.itemId) : undefined
    const density = need.itemId ? (densityById.get(need.itemId) ?? null) : null
    const verdict = judge(need, view, density)
    if (verdict.reason === 'have') {
      covered.push({ label: need.label, detail: verdict.haveLabel })
      continue
    }
    const { needLabel, asks } = needLabelFor(need)
    lines.push({
      key: need.key,
      label: need.label,
      itemId: need.itemId,
      category: need.itemId
        ? (itemById.get(need.itemId)?.category ?? 'other')
        : (findItemByName(need.label)?.category ?? 'other'),
      source: 'recipe',
      reason: verdict.reason,
      needLabel,
      asks,
      haveLabel: verdict.haveLabel,
      forRecipes: [...new Set(need.contributions.map((c) => c.recipeTitle))],
      optional: need.optional,
      checked: decision?.checked ?? false,
    })
  }

  for (const line of stored) {
    if (line.source !== 'manual' || line.dismissed) continue
    // Typing "parmesan" for a list that already wants parmesan is a merge, not
    // a second line: the stored row keeps carrying the checkbox, and the
    // recipes keep deciding the amount.
    if (needs.has(line.key)) continue
    const item = line.itemId
      ? itemById.get(line.itemId)
      : findItemByName(line.label)
    lines.push({
      key: line.key,
      label: line.label,
      itemId: item?.id ?? null,
      category: item?.category ?? 'other',
      source: 'manual',
      reason: 'manual',
      needLabel:
        line.quantity != null
          ? `${round(line.quantity)}${line.unit ? ` ${line.unit}` : ''}`
          : null,
      asks: [],
      haveLabel: null,
      forRecipes: [],
      optional: false,
      checked: line.checked,
    })
  }

  // ---- lay it out the way you walk the shop ----
  const aisles: GroceryAisle[] = []
  for (const category of AISLE_ORDER) {
    const inAisle = lines
      .filter((l) => l.category === category)
      .sort(
        (a, b) =>
          // Ticked rows sink, so the top of the list is always what's left.
          Number(a.checked) - Number(b.checked) ||
          Number(a.optional) - Number(b.optional) ||
          a.label.localeCompare(b.label),
      )
    if (inAisle.length > 0) {
      aisles.push({
        category,
        label: AISLE_LABEL[category] ?? category,
        lines: inAisle,
      })
    }
  }

  covered.sort((a, b) => a.label.localeCompare(b.label))

  return {
    listId: list.id,
    name: list.name,
    recipes: onList.map((entry) => {
      const recipe = recipeById.get(entry.recipeId)
      return {
        recipeId: entry.recipeId,
        title: recipe?.title ?? 'removed recipe',
        thumbnail: recipe?.imageFile ? `/uploads/${recipe.imageFile}` : null,
        servings: entry.servings,
        recipeServings: recipe?.servings ?? null,
        status: recipe?.status ?? 'missing',
      }
    }),
    aisles,
    covered,
    counts: {
      total: lines.length,
      checked: lines.filter((l) => l.checked).length,
      remaining: lines.filter((l) => !l.checked).length,
    },
  }
}
