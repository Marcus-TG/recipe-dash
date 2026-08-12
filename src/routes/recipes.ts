import { asc, desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/client.js'
import {
  cookSessionLines,
  cookSessions,
  items,
  llmJobs,
  recipeIngredients,
  recipes,
} from '../db/schema.js'
import { matchRecipes } from '../domain/matching.js'
import { findOrCreateItem, upsertAlias } from '../domain/resolve.js'
import { normalizeItemName } from '../domain/text.js'
import {
  applyRecipeRevision,
  chatAboutRecipe,
  importRecipeFromPhoto,
  importRecipeFromText,
  importRecipeFromUrl,
} from '../pipelines/recipes.js'
import { LlmUnavailableError } from '../services/ollama.js'
import { enqueue } from '../services/jobs.js'

export async function recipeRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>()

  r.route({
    method: 'GET',
    url: '/recipes/cookable',
    schema: {
      description:
        'What you can cook tonight. Presence gates, quantity refines, uncertainty is ' +
        'shown rather than guessed. Sorted so soon-to-spoil ingredients float up.',
      tags: ['recipes'],
    },
    handler: async () => matchRecipes(),
  })

  r.route({
    method: 'POST',
    url: '/admin/fetch-thumbnails',
    schema: {
      description:
        'Queue thumbnail downloads for any recipe that has a picture but no cached copy ' +
        '(backfill for recipes imported before thumbnails existed).',
      tags: ['system'],
    },
    handler: async () => {
      const missing = db
        .select()
        .from(recipes)
        .all()
        .filter((rec) => rec.imageUrl && !rec.imageFile)
      for (const rec of missing) enqueue('fetch_recipe_image', { recipeId: rec.id })
      return { queued: missing.length }
    },
  })

  r.route({
    method: 'GET',
    url: '/recipes',
    schema: { description: 'All recipes.', tags: ['recipes'] },
    handler: async () => {
      const rows = db.select().from(recipes).orderBy(desc(recipes.createdAt)).all()
      const queued = db.select().from(llmJobs).where(eq(llmJobs.status, 'queued')).all()
      return rows.map((rec) => ({
        ...rec,
        thumbnail: rec.imageFile ? `/uploads/${rec.imageFile}` : null,
        awaitingParse:
          rec.status === 'pending_parse' &&
          queued.some((j) => (j.payload as any)?.recipeId === rec.id),
      }))
    },
  })

  r.route({
    method: 'GET',
    url: '/recipes/:id',
    schema: {
      description: 'A recipe with its ingredients and how each one resolved.',
      tags: ['recipes'],
      params: z.object({ id: z.coerce.number() }),
    },
    handler: async (req, reply) => {
      const recipe = db.select().from(recipes).where(eq(recipes.id, req.params.id)).get()
      if (!recipe) return reply.code(404).send({ message: 'Not found' })
      const ings = db
        .select()
        .from(recipeIngredients)
        .where(eq(recipeIngredients.recipeId, recipe.id))
        .orderBy(asc(recipeIngredients.position))
        .all()
      const itemById = new Map(db.select().from(items).all().map((i) => [i.id, i]))
      const match = matchRecipes().find((m) => m.recipeId === recipe.id) ?? null
      return {
        recipe: {
          ...recipe,
          thumbnail: recipe.imageFile ? `/uploads/${recipe.imageFile}` : null,
        },
        match,
        ingredients: ings.map((i) => ({
          ...i,
          itemName: i.itemId ? (itemById.get(i.itemId)?.name ?? null) : null,
        })),
      }
    },
  })

  r.route({
    method: 'POST',
    url: '/recipes/import-url',
    schema: {
      description:
        'Import from a URL. Structured recipe data is used when the site has it; ' +
        'otherwise the model reads the page. Returns immediately — parsing is queued.',
      tags: ['recipes'],
      body: z.object({ url: z.string().url() }),
    },
    handler: async (req) => importRecipeFromUrl(req.body.url),
  })

  r.route({
    method: 'POST',
    url: '/recipes/import-text',
    schema: {
      description:
        'Import from pasted text — for sites that block scraping. The model strips the ' +
        'blog story, ads and padding and keeps just the recipe.',
      tags: ['recipes'],
      body: z.object({
        text: z.string().min(20),
        sourceUrl: z.string().nullish(),
      }),
    },
    handler: async (req) =>
      importRecipeFromText(req.body.text, req.body.sourceUrl),
  })

  r.route({
    method: 'POST',
    url: '/recipes/:id/chat',
    schema: {
      description:
        'Ask about substitutions, scaling or technique. Answers use your pantry for ' +
        'context, and may come back with a complete revised recipe you can apply.',
      tags: ['recipes'],
      params: z.object({ id: z.coerce.number() }),
      body: z.object({
        message: z.string().min(1),
        history: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string(),
            }),
          )
          .default([]),
      }),
    },
    handler: async (req, reply) => {
      try {
        return await chatAboutRecipe(
          req.params.id,
          req.body.message,
          req.body.history,
        )
      } catch (err) {
        if (err instanceof LlmUnavailableError) {
          return reply.code(503).send({
            message: 'forte is not answering right now — try again when it is awake.',
          })
        }
        throw err
      }
    },
  })

  r.route({
    method: 'POST',
    url: '/recipes/:id/revise',
    schema: {
      description:
        'Apply a revision (usually one the chat proposed). Ingredients are re-matched ' +
        'to the pantry afterwards.',
      tags: ['recipes'],
      params: z.object({ id: z.coerce.number() }),
      body: z.object({
        title: z.string(),
        servings: z.number().nullish(),
        ingredients: z.array(z.string()).min(1),
        instructions: z.array(z.string()),
      }),
    },
    handler: async (req) => {
      applyRecipeRevision(req.params.id, {
        title: req.body.title,
        servings: req.body.servings ?? null,
        ingredients: req.body.ingredients,
        instructions: req.body.instructions,
      })
      return { ok: true }
    },
  })

  r.route({
    method: 'POST',
    url: '/recipes/import-photo',
    schema: {
      description:
        'Import from a photo or screenshot (multipart, field name "file"). Needs forte; ' +
        'queues politely if it is offline.',
      tags: ['recipes'],
      consumes: ['multipart/form-data'],
    },
    handler: async (req, reply) => {
      const file = await (req as any).file()
      if (!file) return reply.code(400).send({ message: 'no file uploaded' })
      const buffer = await file.toBuffer()
      return importRecipeFromPhoto(buffer, file.filename ?? 'photo.jpg')
    },
  })

  r.route({
    method: 'PATCH',
    url: '/recipes/:id',
    schema: {
      description: 'Edit a recipe (title, servings, status).',
      tags: ['recipes'],
      params: z.object({ id: z.coerce.number() }),
      body: z.object({
        title: z.string().optional(),
        servings: z.number().nullish(),
        status: z.enum(['needs_review', 'active', 'archived']).optional(),
      }),
    },
    handler: async (req) => {
      db.update(recipes).set(req.body).where(eq(recipes.id, req.params.id)).run()
      return db.select().from(recipes).where(eq(recipes.id, req.params.id)).get()
    },
  })

  r.route({
    method: 'PATCH',
    url: '/recipes/:recipeId/ingredients/:id',
    schema: {
      description:
        'Point an ingredient line at a pantry item. The correction is remembered, so the ' +
        'same wording resolves itself next time.',
      tags: ['recipes'],
      params: z.object({ recipeId: z.coerce.number(), id: z.coerce.number() }),
      body: z.object({
        itemId: z.number().nullish(),
        itemName: z.string().nullish(),
        optional: z.boolean().optional(),
      }),
    },
    handler: async (req, reply) => {
      const ing = db
        .select()
        .from(recipeIngredients)
        .where(eq(recipeIngredients.id, req.params.id))
        .get()
      if (!ing) return reply.code(404).send({ message: 'Not found' })

      let itemId = req.body.itemId ?? null
      if (!itemId && req.body.itemName) {
        itemId = findOrCreateItem(req.body.itemName).id
      }
      if (itemId) {
        upsertAlias({
          domain: 'ingredient',
          rawTextNormalized: normalizeItemName(ing.rawText),
          storeId: null,
          itemId,
          source: 'human',
        })
      }
      db.update(recipeIngredients)
        .set({
          itemId,
          optional: req.body.optional ?? ing.optional,
          resolution: itemId ? 'human' : 'unresolved',
        })
        .where(eq(recipeIngredients.id, ing.id))
        .run()
      return { ok: true }
    },
  })

  r.route({
    method: 'DELETE',
    url: '/recipes/:id',
    schema: {
      description:
        'Delete a recipe and its cook history. Pantry events stay — what you actually ' +
        'used is a fact about the pantry, not about the recipe.',
      tags: ['recipes'],
      params: z.object({ id: z.coerce.number() }),
    },
    handler: async (req, reply) => {
      const recipe = db
        .select()
        .from(recipes)
        .where(eq(recipes.id, req.params.id))
        .get()
      if (!recipe) return reply.code(404).send({ message: 'Not found' })

      // Cook sessions reference the recipe, so they have to go first —
      // their lines cascade with them, which in turn frees the ingredient
      // rows the recipe itself cascades.
      db.transaction(() => {
        const sessions = db
          .select({ id: cookSessions.id })
          .from(cookSessions)
          .where(eq(cookSessions.recipeId, recipe.id))
          .all()
        for (const s of sessions) {
          db.delete(cookSessionLines)
            .where(eq(cookSessionLines.sessionId, s.id))
            .run()
        }
        db.delete(cookSessions).where(eq(cookSessions.recipeId, recipe.id)).run()
        db.delete(recipeIngredients)
          .where(eq(recipeIngredients.recipeId, recipe.id))
          .run()
        db.delete(recipes).where(eq(recipes.id, recipe.id)).run()
      })
      return { ok: true }
    },
  })
}
