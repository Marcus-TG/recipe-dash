import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { llmJobs } from '../db/schema.js'
import { LlmUnavailableError } from './ollama.js'

export type JobKind =
  | 'parse_receipt_lines'
  | 'parse_recipe_url'
  | 'parse_recipe_photo'
  | 'parse_recipe_text'
  | 'resolve_ingredients'

type Handler = (payload: any) => Promise<void>

/** Retrying won't help (bad URL, unreadable file) — fail immediately. */
export class PermanentJobError extends Error {}

const handlers = new Map<string, Handler>()

export function registerHandler(kind: JobKind, fn: Handler) {
  handlers.set(kind, fn)
}

export function enqueue(kind: JobKind, payload: unknown) {
  return db
    .insert(llmJobs)
    .values({ kind, payload, status: 'queued' })
    .returning()
    .get()
}

const MAX_ATTEMPTS = 6

/**
 * Drains one job at a time — forte is a shared box, so we're a polite
 * neighbour. "forte is asleep" requeues with backoff instead of burning an
 * attempt, so nothing is ever lost.
 */
export async function runDueJobs(now = new Date()) {
  const job = db
    .select()
    .from(llmJobs)
    .where(and(eq(llmJobs.status, 'queued'), lte(llmJobs.runAfter, now)))
    .orderBy(asc(llmJobs.runAfter), asc(llmJobs.id))
    .get()
  if (!job) return false

  const handler = handlers.get(job.kind)
  if (!handler) {
    db.update(llmJobs)
      .set({ status: 'dead', lastError: `no handler for ${job.kind}` })
      .where(eq(llmJobs.id, job.id))
      .run()
    return true
  }

  db.update(llmJobs)
    .set({ status: 'running', updatedAt: new Date() })
    .where(eq(llmJobs.id, job.id))
    .run()

  try {
    await handler(job.payload)
    db.update(llmJobs)
      .set({ status: 'done', updatedAt: new Date() })
      .where(eq(llmJobs.id, job.id))
      .run()
  } catch (err) {
    const offline = err instanceof LlmUnavailableError
    const attempts = offline ? job.attempts : job.attempts + 1
    const dead = err instanceof PermanentJobError || attempts >= MAX_ATTEMPTS
    // Offline: retry in a minute, forever. Real errors: exponential backoff.
    const delayMs = offline
      ? 60_000
      : Math.min(60_000 * 2 ** attempts, 3_600_000)
    db.update(llmJobs)
      .set({
        status: dead ? 'dead' : 'queued',
        attempts,
        lastError: String(err instanceof Error ? err.message : err),
        runAfter: new Date(Date.now() + delayMs),
        updatedAt: new Date(),
      })
      .where(eq(llmJobs.id, job.id))
      .run()
  }
  return true
}

export function startJobRunner(intervalMs = 5000) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      // Drain up to a few jobs per tick, then yield.
      for (let i = 0; i < 3; i++) if (!(await runDueJobs())) break
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return timer
}
