import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { config } from '../config.js'
import * as schema from './schema.js'

// The server is always started from the project root (npm start / Docker
// WORKDIR), so migrations resolve from cwd.
const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle')

export function openDb(dataDir: string = config.DATA_DIR) {
  fs.mkdirSync(dataDir, { recursive: true })
  const sqlite = new Database(path.join(dataDir, 'app.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  return db
}

export type Db = ReturnType<typeof openDb>
