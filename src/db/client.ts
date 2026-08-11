import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { config } from '../config.js'
import * as schema from './schema.js'

const MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle')

fs.mkdirSync(config.DATA_DIR, { recursive: true })
const sqlite = new Database(path.join(config.DATA_DIR, 'app.db'))
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })
migrate(db, { migrationsFolder: MIGRATIONS_DIR })

export type Db = typeof db
