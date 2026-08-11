import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { items, recipeIngredients, recipes } from '../db/schema.js'
import { resolveIngredientName, upsertAlias } from '../domain/resolve.js'
import { normalizeItemName, parseIngredientLine } from '../domain/text.js'
import { enqueue, PermanentJobError, registerHandler } from '../services/jobs.js'
import { structured } from '../services/ollama.js'

// ---------- shared shape ----------

type ExtractedRecipe = {
  title: string
  servings: number | null
  ingredients: string[]
  instructions: string[]
  imageUrl?: string | null
}

/**
 * Last rung of the resolution ladder: ask the model which EXISTING pantry item
 * an ingredient refers to. It may never invent items — worst case a line stays
 * unresolved, which is a legal state.
 */
const IngredientMatches = z.object({
  matches: z.array(
    z.object({
      index: z.number().describe('the number shown before the ingredient'),
      pantry_item: z
        .string()
        .describe('exact name from the pantry list, or empty string if none fit'),
    }),
  ),
})

registerHandler('resolve_ingredients', async (payload: { recipeId: number }) => {
  const pending = db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, payload.recipeId))
    .all()
    .filter((i) => !i.itemId)
  if (pending.length === 0) return
  const pantry = db.select().from(items).all()
  if (pantry.length === 0) return

  const result = await structured({
    schema: IngredientMatches,
    system:
      'You match recipe ingredients to items already in someone\'s pantry. ' +
      'Only use names from the pantry list, copied exactly. ' +
      'Match on what the ingredient IS, ignoring preparation ("diced", "chopped") and brand. ' +
      'Canned and fresh forms of the same vegetable are DIFFERENT items. ' +
      'If nothing in the pantry fits, return an empty string — never guess.',
    user:
      `Pantry:\n${pantry.map((i) => `- ${i.name}`).join('\n')}\n\n` +
      `Ingredients:\n${pending.map((i, n) => `${n + 1}. ${i.rawText}`).join('\n')}`,
  })

  const byName = new Map(pantry.map((i) => [i.name.toLowerCase(), i]))
  pending.forEach((ing, n) => {
    const match = result.matches.find((m) => m.index === n + 1)
    const name = match?.pantry_item?.trim().toLowerCase()
    if (!name) return
    const item = byName.get(name)
    if (!item) return // model invented a name — ignore it
    db.update(recipeIngredients)
      .set({ itemId: item.id, resolution: 'llm' })
      .where(eq(recipeIngredients.id, ing.id))
      .run()
    upsertAlias({
      domain: 'ingredient',
      rawTextNormalized: normalizeItemName(parseIngredientLine(ing.rawText).name),
      storeId: null,
      itemId: item.id,
      source: 'llm',
    })
  })
})

/** Ingredient lines resolve through the ladder; unresolved is legal. */
export function saveIngredients(recipeId: number, lines: string[]) {
  db.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId)).run()
  lines.forEach((raw, position) => {
    const parsed = parseIngredientLine(raw)
    const itemId = resolveIngredientName(parsed.name)
    db.insert(recipeIngredients)
      .values({
        recipeId,
        position,
        rawText: raw,
        itemId,
        quantity: parsed.quantity,
        unit: parsed.unit,
        unitFamily: parsed.unitFamily,
        optional: parsed.optional,
        resolution: itemId ? 'parsed' : 'unresolved',
      })
      .run()
  })
  // Anything the cheap rungs missed goes to the model — queued, so an offline
  // forte just means it resolves later.
  const unresolved = db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .all()
    .filter((i) => !i.itemId).length
  if (unresolved > 0) enqueue('resolve_ingredients', { recipeId })
}

function applyExtraction(recipeId: number, r: ExtractedRecipe, rawSource: string) {
  db.update(recipes)
    .set({
      title: r.title || 'Untitled recipe',
      servings: r.servings,
      instructions: r.instructions,
      imageUrl: r.imageUrl ?? null,
      rawSource: rawSource.slice(0, 50_000),
      status: 'needs_review',
    })
    .where(eq(recipes.id, recipeId))
    .run()
  saveIngredients(recipeId, r.ingredients)
}

// ---------- URL path: schema.org JSON-LD first ----------

function collectNodes(node: unknown, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const n of node) collectNodes(n, out)
  } else if (node && typeof node === 'object') {
    out.push(node)
    const graph = (node as any)['@graph']
    if (graph) collectNodes(graph, out)
  }
  return out
}

function isRecipeNode(node: any): boolean {
  const t = node?.['@type']
  return Array.isArray(t) ? t.includes('Recipe') : t === 'Recipe'
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ')
  if (value && typeof value === 'object') {
    const v = value as any
    return textOf(v.text ?? v.name ?? v.url ?? '')
  }
  return ''
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractJsonLdRecipe(html: string): ExtractedRecipe | null {
  const scripts = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ]
  for (const script of scripts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(script[1]!.trim())
    } catch {
      continue
    }
    const node = collectNodes(parsed).find(isRecipeNode)
    if (!node) continue

    const ingredients: string[] = (node.recipeIngredient ?? node.ingredients ?? [])
      .map((i: unknown) => textOf(i).trim())
      .filter(Boolean)

    const rawInstructions = node.recipeInstructions
    let instructions: string[] = []
    if (typeof rawInstructions === 'string') {
      instructions = stripHtml(rawInstructions)
        .split(/(?<=\.)\s+(?=[A-Z])/)
        .filter(Boolean)
    } else if (Array.isArray(rawInstructions)) {
      instructions = rawInstructions
        .flatMap((step: any) =>
          step?.['@type'] === 'HowToSection' && Array.isArray(step.itemListElement)
            ? step.itemListElement.map((s: unknown) => textOf(s))
            : [textOf(step)],
        )
        .map((s: string) => stripHtml(s).trim())
        .filter(Boolean)
    }

    const yieldRaw = node.recipeYield
    const yieldText = Array.isArray(yieldRaw) ? yieldRaw[0] : yieldRaw
    const servings = Number(String(yieldText ?? '').match(/\d+/)?.[0] ?? '') || null

    const image = node.image
    const imageUrl =
      typeof image === 'string'
        ? image
        : Array.isArray(image)
          ? typeof image[0] === 'string'
            ? image[0]
            : (image[0]?.url ?? null)
          : (image?.url ?? null)

    if (ingredients.length > 0) {
      return {
        title: textOf(node.name).trim() || 'Untitled recipe',
        servings,
        ingredients,
        instructions,
        imageUrl,
      }
    }
  }
  return null
}

const LlmRecipe = z.object({
  title: z.string(),
  servings: z.number().describe('0 if not stated'),
  ingredients: z.array(z.string()).describe('one line each, exactly as written'),
  instructions: z.array(z.string()).describe('one step each'),
})

export async function importRecipeFromUrl(url: string) {
  const recipe = db
    .insert(recipes)
    .values({ title: url, sourceType: 'url', sourceUrl: url, status: 'pending_parse' })
    .returning()
    .get()
  enqueue('parse_recipe_url', { recipeId: recipe.id, url })
  return recipe
}

registerHandler('parse_recipe_url', async (payload: { recipeId: number; url: string }) => {
  const res = await fetch(payload.url, {
    headers: {
      // Plain fetch gets blocked by a lot of recipe sites.
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    // 404/403 won't fix itself — say so in the UI instead of retrying for an hour.
    if (res.status < 500) {
      db.update(recipes)
        .set({ status: 'parse_failed', title: `Couldn't read ${payload.url}` })
        .where(eq(recipes.id, payload.recipeId))
        .run()
      throw new PermanentJobError(`fetch ${payload.url} → ${res.status}`)
    }
    throw new Error(`fetch ${payload.url} → ${res.status}`)
  }
  const html = await res.text()

  const structuredData = extractJsonLdRecipe(html)
  if (structuredData) {
    applyExtraction(payload.recipeId, structuredData, JSON.stringify(structuredData))
    return
  }

  // No structured data — fall back to the model on the readable text.
  const text = stripHtml(html).slice(0, 16_000)
  const parsed = await structured({
    schema: LlmRecipe,
    system:
      'You extract recipes from web page text. Return the ingredient lines verbatim ' +
      '(including amounts) and the method as discrete steps. Ignore navigation, ads and comments.',
    user: text,
  })
  applyExtraction(
    payload.recipeId,
    {
      title: parsed.title,
      servings: parsed.servings > 0 ? parsed.servings : null,
      ingredients: parsed.ingredients,
      instructions: parsed.instructions,
    },
    text.slice(0, 20_000),
  )
})

// ---------- photo path: the vision model ----------

export function importRecipeFromPhoto(buffer: Buffer, filename: string) {
  const uploads = path.join(config.DATA_DIR, 'uploads')
  fs.mkdirSync(uploads, { recursive: true })
  const safe = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
  const dest = path.join(uploads, safe)
  fs.writeFileSync(dest, buffer)

  const recipe = db
    .insert(recipes)
    .values({
      title: 'Photo recipe (reading…)',
      sourceType: 'photo',
      sourceImagePath: safe,
      status: 'pending_parse',
    })
    .returning()
    .get()
  enqueue('parse_recipe_photo', { recipeId: recipe.id, file: safe })
  return recipe
}

registerHandler('parse_recipe_photo', async (payload: { recipeId: number; file: string }) => {
  const file = path.join(config.DATA_DIR, 'uploads', payload.file)
  const base64 = fs.readFileSync(file).toString('base64')
  const parsed = await structured({
    schema: LlmRecipe,
    vision: true,
    system:
      'You read a photo or screenshot of a recipe and transcribe it. ' +
      'Return ingredient lines verbatim including amounts, and the method as discrete steps.',
    user: 'Transcribe this recipe.',
    images: [base64],
  })
  applyExtraction(
    payload.recipeId,
    {
      title: parsed.title,
      servings: parsed.servings > 0 ? parsed.servings : null,
      ingredients: parsed.ingredients,
      instructions: parsed.instructions,
    },
    JSON.stringify(parsed),
  )
})
