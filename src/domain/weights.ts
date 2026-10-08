// What a cup of something weighs, for the recipes that only say "1 cup".
//
// Never a model's guess. An estimate has to come from something that was
// actually measured, and it says which:
//
//   1. a density you set on the pantry item yourself;
//   2. the same site's own weights — every "1/3 cup (50 g) flour" on
//      RecipeTin Eats is the author weighing a third of HER cup of flour;
//   3. USDA's measured cup weights (cup-weights.ts);
//   4. any recipe in your library, only for what USDA doesn't list.
//
// An author's weight is a fact about that author's cups, not about flour.
// RecipeTin Eats fills a 250 ml cup to about 150 g of flour; USDA's US cup is
// 125 g. Both are right, and mixing them puts 20% too much flour in a US
// cake — so a site's weights are used for that site's recipes and nobody
// else's, and every cup counts at the size its recipe uses (text.ts reads it
// off lines like "2 cups (500 ml) milk"). Nothing here is stored — it's worked out on each read from the lines already in the
// database, so importing a recipe that weighs its flour sharpens every other
// recipe that doesn't.
//
// Display only. The pantry's rule that mass and volume never meet without a
// density a human gave is untouched: matching and the shopping list don't see
// any of this.

import { CUP_WEIGHTS, type CupWeight } from './cup-weights.js'
import {
  authorPair,
  describeIngredient,
  type Density,
  foodTokens,
  METRIC_CUP_ML,
  parseIngredientLine,
  recipeCupMl,
  US_CUP_ML,
} from './text.js'

// "all-purpose" and "all purpose" are the same flour.
const key = (name: string) => foodTokens(name.replace(/-/g, ' ')).join(' ')

const REFERENCE = new Map<string, number>()
CUP_WEIGHTS.forEach((entry, n) => {
  for (const name of entry.names) REFERENCE.set(key(name), n)
})

/**
 * Which USDA entry a name means, by index. The food words must match exactly
 * — "sugar" never answers "coconut sugar", "cream" never answers "sour
 * cream". Leading words may fall away while two are left, so "extra sharp
 * cheddar cheese" still finds cheddar cheese, but a two-word name is never
 * cut to one.
 */
function referenceIndex(name: string): number | null {
  const tokens = key(name).split(' ')
  const floor = Math.min(2, tokens.length)
  for (let i = 0; tokens.length - i >= floor; i++) {
    const n = REFERENCE.get(tokens.slice(i).join(' '))
    if (n != null) return n
  }
  return null
}

// How the line says it's prepared → which USDA portion fits. A cup of
// chopped onion is 160 g; sliced, 115 g.
const PREP: [RegExp, string[]][] = [
  [/\bgrated\b/i, ['grated', 'shredded']],
  [/\bshredded\b/i, ['shredded', 'grated']],
  [/\b(diced|chopped|cubed|minced)\b/i, ['chopped']],
  [/\bslivered\b/i, ['slivered']],
  [/\bsliced\b/i, ['sliced']],
  [/\bunpacked|loosely packed\b/i, ['unpacked']],
  [/\bpacked\b/i, ['packed']],
  [/\bsifted\b/i, ['sifted']],
  [/\bcrumbled\b/i, ['crumbled']],
  [/\bmashed\b/i, ['mashed']],
  [/\bhalve[sd]\b/i, ['halves']],
  [/\bground\b/i, ['ground']],
  [/\bwhole\b/i, ['whole']],
]

function portionFor(entry: CupWeight, line: string): string {
  for (const [words, preps] of PREP) {
    if (!words.test(line)) continue
    const prep = preps.find((p) => entry.grams[p] != null)
    if (prep) return prep
  }
  return Object.keys(entry.grams)[0]!
}

function referenceDensity(index: number, line: string): Density {
  const entry = CUP_WEIGHTS[index]!
  const prep = portionFor(entry, line)
  const grams = entry.grams[prep]!
  const how = prep === 'cup' ? '' : `, ${prep}`
  return {
    gPerMl: grams / US_CUP_ML,
    source: `USDA's measured weight for “${entry.usda}”: ${grams} g a cup${how}.`,
  }
}

/** "www.recipetineats.com/…" → "recipetineats.com". Null for pastes and photos. */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

type Sample = {
  gPerMl: number
  recipeTitle: string
  rawText: string
  site: string | null
  cupMl: number
}

export type Library = {
  samples: Map<string, Sample[]>
  cupByRecipe: Map<number, number>
  cupBySite: Map<string, number>
}

type Row = {
  recipeId: number
  rawText: string
  itemId: number | null
  recipeTitle: string
  sourceUrl: string | null
}

/**
 * Every line where an author gave a volume and a weight together is a
 * measurement. Filed under the pantry item the line resolved to, under the
 * USDA entry its name means — so "plain flour" and "all-purpose flour" pool
 * — and under its own food words, for things USDA doesn't list.
 */
export function learnDensities(rows: Row[]): Library {
  const byRecipe = new Map<number, Row[]>()
  for (const row of rows) byRecipe.set(row.recipeId, [...(byRecipe.get(row.recipeId) ?? []), row])

  // Each recipe's cup, from its own lines; a site's, from the recipes that say.
  const cupByRecipe = new Map<number, number>()
  const siteVotes = new Map<string, number[]>()
  for (const [id, lines] of byRecipe) {
    const cup = recipeCupMl(lines.map((l) => l.rawText))
    if (cup == null) continue
    cupByRecipe.set(id, cup)
    const site = siteOf(lines[0]!.sourceUrl)
    if (site) siteVotes.set(site, [...(siteVotes.get(site) ?? []), cup])
  }
  const cupBySite = new Map<string, number>()
  for (const [site, votes] of siteVotes) {
    const metric = votes.filter((v) => v === METRIC_CUP_ML).length
    cupBySite.set(site, metric > votes.length / 2 ? METRIC_CUP_ML : US_CUP_ML)
  }

  const samples = new Map<string, Sample[]>()
  for (const row of rows) {
    const site = siteOf(row.sourceUrl)
    const cupMl = cupByRecipe.get(row.recipeId) ?? (site ? cupBySite.get(site) : undefined) ?? US_CUP_ML
    const pair = authorPair(row.rawText, cupMl)
    if (!pair) continue
    const gPerMl = pair.grams / pair.ml
    // Outside anything a kitchen ingredient weighs: a misread line, not a fact.
    if (gPerMl < 0.05 || gPerMl > 2.5) continue
    const sample = { gPerMl, recipeTitle: row.recipeTitle, rawText: row.rawText, site, cupMl }
    const name = parseIngredientLine(row.rawText).name
    const ref = referenceIndex(name)
    const keys = [`name:${key(name)}`]
    if (ref != null) keys.push(`ref:${ref}`)
    if (row.itemId) keys.push(`item:${row.itemId}`)
    for (const k of keys) samples.set(k, [...(samples.get(k) ?? []), sample])
  }
  return { samples, cupByRecipe, cupBySite }
}

/** The cup a recipe means by "1 cup": its own, else its site's, else a US cup. */
export function cupMlFor(recipeId: number, sourceUrl: string | null, library: Library): number {
  const site = siteOf(sourceUrl)
  return library.cupByRecipe.get(recipeId) ?? (site ? library.cupBySite.get(site) : undefined) ?? US_CUP_ML
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function learnedDensity(samples: Sample[], sameSite: boolean): Density {
  if (samples.length === 1) {
    const s = samples[0]!
    const d = describeIngredient(s.rawText)
    // Worth saying only when it was a cup, and not the US one.
    const cup =
      s.cupMl === METRIC_CUP_ML && /\bcups?\b/i.test(d.amount ?? '') ? ' (a 250 ml cup)' : ''
    return {
      gPerMl: s.gPerMl,
      source:
        `From “${s.recipeTitle}”${sameSite && s.site ? ` on ${s.site}` : ''}, whose ` +
        `author weighed ${d.amount}${cup} at ${d.metric}.` +
        (sameSite ? '' : ' USDA doesn’t list it.'),
    }
  }
  const titles = [...new Set(samples.map((s) => s.recipeTitle))]
  const list = `${titles.slice(0, 3).join(', ')}${titles.length > 3 ? '…' : ''}`
  return {
    gPerMl: median(samples.map((s) => s.gPerMl)),
    source: sameSite
      ? `The middle of ${samples.length} weights from ${samples[0]!.site}'s own recipes (${list}).`
      : `The middle of ${samples.length} weights given by recipe authors in your ` +
        `library (${list}). USDA doesn’t list it.`,
  }
}

/** The best measured density for one ingredient line, or null to show nothing. */
export function densityFor(
  line: { rawText: string; itemId: number | null },
  item: { name: string; densityGPerMl: number | null } | null,
  library: Library,
  sourceUrl: string | null,
): Density | null {
  if (item?.densityGPerMl) {
    return {
      gPerMl: item.densityGPerMl,
      source: `The weight you gave ${item.name} in the pantry.`,
    }
  }
  const name = parseIngredientLine(line.rawText).name
  // The line's own words first: they're more specific than the pantry item
  // it resolved to ("brown sugar" may have landed on "sugar").
  const ref = referenceIndex(name) ?? (item ? referenceIndex(item.name) : null)
  const samples =
    (line.itemId ? library.samples.get(`item:${line.itemId}`) : undefined) ??
    (ref != null ? library.samples.get(`ref:${ref}`) : undefined) ??
    library.samples.get(`name:${key(name)}`) ??
    []
  const site = siteOf(sourceUrl)
  const sameSite = site ? samples.filter((s) => s.site === site) : []
  if (sameSite.length > 0) return learnedDensity(sameSite, true)
  if (ref != null) return referenceDensity(ref, line.rawText)
  return samples.length > 0 ? learnedDensity(samples, false) : null
}
