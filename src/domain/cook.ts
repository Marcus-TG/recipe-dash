import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  cookSessionLines,
  cookSessions,
  recipeIngredients,
  recipes,
} from '../db/schema.js'
import { appendEvents, type NewEvent } from './pantry.js'
import { toBase } from './units.js'

export function startCookSession(recipeId: number, servings?: number | null) {
  const recipe = db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
  if (!recipe) throw new Error('recipe not found')
  const ings = db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .orderBy(asc(recipeIngredients.position))
    .all()

  const scale =
    servings && recipe.servings ? servings / recipe.servings : 1

  const session = db
    .insert(cookSessions)
    .values({ recipeId, servings: servings ?? recipe.servings ?? null })
    .returning()
    .get()

  for (const ing of ings) {
    const base = toBase(ing.quantity, ing.unit)
    db.insert(cookSessionLines)
      .values({
        sessionId: session.id,
        recipeIngredientId: ing.id,
        itemId: ing.itemId,
        label: ing.rawText,
        proposedQuantityBase: base ? base.quantityBase * scale : null,
        unitFamily: base?.family ?? null,
        action: ing.itemId ? 'used' : 'not_used', // default fast path
      })
      .run()
  }
  return session
}

export type CookDecision = {
  id: number
  action: 'used' | 'used_less' | 'used_more' | 'not_used' | 'didnt_have'
}

/**
 * Confirming writes consume events. "didn't have" also writes an absolute
 * snapshot(out) — a free drift correction harvested from cooking.
 * Skipping entirely is fine: it degrades confidence, it never corrupts.
 */
export function confirmCookSession(sessionId: number, decisions: CookDecision[]) {
  const session = db
    .select()
    .from(cookSessions)
    .where(eq(cookSessions.id, sessionId))
    .get()
  if (!session) throw new Error('cook session not found')
  const lines = db
    .select()
    .from(cookSessionLines)
    .where(eq(cookSessionLines.sessionId, sessionId))
    .all()
  const byId = new Map(lines.map((l) => [l.id, l]))
  const now = new Date()

  db.transaction(() => {
    const events: NewEvent[] = []
    for (const decision of decisions) {
      const line = byId.get(decision.id)
      if (!line) continue
      db.update(cookSessionLines)
        .set({ action: decision.action })
        .where(eq(cookSessionLines.id, line.id))
        .run()
      if (!line.itemId || decision.action === 'not_used') continue

      if (decision.action === 'didnt_have') {
        events.push({
          itemId: line.itemId,
          type: 'snapshot',
          level: 'out',
          quantityBase: 0,
          unitFamily: line.unitFamily,
          occurredAt: now,
          sourceType: 'cook_line',
          sourceId: line.id,
          note: 'ran out — noticed while cooking',
        })
        continue
      }

      const factor =
        decision.action === 'used_less' ? 0.5 : decision.action === 'used_more' ? 1.5 : 1
      events.push({
        itemId: line.itemId,
        type: 'consume',
        quantityBase:
          line.proposedQuantityBase != null
            ? line.proposedQuantityBase * factor
            : null,
        unitFamily: line.unitFamily,
        occurredAt: now,
        sourceType: 'cook_line',
        sourceId: line.id,
      })
    }
    appendEvents(events, now)
    db.update(cookSessions)
      .set({ status: 'confirmed' })
      .where(eq(cookSessions.id, sessionId))
      .run()
  })
}

export function cookSessionDetail(sessionId: number) {
  const session = db
    .select()
    .from(cookSessions)
    .where(eq(cookSessions.id, sessionId))
    .get()
  if (!session) return null
  const recipe = db
    .select()
    .from(recipes)
    .where(eq(recipes.id, session.recipeId))
    .get()
  const lines = db
    .select()
    .from(cookSessionLines)
    .where(eq(cookSessionLines.sessionId, sessionId))
    .all()
  return { session, recipe, lines }
}
