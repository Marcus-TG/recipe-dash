import { desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/client.js'
import { cookSessions, llmJobs } from '../db/schema.js'
import {
  confirmCookSession,
  cookSessionDetail,
  startCookSession,
} from '../domain/cook.js'
import { rebuildAllItemState } from '../domain/pantry.js'

export async function cookRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>()

  r.route({
    method: 'POST',
    url: '/cook-sessions',
    schema: {
      description:
        'Start cooking. Creates a session with one line per ingredient, pre-set to "used" ' +
        'so confirming afterwards is one tap. Never blocks on inventory.',
      tags: ['cooking'],
      body: z.object({
        recipeId: z.number(),
        servings: z.number().nullish(),
      }),
    },
    handler: async (req) => startCookSession(req.body.recipeId, req.body.servings),
  })

  r.route({
    method: 'GET',
    url: '/cook-sessions/:id',
    schema: {
      description: 'A cook session with its proposed consumption lines.',
      tags: ['cooking'],
      params: z.object({ id: z.coerce.number() }),
    },
    handler: async (req, reply) => {
      const detail = cookSessionDetail(req.params.id)
      if (!detail) return reply.code(404).send({ message: 'Not found' })
      return detail
    },
  })

  r.route({
    method: 'POST',
    url: '/cook-sessions/:id/confirm',
    schema: {
      description:
        'Confirm what was actually used. "didnt_have" also records that the item is out — ' +
        'a free correction harvested from cooking.',
      tags: ['cooking'],
      params: z.object({ id: z.coerce.number() }),
      body: z.object({
        lines: z.array(
          z.object({
            id: z.number(),
            action: z.enum(['used', 'used_less', 'used_more', 'not_used', 'didnt_have']),
          }),
        ),
      }),
    },
    handler: async (req) => {
      confirmCookSession(req.params.id, req.body.lines)
      return { ok: true }
    },
  })

  r.route({
    method: 'GET',
    url: '/jobs',
    schema: {
      description: 'Background job queue — visibility for debugging parsing.',
      tags: ['system'],
    },
    handler: async () =>
      db.select().from(llmJobs).orderBy(desc(llmJobs.id)).limit(50).all(),
  })

  r.route({
    method: 'GET',
    url: '/cook-sessions',
    schema: { description: 'Recent cook sessions.', tags: ['cooking'] },
    handler: async () =>
      db.select().from(cookSessions).orderBy(desc(cookSessions.id)).limit(50).all(),
  })

  r.route({
    method: 'DELETE',
    url: '/cook-sessions/:id',
    schema: {
      description: 'Abandon a cook session without recording anything.',
      tags: ['cooking'],
      params: z.object({ id: z.coerce.number() }),
    },
    handler: async (req) => {
      db.update(cookSessions)
        .set({ status: 'skipped_confirm' })
        .where(eq(cookSessions.id, req.params.id))
        .run()
      return { ok: true }
    },
  })

  // Kept next to the cook routes so the rebuild is easy to find when the
  // projection looks wrong after a messy session.
  r.route({
    method: 'POST',
    url: '/admin/rebuild',
    schema: { description: 'Alias for /admin/rebuild-state.', tags: ['system'] },
    handler: async () => ({ rebuilt: rebuildAllItemState() }),
  })
}
