import { asc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/client.js'
import { itemState, items, pantryEvents, receiptLines, receipts } from '../db/schema.js'
import {
  appendEvents,
  buildItemView,
  CATEGORY_DEFAULTS,
  itemLedger,
  rebuildAllItemState,
} from '../domain/pantry.js'
import { toBase } from '../domain/units.js'
import { normalizeItemName } from '../domain/text.js'

const ItemView = z.object({
  id: z.number(),
  name: z.string(),
  category: z.string(),
  unitFamily: z.string(),
  level: z.string(),
  levelLabel: z.string(),
  quantityBase: z.number().nullable(),
  quantityLabel: z.string(),
  stale: z.boolean(),
  ageDays: z.number().nullable(),
  lastConfirmedLabel: z.string().nullable(),
  useBySoon: z.boolean(),
})

export async function itemRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>()

  r.route({
    method: 'GET',
    url: '/items',
    schema: {
      description:
        'Everything in the pantry with an honest level. Levels are words, not fake numbers.',
      tags: ['pantry'],
      response: { 200: z.array(ItemView) },
    },
    handler: async () => {
      const all = db.select().from(items).orderBy(asc(items.name)).all()
      const states = new Map(
        db
          .select()
          .from(itemState)
          .all()
          .map((s) => [s.itemId, s]),
      )
      return all.map((i) => buildItemView(i, states.get(i.id)))
    },
  })

  r.route({
    method: 'POST',
    url: '/items',
    schema: {
      description: 'Create a canonical item.',
      tags: ['pantry'],
      body: z.object({
        name: z.string().min(1),
        category: z.string().default('other'),
        unitFamily: z.enum(['mass', 'volume', 'count']).default('count'),
        densityGPerMl: z.number().nullish(),
      }),
    },
    handler: async (req) => {
      const b = req.body
      const defaults = CATEGORY_DEFAULTS[b.category] ?? CATEGORY_DEFAULTS.other!
      return db
        .insert(items)
        .values({
          name: normalizeItemName(b.name) || b.name,
          category: b.category,
          unitFamily: b.unitFamily,
          densityGPerMl: b.densityGPerMl ?? null,
          shelfLifeDays: defaults.shelfLifeDays,
          stalenessHalfLifeDays: defaults.stalenessHalfLifeDays,
        })
        .returning()
        .get()
    },
  })

  r.route({
    method: 'GET',
    url: '/items/:id',
    schema: {
      description:
        'One item plus its full ledger — this is the "why does it think that?" view.',
      tags: ['pantry'],
      params: z.object({ id: z.coerce.number() }),
    },
    handler: async (req, reply) => {
      const item = db.select().from(items).where(eq(items.id, req.params.id)).get()
      if (!item) return reply.code(404).send({ message: 'Not found' })
      const state = db
        .select()
        .from(itemState)
        .where(eq(itemState.itemId, item.id))
        .get()
      const ledger = itemLedger(item.id).map((e) => {
        // Trace every event back to its cause.
        let source: { kind: string; label: string; receiptId?: number } | null = null
        if (e.sourceType === 'receipt_line' && e.sourceId) {
          const line = db
            .select()
            .from(receiptLines)
            .where(eq(receiptLines.id, e.sourceId))
            .get()
          if (line) {
            const receipt = db
              .select()
              .from(receipts)
              .where(eq(receipts.id, line.receiptId))
              .get()
            source = {
              kind: 'receipt',
              label: line.rawText,
              receiptId: receipt?.id,
            }
          }
        }
        return { ...e, source }
      })
      return { item, view: buildItemView(item, state), ledger }
    },
  })

  r.route({
    method: 'POST',
    url: '/items/:id/events',
    schema: {
      description:
        'Append to the ledger. type=snapshot is an absolute statement about the shelf ' +
        '("about half a bag"); everything else is a delta. This is n8n\'s entry point.',
      tags: ['pantry'],
      params: z.object({ id: z.coerce.number() }),
      body: z.object({
        type: z.enum(['purchase', 'consume', 'spoilage', 'adjust_delta', 'snapshot']),
        quantity: z.number().nullish(),
        unit: z.string().nullish(),
        level: z.enum(['plenty', 'some', 'low', 'out']).nullish(),
        note: z.string().nullish(),
      }),
    },
    handler: async (req, reply) => {
      const item = db.select().from(items).where(eq(items.id, req.params.id)).get()
      if (!item) return reply.code(404).send({ message: 'Not found' })
      const b = req.body
      const base = toBase(b.quantity, b.unit)
      appendEvents([
        {
          itemId: item.id,
          type: b.type,
          quantity: b.quantity ?? null,
          unit: b.unit ?? null,
          quantityBase: base?.quantityBase ?? null,
          unitFamily: base?.family ?? null,
          level: b.level ?? null,
          note: b.note ?? null,
          sourceType: 'api',
        },
      ])
      const state = db
        .select()
        .from(itemState)
        .where(eq(itemState.itemId, item.id))
        .get()
      return buildItemView(item, state)
    },
  })

  r.route({
    method: 'DELETE',
    url: '/items/:id',
    schema: {
      description: 'Remove an item and its ledger entirely (for cleaning up mistakes).',
      tags: ['pantry'],
      params: z.object({ id: z.coerce.number() }),
    },
    handler: async (req) => {
      db.transaction(() => {
        db.delete(pantryEvents).where(eq(pantryEvents.itemId, req.params.id)).run()
        db.delete(itemState).where(eq(itemState.itemId, req.params.id)).run()
        db.delete(items).where(eq(items.id, req.params.id)).run()
      })
      return { ok: true }
    },
  })

  r.route({
    method: 'POST',
    url: '/admin/rebuild-state',
    schema: {
      description:
        'Rebuild the item_state projection from the ledger. The ledger is the only truth; ' +
        'if the projection ever looks wrong, this fixes it.',
      tags: ['system'],
    },
    handler: async () => ({ rebuilt: rebuildAllItemState() }),
  })
}
