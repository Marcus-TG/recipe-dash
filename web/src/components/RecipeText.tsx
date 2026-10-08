import type { ReactNode } from 'react'
import type { IngredientDisplay, RecipeIngredient, StepSegment } from '../types'

// "1. Potato – any potato works": the author's own number, kept, because
// ingredient lines refer to it ("cubed (Note 1)").
const NUMBERED = /^(\d+)[.)]\s+(.*)$/
// "Potato – …", "STORAGE: …" — a short lead-in the author set off from the rest.
const LEAD_IN = /^([^.]{2,40}?)(\s[–—-]\s|:\s)(.+)$/

function splitNote(note: string) {
  const numbered = note.match(NUMBERED)
  const number = numbered ? Number(numbered[1]) : null
  const body = numbered ? numbered[2]! : note
  const lead = body.match(LEAD_IN)
  return lead
    ? { number, lead: lead[1]!, rest: lead[3]! }
    : { number, lead: null, rest: body }
}

/** The note numbers that actually exist, so "Note 7" only links when there's a note 7. */
export function noteNumbers(notes: string[]): Set<number> {
  return new Set(
    notes.map((n) => splitNote(n).number).filter((n): n is number => n != null),
  )
}

export function jumpToNote(n: number) {
  const el = document.getElementById(`note-${n}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1600)
}

/** "(Note 1)" in an ingredient line becomes a tap that scrolls to note 1. */
function withNoteRefs(text: string, known: Set<number>): ReactNode {
  if (known.size === 0) return text
  return text.split(/(Note\s+\d+)/i).map((part, i) => {
    const n = Number(part.match(/^Note\s+(\d+)$/i)?.[1])
    if (!known.has(n)) return part
    return (
      // A span, not a link: the whole row is already a button.
      <span
        key={i}
        className="note-ref"
        onClick={(e) => {
          e.stopPropagation()
          jumpToNote(n)
        }}
      >
        {part}
      </span>
    )
  })
}

/**
 * One ingredient line: the amount as the recipe measures it, the scale
 * reading beside it in the same place on every line, then the ingredient and
 * its aside. An estimated reading is styled apart from the recipe's own.
 */
export function IngredientLine({
  display,
  notes,
}: {
  display: IngredientDisplay
  notes: Set<number>
}) {
  const { amount, metric, estimate, text, note } = display
  return (
    <>
      {/* Real spaces between the parts, not just margins, so copied text and
          screen readers get "1 cup 90 g frozen peas", not "1 cup90 g". */}
      {amount && <span className="ing-amount">{amount}</span>}{' '}
      {metric && (
        <>
          <span className={`ing-metric${estimate ? ' est' : ''}`}>{metric}</span>{' '}
        </>
      )}
      {withNoteRefs(text, notes)}
      {note && (
        <span className="ing-note">
          {note.startsWith('(') ? ' ' : ', '}
          {withNoteRefs(note, notes)}
        </span>
      )}
    </>
  )
}

/**
 * A method step with each ingredient's amount where it goes in: "Melt butter
 * [3 tbsp · 40 g] in a large pot". The amount is set apart from the
 * author's words, because it's ours, not theirs.
 */
export function StepText({
  segments,
  text,
  ingredients,
  notes,
}: {
  segments: StepSegment[] | undefined
  text: string
  ingredients: RecipeIngredient[]
  // "Read Note 4 regarding shelf positions" links like an ingredient line does.
  notes: Set<number>
}) {
  if (!segments) return <>{withNoteRefs(text, notes)}</>
  return (
    <>
      {segments.map((seg, i) => {
        const ing = seg.ingredientId
          ? ingredients.find((x) => x.id === seg.ingredientId)
          : undefined
        if (!ing?.display.amount) return <span key={i}>{withNoteRefs(seg.text, notes)}</span>
        const { amount, metric, estimate } = ing.display
        return (
          <span key={i}>
            {seg.text}{' '}
            <span className="step-amt">
              {amount}
              {metric && (
                <span className={estimate ? 'est' : 'scale'}> · {metric}</span>
              )}
            </span>
          </span>
        )
      })}
    </>
  )
}

/** The recipe card's own notes, under the method — numbered the author's way. */
export function RecipeNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null
  // When the author numbered them, every paragraph hangs off the same indent,
  // so an unnumbered follow-on reads as part of the note above it.
  const numbered = notes.some((n) => NUMBERED.test(n))
  return (
    <div className={`card notes${numbered ? ' numbered' : ''}`}>
      {notes.map((note, i) => {
        // "OTHER PANS (use same oven temp):" — a sub-heading inside the notes.
        if (/:$/.test(note) && note.length < 60) {
          return (
            <p key={i} className="notes-head">
              {note.replace(/:$/, '')}
            </p>
          )
        }
        const { number, lead, rest } = splitNote(note)
        return (
          <p key={i} id={number != null ? `note-${number}` : undefined}>
            {number != null && <span className="notes-num">{number}</span>}
            {lead && <strong>{lead} – </strong>}
            {rest}
          </p>
        )
      })}
    </div>
  )
}
