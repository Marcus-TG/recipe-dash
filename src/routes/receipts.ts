import { desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/client.js'
import { items, llmJobs, receiptLines, receipts, stores } from '../db/schema.js'
import {
  confirmReceipt,
  createManualReceipt,
  dismissReceipt,
  parseReceiptDeterministic,
  pollPaperless,
} from '../pipelines/receipts.js'
import { documentUrl } from '../services/paperless.js'

export async function receiptRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>()

  r.route({
    method: 'GET',
    url: '/receipts',
    schema: {
      description: 'Receipts, newest first. Default view is what needs confirming.',
      tags: ['receipts'],
      querystring: z.object({ status: z.string().optional() }),
    },
    handler: async (req) => {
      const rows = req.query.status
        ? db
            .select()
            .from(receipts)
            .where(eq(receipts.status, req.query.status))
            .orderBy(desc(receipts.purchasedAt))
            .all()
        : db.select().from(receipts).orderBy(desc(receipts.purchasedAt)).all()
      const storeById = new Map(db.select().from(stores).all().map((s) => [s.id, s]))
      const lineCounts = new Map<number, number>()
      if (rows.length) {
        for (const l of db
          .select()
          .from(receiptLines)
          .where(inArray(receiptLines.receiptId, rows.map((x) => x.id)))
          .all()) {
          lineCounts.set(l.receiptId, (lineCounts.get(l.receiptId) ?? 0) + 1)
        }
      }
      return rows.map((rec) => ({
        ...rec,
        storeName: rec.storeId ? (storeById.get(rec.storeId)?.name ?? null) : null,
        lineCount: lineCounts.get(rec.id) ?? 0,
      }))
    },
  })

  r.route({
    method: 'POST',
    url: '/receipts',
    schema: {
      description:
        'Add a receipt that is not in Paperless by pasting its text — same parsing, ' +
        'same learning loop.',
      tags: ['receipts'],
      body: z.object({
        rawText: z.string().min(1),
        storeName: z.string().nullish(),
        purchasedAt: z.coerce.date().nullish(),
      }),
    },
    handler: async (req) =>
      createManualReceipt({
        rawText: req.body.rawText,
        storeName: req.body.storeName,
        purchasedAt: req.body.purchasedAt,
      }),
  })

  r.route({
    method: 'GET',
    url: '/receipts/:id',
    schema: {
      description: 'A receipt with its proposed lines, ready to confirm.',
      tags: ['receipts'],
      params: z.object({ id: z.coerce.number() }),
    },
    handler: async (req, reply) => {
      const receipt = db.select().from(receipts).where(eq(receipts.id, req.params.id)).get()
      if (!receipt) return reply.code(404).send({ message: 'Not found' })
      const lines = db
        .select()
        .from(receiptLines)
        .where(eq(receiptLines.receiptId, receipt.id))
        .all()
      const store = receipt.storeId
        ? db.select().from(stores).where(eq(stores.id, receipt.storeId)).get()
        : null
      const itemById = new Map(db.select().from(items).all().map((i) => [i.id, i]))
      const pendingJob = db
        .select()
        .from(llmJobs)
        .where(eq(llmJobs.status, 'queued'))
        .all()
        .some((j) => (j.payload as any)?.receiptId === receipt.id)

      return {
        receipt: {
          ...receipt,
          storeName: store?.name ?? null,
          documentUrl: receipt.paperlessDocId ? documentUrl(receipt.paperlessDocId) : null,
        },
        awaitingParse: pendingJob,
        lines: lines.map((l) => ({
          ...l,
          itemName: l.itemId ? (itemById.get(l.itemId)?.name ?? null) : null,
          suggestion: l.itemId
            ? (itemById.get(l.itemId)?.name ?? null)
            : (l.proposedName ?? null),
        })),
      }
    },
  })

  r.route({
    method: 'POST',
    url: '/receipts/:id/confirm',
    schema: {
      description:
        'Confirm a receipt: writes purchase events AND teaches the alias table, so the ' +
        'same store text resolves instantly next time.',
      tags: ['receipts'],
      params: z.object({ id: z.coerce.number() }),
      body: z.object({
        lines: z.array(
          z.object({
            id: z.number(),
            action: z.enum(['confirm', 'ignore']),
            itemId: z.number().nullish(),
            name: z.string().nullish(),
            quantity: z.number().nullish(),
            unit: z.string().nullish(),
            category: z.string().nullish(),
          }),
        ),
      }),
    },
    handler: async (req) => {
      confirmReceipt(req.params.id, req.body.lines)
      return { ok: true }
    },
  })

  r.route({
    method: 'POST',
    url: '/receipts/:id/dismiss',
    schema: {
      description:
        'Not groceries. Optionally remember that for the whole store, so future receipts ' +
        'from it skip review automatically.',
      tags: ['receipts'],
      params: z.object({ id: z.coerce.number() }),
      body: z.object({ markStoreNonGrocery: z.boolean().default(false) }),
    },
    handler: async (req) => {
      dismissReceipt(req.params.id, req.body.markStoreNonGrocery)
      return { ok: true }
    },
  })

  r.route({
    method: 'POST',
    url: '/receipts/:id/reparse',
    schema: {
      description: 'Re-run parsing for a receipt (aliases first, then the model).',
      tags: ['receipts'],
      params: z.object({ id: z.coerce.number() }),
    },
    handler: async (req) => {
      parseReceiptDeterministic(req.params.id)
      return { ok: true }
    },
  })

  r.route({
    method: 'POST',
    url: '/receipts/poll',
    schema: {
      description:
        'Check Paperless for new receipt-tagged documents now (the poller also runs every 3 minutes).',
      tags: ['receipts'],
    },
    handler: async (_req, reply) => {
      try {
        return { ingested: await pollPaperless() }
      } catch (err) {
        return reply.code(502).send({ message: String(err) })
      }
    },
  })

  r.route({
    method: 'POST',
    url: '/webhooks/paperless',
    schema: {
      description:
        'Optional push endpoint for Paperless/n8n — same idempotent path as the poller.',
      tags: ['receipts'],
      body: z.object({}).loose(),
    },
    handler: async () => ({ ingested: await pollPaperless() }),
  })
}
