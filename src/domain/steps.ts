// Putting each ingredient's amount where the method first uses it, so "Melt
// butter in a large pot" reads "Melt butter [3 tbsp · 40 g] in a large pot"
// and nobody scrolls back up to the list with batter on their hands.
//
// Matched by the food words, deterministically — never a model. Worked out
// on every read and never written into the method, so editing either the
// ingredients or the steps keeps it right. When a mention could be either of
// two ingredients, or the step already says how much, nothing is added: a
// missing amount costs a glance at the list, a wrong one costs the dish.

import {
  describeIngredient,
  foodTokens,
  normalizeItemName,
  parseIngredientLine,
  singularize,
} from './text.js'

export type StepSegment = { text: string; ingredientId?: number }

// The part of a food rather than the food: "garlic cloves" is garlic,
// "chicken thighs" is chicken. The word before them is what a step says.
const PART_WORDS = new Set([
  'clove', 'floret', 'leaf', 'sprig', 'stalk', 'stem', 'piece', 'slice',
  'head', 'bunch', 'wedge', 'breast', 'thigh', 'drumstick', 'wing', 'fillet',
  'filet', 'tenderloin', 'chop', 'strip', 'cube', 'chunk', 'rib',
])

// Heads too vague to stand alone: "the sauce" in a step is usually the one
// you're making, not the soy sauce. These only match with the word before.
const VAGUE_HEADS = new Set([
  'sauce', 'paste', 'powder', 'juice', 'extract', 'seed', 'flake',
  'seasoning', 'mix', 'base', 'zest', 'stock', 'broth',
])

// Joining words, never part of what identifies an ingredient.
const JOINERS = new Set(['and', 'or', 'of', 'the', 'with', 'for', 'to', 'in'])

// "Cool completely before frosting": an action, not the frosting going in.
const WHEN_WORDS = new Set(['before', 'after', 'while', 'when', 'until'])

// Ingredients that are also verbs: "Cream the butter", "flour the pan".
const VERBS = new Set(['cream', 'butter', 'flour', 'oil', 'salt', 'pepper', 'zest', 'juice'])
const AFTER_A_VERB = new Set(['the', 'a', 'an', 'your', 'it', 'them', 'well', 'lightly', 'generously'])

// The step already says how much: "Add 1/2 cup of milk", "add half the butter".
const AMOUNT_BEFORE = /(?:\d|[½⅓⅔¼¾⅛])[\d/.,\s]*(?:[a-z.]+\s+)?(?:of\s+)?(?:the\s+)?$/i
const PORTION_BEFORE =
  /\b(?:half|remaining|rest|some|part|portion|more|extra|reserved|another|little|bit|splash|pinch|dash|drizzle|handful)\b(?:\s+of)?(?:\s+the)?\s*$/i

// A comma or full stop between two words ends any match: "garlic powder,
// onion powder" is two ingredients, not one long one.
type Word = { start: number; end: number; key: string; breakBefore: boolean }

function wordKey(word: string): string {
  return singularize(normalizeItemName(word.replace(/['’]/g, '')).replace(/\s+/g, ''))
}

function wordsOf(step: string): Word[] {
  let last = 0
  return [...step.matchAll(/\p{L}[\p{L}'’-]*/gu)].map((m) => {
    const word = {
      start: m.index!,
      end: m.index! + m[0].length,
      key: wordKey(m[0]),
      breakBefore: /[,.;:!?()]/.test(step.slice(last, m.index)),
    }
    last = word.end
    return word
  })
}

type Matcher = {
  id: number
  tokens: Set<string>
  heads: Set<string>
  // For a vague head, the word that has to come with it ("soy" for sauce).
  modifier: string | null
}

/** The word a step would call this food by, skipping "cloves", "breasts". */
function headOf(tokens: string[]): { head: string; before: string | null } | null {
  let h = tokens.length - 1
  while (h > 0 && PART_WORDS.has(tokens[h]!)) h--
  return h >= 0 ? { head: tokens[h]!, before: h > 0 ? tokens[h - 1]! : null } : null
}

function matcherFor(line: { id: number; rawText: string }): Matcher | null {
  // Two readings of the name: the pantry parse cuts at the first comma
  // ("grated cheese, cheddar or tasty" → grated cheese), the display one
  // doesn't ("boneless, skinless chicken breasts"). Either may be what the
  // method calls it.
  const names = [parseIngredientLine(line.rawText).name, describeIngredient(line.rawText).text]
  const tokens = new Set<string>()
  const heads = new Set<string>()
  let modifier: string | null = null
  for (const name of names) {
    const words = foodTokens(name).filter((t) => !JOINERS.has(t))
    for (const w of words) tokens.add(w)
    const found = headOf(words)
    if (!found) continue
    heads.add(found.head)
    if (VAGUE_HEADS.has(found.head) && found.before) modifier = found.before
  }
  // "chicken broth/stock", "shallots/scallions": either word is the food.
  for (const m of names[1]!.matchAll(/([\p{L}-]+)\s*\/\s*([\p{L}-]+)/gu)) {
    heads.add(wordKey(m[1]!))
    heads.add(wordKey(m[2]!))
    modifier = null
  }
  if (tokens.size === 0) return null
  return { id: line.id, tokens, heads, modifier }
}

// Word indexes, inclusive. `named` is whether the match includes the head.
type Mention = { id: number; from: number; to: number; named: boolean }

function mentionsIn(words: Word[], matchers: Matcher[]): Mention[] {
  const found: Mention[] = []
  const joins = (i: number, m: Matcher) => !words[i]!.breakBefore && m.tokens.has(words[i]!.key)
  for (const m of matchers) {
    for (let i = 0; i < words.length; i++) {
      if (!m.tokens.has(words[i]!.key) || (i > 0 && joins(i, m) && m.tokens.has(words[i - 1]!.key))) {
        continue
      }
      let j = i
      while (j + 1 < words.length && joins(j + 1, m)) j++
      const run = words.slice(i, j + 1).map((w) => w.key)
      const named = run.some((k) => m.heads.has(k))
      // A vague head needs its modifier ("soy sauce", never just "sauce"),
      // and the modifier alone will do ("cocoa" for cocoa powder).
      if (m.modifier ? !run.includes(m.modifier) : !named) continue
      found.push({ id: m.id, from: i, to: j, named })
    }
  }
  // Where two ingredients claim overlapping words, the longer match wins
  // ("garlic powder" over "garlic"), then the one the step calls by its own
  // name ("garlic" is the garlic, not the garlic powder). An even contest is
  // a mention we can't attribute, so neither gets it.
  const overlaps = (a: Mention, b: Mention) => a.from <= b.to && b.from <= a.to
  const beats = (a: Mention, b: Mention) =>
    a.to - a.from > b.to - b.from || (a.to - a.from === b.to - b.from && a.named && !b.named)
  return found.filter((a) =>
    found.every((b) => b === a || b.id === a.id || !overlaps(a, b) || beats(a, b)),
  )
}

/**
 * Split each step into plain text and ingredient mentions. Only the first
 * mention across the whole method is marked — that's where the ingredient
 * goes in; later ones ("until the onion softens") are just references.
 */
export function linkSteps(
  steps: string[],
  ingredients: { id: number; rawText: string; hasAmount: boolean }[],
): StepSegment[][] {
  const matchers = ingredients
    // An amount split across steps ("divided") has no single number to show.
    .filter((i) => i.hasAmount && !/\bdivided\b/i.test(i.rawText))
    .map(matcherFor)
    .filter((m): m is Matcher => m != null)
  const done = new Set<number>()

  return steps.map((step) => {
    const words = wordsOf(step)
    const marks: { at: number; id: number }[] = []
    const mentions = mentionsIn(words, matchers).sort((a, b) => a.from - b.from)
    for (const mention of mentions) {
      if (done.has(mention.id)) continue
      const first = words[mention.from]!
      const last = words[mention.to]!
      const next = words[mention.to + 1]
      const prev = words[mention.from - 1]
      // "Cream the butter", "before frosting": doing, not the ingredient going in.
      if (mention.from === mention.to && VERBS.has(first.key) && next && AFTER_A_VERB.has(next.key)) {
        continue
      }
      if (prev && !first.breakBefore && WHEN_WORDS.has(prev.key)) continue
      done.add(mention.id)
      const before = step.slice(Math.max(0, first.start - 30), first.start)
      if (AMOUNT_BEFORE.test(before) || PORTION_BEFORE.test(before)) continue
      marks.push({ at: last.end, id: mention.id })
    }

    const segments: StepSegment[] = []
    let from = 0
    for (const mark of marks) {
      const mention = mentions.find((m) => words[m.to]!.end === mark.at && m.id === mark.id)!
      const start = words[mention.from]!.start
      if (start > from) segments.push({ text: step.slice(from, start) })
      segments.push({ text: step.slice(start, mark.at), ingredientId: mark.id })
      from = mark.at
    }
    if (from < step.length) segments.push({ text: step.slice(from) })
    return segments
  })
}
