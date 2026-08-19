import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const now = () => new Date()
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' })

// Key/value: Paperless poll cursor, resolved tag id, misc toggles.
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

// A canonical item is one thing if it's interchangeable in cooking.
// "canned diced tomatoes" != "fresh tomatoes"; brands/pack sizes are aliases.
export const items = sqliteTable('items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  category: text('category').notNull().default('other'),
  unitFamily: text('unit_family').notNull().default('count'),
  shelfLifeDays: integer('shelf_life_days'),
  stalenessHalfLifeDays: integer('staleness_half_life_days')
    .notNull()
    .default(30),
  // Only ever set by a human — enables mass<->volume for this item alone.
  densityGPerMl: real('density_g_per_ml'),
  createdAt: ts('created_at').notNull().$defaultFn(now),
})

// The ledger. APPEND-ONLY: never UPDATE, never DELETE. It is the sole source
// of truth for "why does it think that?".
export const pantryEvents = sqliteTable(
  'pantry_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id),
    // purchase | consume | spoilage | adjust_delta | snapshot
    // snapshot is ABSOLUTE ("about half a bag"), everything else is a delta.
    type: text('type').notNull(),
    quantity: real('quantity'),
    unit: text('unit'),
    quantityBase: real('quantity_base'), // normalized to g / ml / count
    unitFamily: text('unit_family'),
    level: text('level'), // plenty | some | low | out (fuzzy human input)
    occurredAt: ts('occurred_at').notNull().$defaultFn(now),
    recordedAt: ts('recorded_at').notNull().$defaultFn(now),
    sourceType: text('source_type').notNull().default('api'),
    sourceId: integer('source_id'),
    note: text('note'),
  },
  (t) => [index('pantry_events_item_idx').on(t.itemId, t.occurredAt)],
)

// Materialized projection of the ledger. Rebuildable at any time.
export const itemState = sqliteTable('item_state', {
  itemId: integer('item_id')
    .primaryKey()
    .references(() => items.id),
  quantityBaseEstimate: real('quantity_base_estimate'),
  unitFamily: text('unit_family'),
  levelEstimate: text('level_estimate'),
  lastEventAt: ts('last_event_at'),
  lastHumanConfirmedAt: ts('last_human_confirmed_at'),
})

export const stores = sqliteTable('stores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  // Set when a receipt from this store is dismissed as "not groceries" —
  // future receipts from it auto-skip without review or LLM calls.
  nonGrocery: integer('non_grocery', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: ts('created_at').notNull().$defaultFn(now),
})

// The permanent memory. Every human confirmation writes here, and lookups
// happen BEFORE any LLM call.
export const aliases = sqliteTable(
  'aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domain: text('domain').notNull(), // receipt | ingredient
    storeId: integer('store_id').references(() => stores.id),
    rawTextNormalized: text('raw_text_normalized').notNull(),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.id),
    defaultQuantity: real('default_quantity'),
    defaultUnit: text('default_unit'),
    source: text('source').notNull().default('human'), // human beats llm
    hitCount: integer('hit_count').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    createdAt: ts('created_at').notNull().$defaultFn(now),
  },
  (t) => [
    uniqueIndex('aliases_key_idx').on(t.domain, t.storeId, t.rawTextNormalized),
  ],
)

// What a barcode turned out to be. Permanent by nature — a UPC identifies the
// same product forever — so this is a cache with no expiry, and it's what lets
// a second look at the same product cost nothing and work offline.
// Misses are stored too: "not in Open Food Facts" is worth remembering.
export const productCodes = sqliteTable('product_codes', {
  code: text('code').primaryKey(), // the normalized barcode we queried with
  found: integer('found', { mode: 'boolean' }).notNull().default(false),
  name: text('name'),
  brand: text('brand'),
  quantityText: text('quantity_text'), // as printed: "900ml", "398 g"
  quantity: real('quantity'),
  unit: text('unit'),
  category: text('category'),
  source: text('source').notNull().default('openfoodfacts'),
  fetchedAt: ts('fetched_at').notNull().$defaultFn(now),
})

export const receipts = sqliteTable('receipts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  paperlessDocId: integer('paperless_doc_id').unique(), // idempotency key
  storeId: integer('store_id').references(() => stores.id),
  purchasedAt: ts('purchased_at'),
  rawText: text('raw_text').notNull().default(''),
  // pending_parse | needs_review | confirmed | dismissed | parse_failed
  status: text('status').notNull().default('pending_parse'),
  parseMethod: text('parse_method'),
  note: text('note'),
  createdAt: ts('created_at').notNull().$defaultFn(now),
  confirmedAt: ts('confirmed_at'),
})

export const receiptLines = sqliteTable(
  'receipt_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    receiptId: integer('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    rawText: text('raw_text').notNull(),
    itemId: integer('item_id').references(() => items.id),
    proposedName: text('proposed_name'), // LLM's guess before an item exists
    // The product code printed on the line, and what kind it is: upc | plu |
    // sku. Worth more than the text beside it — it survives OCR and outlives
    // the store rewording its abbreviations, so aliases key on it when present.
    code: text('code'),
    codeKind: text('code_kind'),
    // Which department header this line fell under, already mapped to our
    // category vocabulary. Free context for naming, and a category default.
    department: text('department'),
    quantity: real('quantity'),
    unit: text('unit'),
    unitFamily: text('unit_family'),
    resolution: text('resolution').notNull().default('unresolved'),
    status: text('status').notNull().default('proposed'), // proposed|confirmed|ignored
  },
  (t) => [index('receipt_lines_receipt_idx').on(t.receiptId)],
)

export const recipes = sqliteTable('recipes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  sourceType: text('source_type').notNull().default('url'),
  sourceUrl: text('source_url'),
  sourceImagePath: text('source_image_path'),
  servings: integer('servings'),
  instructions: text('instructions', { mode: 'json' })
    .notNull()
    .default(sql`'[]'`)
    .$type<string[]>(),
  rawSource: text('raw_source'),
  status: text('status').notNull().default('needs_review'), // needs_review|active|archived|pending_parse|parse_failed
  imageUrl: text('image_url'), // where it came from
  // Cached copy in DATA_DIR/uploads. Local so thumbnails survive the source
  // site changing, hotlink protection, and having no internet.
  imageFile: text('image_file'),
  createdAt: ts('created_at').notNull().$defaultFn(now),
})

export const recipeIngredients = sqliteTable(
  'recipe_ingredients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    recipeId: integer('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    rawText: text('raw_text').notNull(),
    // Unresolved is a legal permanent state — the recipe stays cookable.
    itemId: integer('item_id').references(() => items.id),
    quantity: real('quantity'),
    unit: text('unit'),
    unitFamily: text('unit_family'),
    optional: integer('optional', { mode: 'boolean' }).notNull().default(false),
    resolution: text('resolution').notNull().default('unresolved'),
  },
  (t) => [index('recipe_ingredients_recipe_idx').on(t.recipeId)],
)

export const cookSessions = sqliteTable('cook_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recipeId: integer('recipe_id')
    .notNull()
    .references(() => recipes.id),
  servings: integer('servings'),
  cookedAt: ts('cooked_at').notNull().$defaultFn(now),
  status: text('status').notNull().default('pending_confirm'),
})

export const cookSessionLines = sqliteTable(
  'cook_session_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => cookSessions.id, { onDelete: 'cascade' }),
    recipeIngredientId: integer('recipe_ingredient_id').references(
      () => recipeIngredients.id,
    ),
    itemId: integer('item_id').references(() => items.id),
    label: text('label').notNull(),
    proposedQuantityBase: real('proposed_quantity_base'),
    unitFamily: text('unit_family'),
    // used | used_less | used_more | not_used | didnt_have
    action: text('action'),
  },
  (t) => [index('cook_session_lines_session_idx').on(t.sessionId)],
)

// Durable job queue: survives restarts, inspectable with plain SQL.
export const llmJobs = sqliteTable(
  'llm_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    payload: text('payload', { mode: 'json' }).notNull().$type<unknown>(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: ts('run_after').notNull().$defaultFn(now),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().$defaultFn(now),
    updatedAt: ts('updated_at').notNull().$defaultFn(now),
  },
  (t) => [index('llm_jobs_status_idx').on(t.status, t.runAfter)],
)

// ---------------------------------------------------------------------------
// Grocery mode
//
// A shopping list is DERIVED, not stored: what you need is (the recipes on the
// list) minus (what the pantry says you have), computed at read time. Storing
// the answer would rot the moment you confirmed a receipt — the same reason
// confidence isn't stored. What IS stored is the small set of things the
// computation can't know: which recipes you put on it, what you added by hand,
// and which rows you've already dropped in the cart.
//
// Ticking a row does NOT write to the pantry ledger. The receipt is what says
// you bought something; a checkbox in a shop is a memory aid. Writing purchase
// events here would double-count against the receipt that follows.
// ---------------------------------------------------------------------------

export const groceryLists = sqliteTable('grocery_lists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().default('Shopping'),
  status: text('status').notNull().default('active'), // active | archived
  createdAt: ts('created_at').notNull().$defaultFn(now),
  completedAt: ts('completed_at'),
})

export const groceryListRecipes = sqliteTable(
  'grocery_list_recipes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listId: integer('list_id')
      .notNull()
      .references(() => groceryLists.id, { onDelete: 'cascade' }),
    recipeId: integer('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    // What you're actually cooking for, which may not be what the recipe says.
    // Ingredient amounts scale by servings / recipe.servings.
    servings: integer('servings'),
    addedAt: ts('added_at').notNull().$defaultFn(now),
  },
  (t) => [
    uniqueIndex('grocery_list_recipes_key_idx').on(t.listId, t.recipeId),
  ],
)

// Two jobs in one table, told apart by `source`:
//   manual  — a row that exists only because you typed it ("paper towels")
//   derived — a row that exists only to carry the checkbox for a computed
//             need. It is never displayed on its own; if the recipes stop
//             asking for it, it simply stops being consulted, which is why
//             removing a recipe leaves no orphans to clean up.
// `key` is what joins a decision to its computed need: "item:12" when the
// ingredient resolved to a pantry item, "text:canned tomatoes" when it didn't.
export const groceryListLines = sqliteTable(
  'grocery_list_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    listId: integer('list_id')
      .notNull()
      .references(() => groceryLists.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    itemId: integer('item_id').references(() => items.id),
    quantity: real('quantity'),
    unit: text('unit'),
    source: text('source').notNull().default('manual'), // manual | derived
    checked: integer('checked', { mode: 'boolean' }).notNull().default(false),
    dismissed: integer('dismissed', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: ts('created_at').notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex('grocery_list_lines_key_idx').on(t.listId, t.key)],
)
