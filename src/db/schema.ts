import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Key/value store for app state that isn't domain data: the Paperless poll
// cursor, resolved tag id, feature toggles. Domain tables (items, ledger,
// receipts, ...) arrive in M1/M2 — see PLAN.md.
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
