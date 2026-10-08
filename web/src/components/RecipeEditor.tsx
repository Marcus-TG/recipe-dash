import { useLayoutEffect, useRef, useState } from 'react'
import { post } from '../api'
import type { Recipe, RecipeIngredient } from '../types'

/**
 * The ingredient list as text, the way it would be typed: one line each, with
 * a group's heading written back as "For the frosting:" style lines so saving
 * folds them into sections again.
 */
function ingredientText(ingredients: RecipeIngredient[]): string {
  const lines: string[] = []
  let section: string | null = null
  for (const ing of ingredients) {
    if (ing.section && ing.section !== section) lines.push(`${ing.section}:`)
    section = ing.section
    lines.push(ing.rawText)
  }
  return lines.join('\n')
}

const toLines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/**
 * A text box that grows with what's in it, so the whole list is visible and
 * there's only ever one thing scrolling — the page.
 */
function GrowingTextarea({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (value: string) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      id={id}
      rows={4}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/**
 * Edit mode: the recipe as plain text boxes, saved in one go. Plain text on
 * purpose — it handles a one-word fix and a rewrite the same way, and it's
 * the format the importer already reads, so "1/3 cup (50 g) flour" typed here
 * shows its grams exactly like an imported line.
 */
export function RecipeEditor({
  recipe,
  ingredients,
  onSaved,
  onCancel,
}: {
  recipe: Recipe
  ingredients: RecipeIngredient[]
  onSaved: () => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(recipe.title)
  const [servings, setServings] = useState(recipe.servings ? String(recipe.servings) : '')
  const [ings, setIngs] = useState(() => ingredientText(ingredients))
  // A blank line between steps, so one that wraps onto three lines is still
  // easy to tell from the next. Blank lines are dropped on save.
  const [steps, setSteps] = useState(recipe.instructions.join('\n\n'))
  const [notes, setNotes] = useState(recipe.notes.join('\n\n'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!title.trim()) return setError('It needs a title.')
    if (toLines(ings).length === 0) return setError('It needs at least one ingredient.')
    const serves = Number(servings)
    setSaving(true)
    setError(null)
    try {
      await post(`/recipes/${recipe.id}/revise`, {
        title: title.trim(),
        servings: servings.trim() && serves > 0 ? Math.round(serves) : null,
        ingredients: toLines(ings),
        instructions: toLines(steps),
        notes: toLines(notes),
      })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="editor">
      <h1>Edit recipe</h1>

      <div className="editor-head">
        <div className="field grow">
          <label htmlFor="edit-title">Title</label>
          <input
            id="edit-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field editor-serves">
          <label htmlFor="edit-serves">Serves</label>
          <input
            id="edit-serves"
            type="number"
            inputMode="numeric"
            min={1}
            value={servings}
            onChange={(e) => setServings(e.target.value)}
          />
        </div>
      </div>

      <div className="detail-cols">
        <section className="section">
          <div className="field">
            <label htmlFor="edit-ings">Ingredients, one per line</label>
            <GrowingTextarea id="edit-ings" value={ings} onChange={setIngs} />
          </div>
          <p className="sub">
            Write both measures as <code>1/3 cup (50 g) flour</code> and the grams
            show beside the cup. A line ending in a colon, like{' '}
            <code>For the frosting:</code>, starts a group.
          </p>
        </section>

        <div>
          <section className="section">
            <div className="field">
              <label htmlFor="edit-steps">Method, each step on its own line</label>
              <GrowingTextarea id="edit-steps" value={steps} onChange={setSteps} />
            </div>
          </section>
          <section className="section">
            <div className="field">
              <label htmlFor="edit-notes">Recipe notes, each on its own line</label>
              <GrowingTextarea id="edit-notes" value={notes} onChange={setNotes} />
            </div>
            <p className="sub">
              Start a line with a number, like <code>1. Potato – any kind works</code>,
              and ingredient lines that say “Note 1” will link to it.
            </p>
          </section>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {/* Stays in reach at the bottom of the screen: the boxes above are long. */}
      <div className="btn-row editor-actions">
        <button className="btn primary grow" disabled={saving} onClick={() => void save()}>
          {saving ? <span className="spinner" /> : 'Save changes'}
        </button>
        <button className="btn ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
