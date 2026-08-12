export type ItemView = {
  id: number
  name: string
  category: string
  unitFamily: string
  level: 'plenty' | 'some' | 'low' | 'out' | 'unknown'
  levelLabel: string
  quantityBase: number | null
  quantityLabel: string
  stale: boolean
  ageDays: number | null
  lastConfirmedLabel: string | null
  useBySoon: boolean
}

export type LedgerEvent = {
  id: number
  type: string
  quantity: number | null
  unit: string | null
  quantityBase: number | null
  level: string | null
  occurredAt: string
  sourceType: string
  note: string | null
  source: {
    kind: string
    label: string
    receiptId?: number
    recipeId?: number
  } | null
}

export type ReceiptSummary = {
  id: number
  storeName: string | null
  purchasedAt: string | null
  status: string
  lineCount: number
  note: string | null
}

export type ReceiptLine = {
  id: number
  rawText: string
  itemId: number | null
  itemName: string | null
  suggestion: string | null
  proposedName: string | null
  quantity: number | null
  unit: string | null
  resolution: string
  status: string
}

export type ReceiptDetail = {
  receipt: ReceiptSummary & { documentUrl: string | null; rawText: string }
  awaitingParse: boolean
  lines: ReceiptLine[]
}

export type IngredientCheck = {
  ingredientId: number
  label: string
  itemId: number | null
  itemName: string | null
  verdict: 'have' | 'short' | 'uncertain' | 'missing' | 'untracked'
  detail: string | null
  optional: boolean
}

export type RecipeMatch = {
  recipeId: number
  title: string
  imageUrl: string | null
  verdict: 'cookable' | 'check_shelf' | 'almost' | 'not_tonight'
  missing: string[]
  uncertain: string[]
  untracked: string[]
  usesUp: string[]
  checks: IngredientCheck[]
}

export type Recipe = {
  id: number
  title: string
  sourceType: string
  sourceUrl: string | null
  servings: number | null
  instructions: string[]
  status: string
  imageUrl: string | null
  awaitingParse?: boolean
}

export type RecipeIngredient = {
  id: number
  position: number
  rawText: string
  itemId: number | null
  itemName: string | null
  quantity: number | null
  unit: string | null
  optional: boolean
  resolution: string
}

export type CookLine = {
  id: number
  label: string
  itemId: number | null
  proposedQuantityBase: number | null
  unitFamily: string | null
  action: string | null
}
