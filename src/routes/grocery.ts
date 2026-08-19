import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/client.js'
import {
  groceryListLines,
  groceryListRecipes,
  groceryLists,
  recipes,
} from '../db/schema.js'
import { activeList, buildGroceryList } from '../domain/grocery.js'
import { findItemByName } from '../domain/resolve.js'
import { normalizeItemName } from '../domain/text.js'

export async function groceryRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>()

  r.route({
    method: 'GET',
    url: '/grocery/list',
    schema: {
      description:
        'The open shopping list: every recipe on it, netted against the pantry and ' +
        'laid out in the order you walk a shop. Computed fresh on every read, so ' +
        'confirming a receipt updates it. Creates the list if there is not one yet.',
      tags: ['grocery'],
    },
    handler: async () => buildGroceryList(),
  })

  r.route({
    method: 'POST',
    url: '/grocery/list/recipes',
    schema: {
      description:
        'Put a recipe on the list. Adding a second recipe merges the two shopping ' +
        'needs rather than listing them twice — and the merge is what decides whether ' +
        'you have enough, so two recipes wanting half a block of butter each ask for a ' +
        'whole one.',
      tags: ['grocery'],
      body: z.object({
        recipeId: z.number(),
        servings: z.number().int().positive().nullish(),
      }),
    },
    handler: async (req, reply) => {
      const recipe = db
        .select()
        .from(recipes)
        .where(eq(recipes.id, req.body.recipeId))
        .get()
      if (!recipe) return reply.code(404).send({ message: 'Recipe not found' })
      const list = activeList()
      const insert = db.insert(groceryListRecipes).values({
        listId: list.id,
        recipeId: recipe.id,
        servings: req.body.servings ?? null,
      })
      // Adding a recipe that's already on the list is a no-op, not a reset:
      // tapping "add to shopping list" a second time must not quietly undo the
      // servings you set. Only an explicit servings value overwrites one.
      if (req.body.servings != null) {
        insert
          .onConflictDoUpdate({
            target: [groceryListRecipes.listId, groceryListRecipes.recipeId],
            set: { servings: req.body.servings },
          })
          .run()
      } else {
        insert.onConflictDoNothing().run()
      }
      return buildGroceryList()
    },
  })

  r.route({
    method: 'PATCH',
    url: '/grocery/list/recipes/:recipeId',
    schema: {
      description:
        'Change how many servings you are cooking. Ingredient amounts scale with it.',
      tags: ['grocery'],
      params: z.object({ recipeId: z.coerce.number() }),
      body: z.object({ servings: z.number().int().positive().nullish() }),
    },
    handler: async (req) => {
      const list = activeList()
      db.update(groceryListRecipes)
        .set({ servings: req.body.servings ?? null })
        .where(
          and(
            eq(groceryListRecipes.listId, list.id),
            eq(groceryListRecipes.recipeId, req.params.recipeId),
          ),
        )
        .run()
      return buildGroceryList()
    },
  })

  r.route({
    method: 'DELETE',
    url: '/grocery/list/recipes/:recipeId',
    schema: {
      description:
        'Take a recipe off the list. Anything only it wanted disappears with it; ' +
        'anything another recipe also wanted stays, re-totalled.',
      tags: ['grocery'],
      params: z.object({ recipeId: z.coerce.number() }),
    },
    handler: async (req) => {
      const list = activeList()
      db.delete(groceryListRecipes)
        .where(
          and(
            eq(groceryListRecipes.listId, list.id),
            eq(groceryListRecipes.recipeId, req.params.recipeId),
          ),
        )
        .run()
      return buildGroceryList()
    },
  })

  r.route({
    method: 'POST',
    url: '/grocery/list/lines',
    schema: {
      description:
        'Add something by hand — the milk and paper towels no recipe asked for.',
      tags: ['grocery'],
      body: z.object({
        label: z.string().min(1),
        quantity: z.number().nullish(),
        unit: z.string().nullish(),
      }),
    },
    handler: async (req) => {
      const list = activeList()
      const label = req.body.label.trim()
      const item = findItemByName(label)
      // Manual rows key the same way derived ones do, so typing "onions" for a
      // recipe that already wants onions lands on the existing row instead of
      // producing two lines for one vegetable.
      const key = item
        ? `item:${item.id}`
        : `text:${normalizeItemName(label)}`
      db.insert(groceryListLines)
        .values({
          listId: list.id,
          key,
          label,
          itemId: item?.id ?? null,
          quantity: req.body.quantity ?? null,
          unit: req.body.unit?.trim() || null,
          source: 'manual',
        })
        .onConflictDoUpdate({
          target: [groceryListLines.listId, groceryListLines.key],
          set: {
            label,
            quantity: req.body.quantity ?? null,
            unit: req.body.unit?.trim() || null,
            dismissed: false,
          },
        })
        .run()
      return buildGroceryList()
    },
  })

  r.route({
    method: 'PATCH',
    url: '/grocery/list/lines',
    schema: {
      description:
        'Tick a row into the cart, or drop it from the list. Neither touches the ' +
        'pantry ledger: the receipt is what says you bought something, and writing ' +
        'purchases here would double-count against it.',
      tags: ['grocery'],
      body: z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        checked: z.boolean().optional(),
        dismissed: z.boolean().optional(),
      }),
    },
    handler: async (req) => {
      const list = activeList()
      const b = req.body
      const existing = db
        .select()
        .from(groceryListLines)
        .where(
          and(
            eq(groceryListLines.listId, list.id),
            eq(groceryListLines.key, b.key),
          ),
        )
        .get()

      // A derived row has no stored existence until you make a decision about
      // it, so the first tick is what brings it into being.
      if (!existing) {
        db.insert(groceryListLines)
          .values({
            listId: list.id,
            key: b.key,
            label: b.label,
            itemId: b.key.startsWith('item:')
              ? Number(b.key.slice(5))
              : null,
            source: 'derived',
            checked: b.checked ?? false,
            dismissed: b.dismissed ?? false,
          })
          .run()
      } else {
        db.update(groceryListLines)
          .set({
            ...(b.checked !== undefined ? { checked: b.checked } : {}),
            ...(b.dismissed !== undefined ? { dismissed: b.dismissed } : {}),
          })
          .where(eq(groceryListLines.id, existing.id))
          .run()
      }
      return buildGroceryList()
    },
  })

  r.route({
    method: 'POST',
    url: '/grocery/list/complete',
    schema: {
      description:
        'Done shopping. Archives the list and opens an empty one. The pantry is not ' +
        'touched — the receipt does that, and it knows what you actually bought.',
      tags: ['grocery'],
    },
    handler: async () => {
      const list = activeList()
      db.update(groceryLists)
        .set({ status: 'archived', completedAt: new Date() })
        .where(eq(groceryLists.id, list.id))
        .run()
      return buildGroceryList()
    },
  })

  r.route({
    method: 'POST',
    url: '/grocery/list/uncheck',
    schema: {
      description: 'Put everything back on the list (undo a shopping trip).',
      tags: ['grocery'],
    },
    handler: async () => {
      const list = activeList()
      db.update(groceryListLines)
        .set({ checked: false })
        .where(eq(groceryListLines.listId, list.id))
        .run()
      return buildGroceryList()
    },
  })
}
