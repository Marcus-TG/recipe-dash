import fs from 'node:fs'
import path from 'node:path'
import { asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { cookSessionLines, items, recipeIngredients, recipes } from '../db/schema.js'
import { resolveIngredientName, upsertAlias } from '../domain/resolve.js'
import {
  dropTrailingNonSteps,
  ingredientHeading,
  normalizeItemName,
  OPTIONAL_HINT,
  parseIngredientLine,
  splitIngredientSections,
} from '../domain/text.js'
import { enqueue, PermanentJobError, registerHandler } from '../services/jobs.js'
import { structured } from '../services/ollama.js'

// ---------- shared shape ----------

type ExtractedRecipe = {
  title: string
  servings: number | null
  ingredients: string[]
  instructions: string[]
  notes: string[]
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

/**
 * Ingredient lines resolve through the ladder; unresolved is legal. Section
 * headings ("For the beans:") become a label on the lines under them rather
 * than rows — see ingredientHeading.
 */
export function saveIngredients(recipeId: number, lines: string[]) {
  // Cook history points at the old rows. It keeps its own label and item, so
  // it only loses the link back — without this, replacing the ingredients of
  // any recipe you'd already cooked failed on the foreign key.
  const old = db
    .select({ id: recipeIngredients.id })
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .all()
    .map((r) => r.id)
  if (old.length > 0) {
    db.update(cookSessionLines)
      .set({ recipeIngredientId: null })
      .where(inArray(cookSessionLines.recipeIngredientId, old))
      .run()
  }
  db.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId)).run()
  splitIngredientSections(lines).forEach(({ rawText: raw, section }, position) => {
    const parsed = parseIngredientLine(raw)
    const itemId = resolveIngredientName(parsed.name)
    db.insert(recipeIngredients)
      .values({
        recipeId,
        position,
        rawText: raw,
        section,
        itemId,
        quantity: parsed.quantity,
        unit: parsed.unit,
        unitFamily: parsed.unitFamily,
        // "Garnish, optional" says it for every line under it.
        optional: parsed.optional || (section != null && OPTIONAL_HINT.test(section)),
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
  const current = db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
  // Reading a recipe again shouldn't send one you've already reviewed back to
  // the review pile.
  const reviewed = current?.status === 'active' || current?.status === 'archived'
  db.update(recipes)
    .set({
      title: r.title || 'Untitled recipe',
      servings: r.servings,
      instructions: dropTrailingNonSteps(r.instructions),
      notes: r.notes,
      // A picture you chose yourself survives a re-read.
      ...(current?.imageFile ? {} : { imageUrl: r.imageUrl ?? null }),
      rawSource: rawSource.slice(0, 50_000),
      status: reviewed ? current!.status : 'needs_review',
    })
    .where(eq(recipes.id, recipeId))
    .run()
  saveIngredients(recipeId, r.ingredients)
  if (r.imageUrl && !current?.imageFile) enqueue('fetch_recipe_image', { recipeId })
}

// ---------- thumbnails ----------

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
}

/** Attach a picture you uploaded yourself. Returns the served path. */
export function attachRecipeImageFile(
  recipeId: number,
  buffer: Buffer,
  mimetype: string,
) {
  const ext = EXT_BY_TYPE[mimetype.split(';')[0]!.trim()]
  if (!ext) throw new Error(`unsupported image type: ${mimetype}`)
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('image too big')
  const uploads = path.join(config.DATA_DIR, 'uploads')
  fs.mkdirSync(uploads, { recursive: true })
  // Timestamped so a replacement doesn't get served from a stale browser cache.
  const filename = `recipe-${recipeId}-${Date.now()}.${ext}`
  fs.writeFileSync(path.join(uploads, filename), buffer)
  db.update(recipes)
    .set({ imageFile: filename })
    .where(eq(recipes.id, recipeId))
    .run()
  return filename
}

/**
 * Point a recipe at a picture on the web. Downloads immediately rather than
 * queueing: someone pasted this link and is waiting, so a bad URL should say
 * so now instead of failing invisibly in the background.
 */
export async function attachRecipeImageUrl(recipeId: number, url: string) {
  db.update(recipes)
    // Clearing imageFile is what allows a replacement.
    .set({ imageUrl: url, imageFile: null })
    .where(eq(recipes.id, recipeId))
    .run()
  return downloadRecipeImage(recipeId)
}

export function clearRecipeImage(recipeId: number) {
  const recipe = db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
  if (!recipe) return
  // Never delete the photo a photo-import was created from — it's the source.
  if (recipe.imageFile && recipe.imageFile !== recipe.sourceImagePath) {
    try {
      fs.unlinkSync(path.join(config.DATA_DIR, 'uploads', recipe.imageFile))
    } catch {
      /* already gone */
    }
  }
  db.update(recipes)
    .set({ imageFile: null, imageUrl: null })
    .where(eq(recipes.id, recipeId))
    .run()
}

/**
 * Cache the recipe's picture locally. A missing thumbnail is cosmetic, so
 * failures are permanent rather than retried into the ground.
 */
export async function downloadRecipeImage(recipeId: number) {
  const recipe = db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
  if (!recipe?.imageUrl || recipe.imageFile) return null

  let res: Response
  try {
    res = await fetch(recipe.imageUrl, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'image/*',
        // Some CDNs refuse images without the page they belong to.
        ...(recipe.sourceUrl ? { referer: recipe.sourceUrl } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new PermanentJobError('could not reach that address')
  }
  if (!res.ok) {
    throw new PermanentJobError(`that address returned an error (${res.status})`)
  }

  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
  const ext = EXT_BY_TYPE[type]
  if (!ext) {
    throw new PermanentJobError(
      `that link is ${type || 'not an image'} — you need the address of the image itself`,
    )
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new PermanentJobError('that image is bigger than 8 MB')
  }

  const uploads = path.join(config.DATA_DIR, 'uploads')
  fs.mkdirSync(uploads, { recursive: true })
  // Timestamped so a replacement isn't served from a stale browser cache.
  const filename = `recipe-${recipe.id}-${Date.now()}.${ext}`
  fs.writeFileSync(path.join(uploads, filename), buffer)
  db.update(recipes)
    .set({ imageFile: filename })
    .where(eq(recipes.id, recipe.id))
    .run()
  return filename
}

// The automatic path (during import) stays queued — nobody is waiting on it.
registerHandler('fetch_recipe_image', async (payload: { recipeId: number }) => {
  await downloadRecipeImage(payload.recipeId)
})

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

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  prime: '′',
  Prime: '″',
  deg: '°',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  times: '×',
}

/**
 * Recipe sites encode everything — "it&#039;s", "1/2&quot; cubes", "&ndash;".
 * Any one this misses shows up as literal junk in the method.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, code: string) => {
    if (code.startsWith('#')) {
      const n =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10)
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match
    }
    return NAMED_ENTITIES[code] ?? NAMED_ENTITIES[code.toLowerCase()] ?? match
  })
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * WP Recipe Maker's structured data wraps each line's note as "(, …)" — "1
 * small onion (, finely chopped)" — and doubles parentheses the author already
 * wrote. Put lines back the way the recipe card shows them.
 */
function cleanIngredientLine(line: string): string {
  return stripHtml(line)
    .replace(/\(\s*,\s*((?:[^()]|\([^()]*\))*)\)/g, ', $1')
    .replace(/\(\(((?:[^()]|\([^()]*\))*)\)\)/g, '($1)')
    .replace(/\s+,/g, ',')
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
      .map((i: unknown) => cleanIngredientLine(textOf(i)))
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
        title: stripHtml(textOf(node.name)) || 'Untitled recipe',
        servings,
        ingredients,
        instructions,
        // schema.org has nowhere to put them — see extractRecipeNotes.
        notes: [],
        imageUrl,
      }
    }
  }
  return null
}

// ---------- reading the recipe card's own markup ----------
//
// schema.org's Recipe drops two things worth having: the notes under the
// card, and the second measure on each line. Both are in the page, in the
// markup of whichever plugin built the card.

function hasClass(openTag: string, cls: string): boolean {
  const m = openTag.match(/\bclass=["']([^"']*)["']/i)
  return !!m && m[1]!.split(/\s+/).includes(cls)
}

/** Index of the first opening tag carrying this class, or -1. */
function findByClass(html: string, cls: string): number {
  for (const m of html.matchAll(/<[a-z0-9]+\b[^>]*\bclass=["'][^"']*["'][^>]*>/gi)) {
    if (hasClass(m[0], cls)) return m.index!
  }
  return -1
}

/** What's inside the element that opens at `at`, nested elements included. */
function innerHtml(html: string, at: number): string | null {
  const tag = html.slice(at + 1).match(/^[a-z0-9]+/i)?.[0]
  const openEnd = html.indexOf('>', at)
  if (!tag || openEnd < 0) return null
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  re.lastIndex = openEnd + 1
  let depth = 1
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1
    if (depth === 0) return html.slice(openEnd + 1, m.index)
  }
  return null
}

/** One string per paragraph or list item. */
function htmlToParagraphs(html: string): string[] {
  // An <ol> numbers its items on screen without the numbers being in the text.
  const numbered = /<ol\b/i.test(html) && !/<ul\b/i.test(html)
  let n = 0
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<li\b[^>]*>/gi, () => (numbered ? `\n${++n}. ` : '\n'))
    .replace(/<br\s*\/?>|<\/?(?:p|div|li|ul|ol|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<span\b[^>]*display:\s*block[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

// Where recipe plugins keep the card's notes, most specific first: WP Recipe
// Maker, Tasty Recipes, Mediavine Create.
const NOTES_CLASSES = [
  'wprm-recipe-notes',
  'tasty-recipes-notes-body',
  'tasty-recipes-notes',
  'mv-create-notes-content',
  'mv-create-notes',
]

/** The notes under the recipe card, one entry per paragraph. */
function extractRecipeNotes(html: string): string[] {
  for (const cls of NOTES_CLASSES) {
    const at = findByClass(html, cls)
    if (at < 0) continue
    const inner = innerHtml(html, at)
    if (!inner) continue
    const notes = htmlToParagraphs(inner).filter((p) => !/^(recipe )?notes?:?$/i.test(p))
    if (notes.length > 0) return notes
  }
  return []
}

/**
 * The object literal assigned after `marker`. Scanned brace by brace rather
 * than matched with a regex, so a second statement in the same script tag
 * can't end up inside it.
 */
function objectAfter(html: string, marker: string): unknown {
  const at = html.indexOf(marker)
  const start = at < 0 ? -1 : html.indexOf('{', at)
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

const plain = (v: unknown) => (typeof v === 'string' ? stripHtml(v) : '')

/** One WPRM ingredient as a line: "1/3 cup (50 g) flour, sifted". */
function wprmLine(ing: any): string {
  const measure = [plain(ing?.amount), plain(ing?.unit)].filter(Boolean).join(' ')
  const converted = Object.values(ing?.converted ?? {}).find((c: any) =>
    plain(c?.amount),
  ) as any
  const other = converted
    ? [plain(converted.amount), plain(converted.unit)].filter(Boolean).join(' ')
    : ''
  const line = [measure, measure && other ? `(${other})` : '', plain(ing?.name)]
    .filter(Boolean)
    .join(' ')
  const notes = plain(ing?.notes)
  if (!notes) return line
  return notes.startsWith(',') ? `${line}${notes}` : `${line} ${notes}`
}

/** The card's ingredient groups, in order: their headings and how many lines each holds. */
function wprmGroups(html: string, recipeId: string) {
  const at = html.search(new RegExp(`<[a-z]+[^>]*\\bid=["']recipe-${recipeId}-ingredients["']`, 'i'))
  const inner = at < 0 ? null : innerHtml(html, at)
  if (!inner) return null
  const groups: { name: string | null; count: number }[] = []
  for (const tag of inner.matchAll(/<([a-z0-9]+)\b[^>]*>/gi)) {
    const open = tag[0]
    if (hasClass(open, 'wprm-recipe-ingredient-group')) groups.push({ name: null, count: 0 })
    const group = groups.at(-1)
    if (!group) continue
    if (hasClass(open, 'wprm-recipe-group-name')) {
      const from = tag.index! + open.length
      group.name = stripHtml(inner.slice(from, inner.indexOf(`</${tag[1]}`, from))) || null
    } else if (tag[1]!.toLowerCase() === 'li' && hasClass(open, 'wprm-recipe-ingredient')) {
      group.count++
    }
  }
  return groups
}

/**
 * WP Recipe Maker — the plugin behind RecipeTin Eats and a good share of food
 * blogs — keeps the author's own metric amounts in the page: "1/3 cup" flour
 * is stored with "50 g" beside it, weighed by the author rather than worked
 * out by us. The structured data carries only the first, so read the
 * plugin's copy and write both into the line, the way a cookbook would:
 * "1/3 cup (50 g) flour". Sub-headings ("Garnish, optional") come along too.
 *
 * Null whenever it doesn't line up, and the structured-data lines stand.
 */
function wprmIngredients(html: string, title: string): string[] | null {
  const all = objectAfter(html, 'window.wprm_recipes')
  if (!all || typeof all !== 'object') return null
  const entries = Object.entries(all as Record<string, any>)
  // A page with several cards: only trust the one with this recipe's name.
  const found =
    entries.find(([, r]) => plain(r?.name) === title) ??
    (entries.length === 1 ? entries[0] : undefined)
  if (!found) return null
  const [key, recipe] = found
  if (!Array.isArray(recipe?.ingredients)) return null
  const lines = (recipe.ingredients as any[])
    .filter((i) => i?.type !== 'group')
    .map(wprmLine)
    .filter(Boolean)
  if (lines.length === 0) return null

  const id = key.replace(/^recipe-/, '')
  const groups = /^\d+$/.test(id) ? wprmGroups(html, id) : null
  if (!groups || groups.reduce((n, g) => n + g.count, 0) !== lines.length) return lines
  const out: string[] = []
  let next = 0
  for (const g of groups) {
    // Written as a heading, which saveIngredients folds into a section.
    if (g.name) out.push(`${g.name.replace(/:+$/, '')}:`)
    out.push(...lines.slice(next, next + g.count))
    next += g.count
  }
  return out
}

/** Everything the page can tell us by itself, before any model is asked. */
export function extractRecipeFromHtml(html: string): ExtractedRecipe | null {
  const recipe = extractJsonLdRecipe(html)
  if (!recipe) return null
  return {
    ...recipe,
    ingredients: wprmIngredients(html, recipe.title) ?? recipe.ingredients,
    notes: extractRecipeNotes(html),
  }
}

const LlmRecipe = z.object({
  title: z.string(),
  servings: z.number().describe('0 if not stated'),
  ingredients: z.array(z.string()).describe('one line each, exactly as written'),
  instructions: z.array(z.string()).describe('one step each'),
  notes: z
    .array(z.string())
    .describe("the recipe's own notes and tips, one each, as written; empty if none"),
})

function fromModel(parsed: z.infer<typeof LlmRecipe>): ExtractedRecipe {
  return {
    title: parsed.title,
    servings: parsed.servings > 0 ? parsed.servings : null,
    ingredients: parsed.ingredients,
    instructions: parsed.instructions,
    notes: parsed.notes,
  }
}

// Shared instruction for every "read a recipe out of messy input" path.
// The debloating is the point: recipe pages are 90% story and ads.
const EXTRACT_SYSTEM =
  'You extract the actual recipe from messy text and throw away everything else. ' +
  'Discard the blog story, the SEO padding, ads, cookie notices, navigation, ' +
  'author bios, comments, ratings, nutrition tables, "jump to recipe" links and ' +
  'related-recipe lists. ' +
  'Keep ingredient lines verbatim including their amounts — both of them when ' +
  'a line gives two, like "1 cup (125 g) flour". ' +
  'Keep the method as discrete steps, trimmed to the actual instruction — ' +
  'no chatter, but never drop a temperature, time, or quantity. ' +
  'Keep the notes printed with the recipe itself (substitutions, storage, ' +
  'make-ahead, "Note 1" tips) as notes, worded as written. They are part of ' +
  'the recipe; the story above it is not. ' +
  'If the text contains no recipe at all, return an empty ingredients array.'

const BROWSER_HEADERS = {
  // Plain fetch gets blocked by a lot of recipe sites.
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
}

export async function importRecipeFromUrl(url: string) {
  const recipe = db
    .insert(recipes)
    .values({ title: url, sourceType: 'url', sourceUrl: url, status: 'pending_parse' })
    .returning()
    .get()
  enqueue('parse_recipe_url', { recipeId: recipe.id, url })
  return recipe
}

/**
 * A re-read that comes back with no recipe leaves the one you have alone,
 * rather than replacing it with nothing.
 */
function keepOnEmptyReread(parsed: ExtractedRecipe, reread: boolean | undefined) {
  if (reread && parsed.ingredients.length === 0) {
    throw new PermanentJobError('re-read found no recipe; kept the existing one')
  }
}

/** No structured data on the page: the model reads its text instead. */
async function readPageWithModel(recipeId: number, html: string, reread?: boolean) {
  const text = stripHtml(html).slice(0, 16_000)
  const parsed = fromModel(
    await structured({ schema: LlmRecipe, system: EXTRACT_SYSTEM, user: text }),
  )
  keepOnEmptyReread(parsed, reread)
  // The card's own markup beats the model's reading of it, when there is one.
  const notes = extractRecipeNotes(html)
  applyExtraction(
    recipeId,
    { ...parsed, notes: notes.length > 0 ? notes : parsed.notes },
    text.slice(0, 20_000),
  )
}

registerHandler(
  'parse_recipe_url',
  async (payload: { recipeId: number; url: string; reread?: boolean }) => {
    const res = await fetch(payload.url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      // 404/403 won't fix itself — say so in the UI instead of retrying for an hour.
      if (res.status < 500) {
        // Unless this was a re-read: then there's a perfectly good recipe
        // here already, and it stays as it was.
        if (!payload.reread) {
          db.update(recipes)
            .set({ status: 'parse_failed', title: `Couldn't read ${payload.url}` })
            .where(eq(recipes.id, payload.recipeId))
            .run()
        }
        throw new PermanentJobError(`fetch ${payload.url} → ${res.status}`)
      }
      throw new Error(`fetch ${payload.url} → ${res.status}`)
    }
    const html = await res.text()

    const fromPage = extractRecipeFromHtml(html)
    if (fromPage) {
      applyExtraction(payload.recipeId, fromPage, JSON.stringify(fromPage))
      return
    }
    await readPageWithModel(payload.recipeId, html, payload.reread)
  },
)

export class RereadError extends Error {}

/**
 * Read a recipe from its source again — for recipes imported before the
 * importer learned something, like notes or the author's metric amounts.
 * Replaces the ingredients, method and notes, including any revision applied
 * from the chat. Which pantry item a line means survives, because that lives
 * in the alias table.
 *
 * A link is fetched now rather than queued: someone tapped a button and is
 * waiting, and a site that refuses should say so while they're looking — with
 * the recipe left exactly as it was.
 */
export async function rereadRecipe(recipeId: number): Promise<'done' | 'queued'> {
  const recipe = db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
  if (!recipe) throw new RereadError('Not found')

  if (recipe.sourceType === 'url' && recipe.sourceUrl) {
    let res: Response
    try {
      res = await fetch(recipe.sourceUrl, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new RereadError('Couldn’t reach the recipe’s site. Nothing was changed.')
    }
    if (!res.ok) {
      throw new RereadError(
        `The recipe’s site answered ${res.status}. Nothing was changed.`,
      )
    }
    const html = await res.text()
    const fromPage = extractRecipeFromHtml(html)
    if (fromPage) {
      applyExtraction(recipe.id, fromPage, JSON.stringify(fromPage))
      return 'done'
    }
    enqueue('parse_recipe_url', { recipeId: recipe.id, url: recipe.sourceUrl, reread: true })
    return 'queued'
  }
  if (recipe.sourceType === 'text' && recipe.rawSource) {
    enqueue('parse_recipe_text', { recipeId: recipe.id, reread: true })
    return 'queued'
  }
  if (recipe.sourceType === 'photo' && recipe.sourceImagePath) {
    enqueue('parse_recipe_photo', {
      recipeId: recipe.id,
      file: recipe.sourceImagePath,
      reread: true,
    })
    return 'queued'
  }
  throw new RereadError('There’s nothing to read this recipe from again.')
}

// ---------- paste path: for sites that refuse to be read ----------

/**
 * Plenty of recipe sites return 403 to anything that isn't a browser
 * (simplyrecipes, allrecipes, seriouseats). Selecting the page and pasting it
 * here goes through the same extraction, so the fluff still gets stripped.
 */
export function importRecipeFromText(text: string, sourceUrl?: string | null) {
  const recipe = db
    .insert(recipes)
    .values({
      title: 'Pasted recipe (reading…)',
      sourceType: 'text',
      sourceUrl: sourceUrl ?? null,
      status: 'pending_parse',
      rawSource: text.slice(0, 50_000),
    })
    .returning()
    .get()
  enqueue('parse_recipe_text', { recipeId: recipe.id })
  return recipe
}

registerHandler(
  'parse_recipe_text',
  async (payload: { recipeId: number; reread?: boolean }) => {
    const recipe = db
      .select()
      .from(recipes)
      .where(eq(recipes.id, payload.recipeId))
      .get()
    if (!recipe?.rawSource) return
    const parsed = await structured({
      schema: LlmRecipe,
      system: EXTRACT_SYSTEM,
      user: recipe.rawSource.slice(0, 16_000),
    })
    if (parsed.ingredients.length === 0) {
      // A re-read that comes back empty leaves the recipe you had alone.
      if (!payload.reread) {
        db.update(recipes)
          .set({ status: 'parse_failed', title: 'No recipe found in that text' })
          .where(eq(recipes.id, recipe.id))
          .run()
      }
      throw new PermanentJobError('no recipe found in pasted text')
    }
    applyExtraction(recipe.id, fromModel(parsed), recipe.rawSource)
  },
)

// ---------- talking to the model about a recipe ----------

// Two calls, each with one job. Asking a single call to both answer in prose
// AND emit a structured recipe reliably produced neither: the model wrote the
// revised ingredients into the prose field and left the structured arrays
// empty, so there was nothing to apply.
const ChatIntent = z.object({
  wants_modification: z
    .boolean()
    .describe('true if the cook wants the recipe itself changed, not just a question answered'),
  reply: z
    .string()
    .describe(
      'answer the question in at most 3 sentences. If wants_modification is true, ' +
        'just say what you changed in ONE sentence — never list ingredients here.',
    ),
})

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

/** Keep the model's sentence if it stayed brief; otherwise say it ourselves. */
function shortIntro(reply: string): string {
  const firstLine = reply.split('\n')[0]!.trim()
  const clean = firstLine.replace(/[*_`#]/g, '').trim()
  const looksLikeAList = /^[-•\d]/.test(clean) || clean.endsWith(':')
  if (clean.length > 0 && clean.length <= 160 && !looksLikeAList) return clean
  return 'Here’s a revised version — have a look below.'
}

/**
 * Put the "For the pico:" headings back so the model sees the recipe the way
 * the site wrote it — and so a revision it returns carries them, which
 * saveIngredients folds into sections again.
 */
function withSectionHeadings(ings: { rawText: string; section: string | null }[]) {
  const out: string[] = []
  let current: string | null = null
  for (const i of ings) {
    if (i.section && i.section !== current) out.push(`For the ${i.section.toLowerCase()}:`)
    current = i.section
    out.push(i.rawText)
  }
  return out
}

/**
 * Ask about substitutions, scaling, technique — and optionally get back a
 * complete revised recipe to apply. The pantry goes into the prompt, so
 * "what can I swap this for?" has a useful answer.
 */
export async function chatAboutRecipe(
  recipeId: number,
  message: string,
  history: ChatTurn[],
) {
  const recipe = db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
  if (!recipe) throw new Error('recipe not found')
  const ings = db
    .select()
    .from(recipeIngredients)
    .where(eq(recipeIngredients.recipeId, recipeId))
    .all()
  const pantry = db.select().from(items).all()

  const recipeContext =
    `RECIPE: ${recipe.title}\n` +
    `Serves: ${recipe.servings ?? 'unstated'}\n\n` +
    `Ingredients:\n${withSectionHeadings(ings).map((l) => `- ${l}`).join('\n')}\n\n` +
    `Method:\n${recipe.instructions.map((s, n) => `${n + 1}. ${s}`).join('\n')}\n\n` +
    (recipe.notes.length > 0
      ? `Notes:\n${recipe.notes.map((n) => `- ${n}`).join('\n')}\n\n`
      : '') +
    // What they found last time they made it — worth knowing before
    // suggesting anything.
    (recipe.myNotes ? `THE COOK'S OWN NOTES ON THIS RECIPE:\n${recipe.myNotes}\n\n` : '')

  const intent = await structured({
    schema: ChatIntent,
    timeoutMs: 240_000,
    system:
      'You are helping someone cook in their own kitchen, from their own recipe. ' +
      'Be concise and practical — no preamble, no restating the question. ' +
      'When they ask about substitutions, prefer things from their pantry list. ' +
      'Set wants_modification=true only when they want the recipe itself changed ' +
      '(scale it, swap an ingredient, make it vegetarian, simplify it).',
    user:
      recipeContext +
      `THEIR PANTRY: ${pantry.map((i) => i.name).join(', ') || '(empty)'}\n\n` +
      (history.length
        ? `EARLIER IN THIS CONVERSATION:\n${history
            .slice(-6)
            .map((t) => `${t.role === 'user' ? 'Cook' : 'You'}: ${t.content}`)
            .join('\n')}\n\n`
        : '') +
      `COOK ASKS: ${message}`,
  })

  if (!intent.wants_modification) {
    return { reply: intent.reply, proposal: null }
  }

  // Second call does nothing but rewrite the recipe.
  const revised = await structured({
    schema: LlmRecipe,
    timeoutMs: 240_000,
    system:
      'You revise recipes. Apply the requested change and return the COMPLETE recipe — ' +
      'every ingredient and every step, including the ones that did not change. ' +
      'Keep ingredient lines in the same "amount unit ingredient" style as the original. ' +
      'A line with two measures, like "1 cup (125 g) flour", keeps both — scale both. ' +
      'Scale amounts accurately and adjust any amounts mentioned inside the steps too. ' +
      'Keep the notes, correcting any the change makes wrong.',
    user: recipeContext + `CHANGE REQUESTED: ${message}`,
  })

  if (revised.ingredients.length === 0) {
    return { reply: intent.reply, proposal: null }
  }

  return {
    // The proposal card below already shows the full revision, so the chat
    // bubble stays a one-liner. Models ignore "don't list the ingredients"
    // often enough that this is enforced here rather than asked for.
    reply: shortIntro(intent.reply),
    proposal: {
      title: revised.title || recipe.title,
      servings: revised.servings > 0 ? revised.servings : recipe.servings,
      ingredients: revised.ingredients,
      instructions: revised.instructions.length
        ? revised.instructions
        : recipe.instructions,
      notes: revised.notes.length ? revised.notes : recipe.notes,
    },
  }
}

/** Apply a proposed revision in place; ingredients re-resolve to the pantry. */
export function applyRecipeRevision(
  recipeId: number,
  revision: {
    title: string
    servings: number | null
    ingredients: string[]
    instructions: string[]
    notes?: string[]
  },
) {
  db.update(recipes)
    .set({
      title: revision.title,
      servings: revision.servings,
      instructions: revision.instructions,
      ...(revision.notes ? { notes: revision.notes } : {}),
    })
    .where(eq(recipes.id, recipeId))
    .run()
  saveIngredients(recipeId, revision.ingredients)
}

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
      // The photo you took IS the thumbnail.
      imageFile: safe,
      status: 'pending_parse',
    })
    .returning()
    .get()
  enqueue('parse_recipe_photo', { recipeId: recipe.id, file: safe })
  return recipe
}

registerHandler(
  'parse_recipe_photo',
  async (payload: { recipeId: number; file: string; reread?: boolean }) => {
    const file = path.join(config.DATA_DIR, 'uploads', payload.file)
    const base64 = fs.readFileSync(file).toString('base64')
    const parsed = await structured({
      schema: LlmRecipe,
      vision: true,
      system:
        'You read a photo or screenshot of a recipe and transcribe it. ' +
        'Return ingredient lines verbatim including amounts (both, when a line gives two), ' +
        'the method as discrete steps, and any notes or tips printed with the recipe.',
      user: 'Transcribe this recipe.',
      images: [base64],
    })
    const recipe = fromModel(parsed)
    keepOnEmptyReread(recipe, payload.reread)
    applyExtraction(payload.recipeId, recipe, JSON.stringify(parsed))
  },
)

/**
 * Recipes imported before headings were understood have "For the beans:" rows
 * sitting in their ingredient lists. Re-save those from their raw lines so
 * the headings fold into sections. Runs once per boot, touches only recipes
 * that actually have a heading row. Human item fixes survive because they
 * live in the alias table, which the ladder consults on re-save.
 */
export function backfillIngredientSections() {
  const rows = db
    .select({
      recipeId: recipeIngredients.recipeId,
      rawText: recipeIngredients.rawText,
    })
    .from(recipeIngredients)
    .orderBy(asc(recipeIngredients.recipeId), asc(recipeIngredients.position))
    .all()
  const byRecipe = new Map<number, string[]>()
  for (const r of rows) {
    const list = byRecipe.get(r.recipeId) ?? []
    list.push(r.rawText)
    byRecipe.set(r.recipeId, list)
  }
  let fixed = 0
  for (const [recipeId, lines] of byRecipe) {
    if (!lines.some((l) => ingredientHeading(l))) continue
    saveIngredients(recipeId, lines)
    const recipe = db.select().from(recipes).where(eq(recipes.id, recipeId)).get()
    if (recipe) {
      const steps = dropTrailingNonSteps(recipe.instructions)
      if (steps.length !== recipe.instructions.length) {
        db.update(recipes).set({ instructions: steps }).where(eq(recipes.id, recipeId)).run()
      }
    }
    fixed++
  }
  return fixed
}
