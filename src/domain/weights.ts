// What a cup of something weighs, for the recipes that only say "1 cup".
//
// Never a model's guess. An estimate has to come from something that was
// actually measured, and it says which:
//
//   1. a density you set on the pantry item yourself;
//   2. recipe authors in your own library who gave both measures — every
//      "1/3 cup (50 g) flour" is someone weighing a third of a cup of flour;
//   3. USDA's measured cup weights (cup-weights.ts).
//
// Your library outranks USDA once two or more of its recipes agree — they're
// written the way the recipes you follow are written — but one author's
// rounded "3 tbsp = 40 g" doesn't overrule a lab's measurement on its own.
// For something USDA doesn't list, one recipe is better than nothing. Nothing
// here is stored — it's worked out on each read from the lines already in the
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
  parseIngredientLine,
} from './text.js'

const US_CUP_ML = 236.588

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

type Sample = { gPerMl: number; recipeTitle: string; rawText: string }

export type Learned = Map<string, Sample[]>

/**
 * Every line where an author gave a volume and a weight together is a
 * measurement. Filed under the pantry item the line resolved to, under the
 * USDA entry its name means — so "plain flour" and "all-purpose flour" pool
 * — and under its own food words, for things USDA doesn't list.
 */
export function learnDensities(
  rows: { rawText: string; itemId: number | null; recipeTitle: string }[],
): Learned {
  const learned: Learned = new Map()
  for (const row of rows) {
    const pair = authorPair(row.rawText)
    if (!pair) continue
    const gPerMl = pair.grams / pair.ml
    // Outside anything a kitchen ingredient weighs: a misread line, not a fact.
    if (gPerMl < 0.05 || gPerMl > 2.5) continue
    const sample = { gPerMl, recipeTitle: row.recipeTitle, rawText: row.rawText }
    const name = parseIngredientLine(row.rawText).name
    const ref = referenceIndex(name)
    const keys = [`name:${key(name)}`]
    if (ref != null) keys.push(`ref:${ref}`)
    if (row.itemId) keys.push(`item:${row.itemId}`)
    for (const k of keys) learned.set(k, [...(learned.get(k) ?? []), sample])
  }
  return learned
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function learnedDensity(samples: Sample[]): Density {
  if (samples.length === 1) {
    const s = samples[0]!
    const d = describeIngredient(s.rawText)
    return {
      gPerMl: s.gPerMl,
      source: `From “${s.recipeTitle}”, whose author weighed ${d.amount} at ${d.metric}.`,
    }
  }
  const titles = [...new Set(samples.map((s) => s.recipeTitle))]
  return {
    gPerMl: median(samples.map((s) => s.gPerMl)),
    source:
      `The middle of ${samples.length} weights given by recipe authors in your ` +
      `library (${titles.slice(0, 3).join(', ')}${titles.length > 3 ? '…' : ''}).`,
  }
}

/** The best measured density for one ingredient line, or null to show nothing. */
export function densityFor(
  line: { rawText: string; itemId: number | null },
  item: { name: string; densityGPerMl: number | null } | null,
  learned: Learned,
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
    (line.itemId ? learned.get(`item:${line.itemId}`) : undefined) ??
    (ref != null ? learned.get(`ref:${ref}`) : undefined) ??
    learned.get(`name:${key(name)}`) ??
    []
  const recipes = new Set(samples.map((s) => s.recipeTitle)).size
  if (recipes >= 2 || (samples.length > 0 && ref == null)) return learnedDensity(samples)
  return ref != null ? referenceDensity(ref, line.rawText) : null
}
