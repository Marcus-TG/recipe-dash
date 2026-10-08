import { useState } from 'react'
import { patch } from '../api'

/**
 * Your own notes on a recipe — what you changed, what to try next time.
 * Separate from the author's notes so reading the recipe again, which
 * replaces everything the author wrote, never touches what you wrote.
 */
export function MyNotes({
  recipeId,
  value,
  onSaved,
}: {
  recipeId: number
  value: string | null
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await patch(`/recipes/${recipeId}`, { myNotes: draft.trim() || null })
      setEditing(false)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const start = () => {
    setDraft(value ?? '')
    setEditing(true)
  }

  return (
    <section className="section">
      <div className="section-label">My notes</div>
      {editing ? (
        <>
          <textarea
            className="my-notes-input"
            autoFocus
            rows={Math.max(4, draft.split('\n').length + 1)}
            value={draft}
            placeholder="Used 1½× the garlic. Needed 5 more minutes."
            onChange={(e) => setDraft(e.target.value)}
          />
          {error && <div className="error">{error}</div>}
          <div className="btn-row">
            <button className="btn primary grow" disabled={saving} onClick={() => void save()}>
              {saving ? <span className="spinner" /> : 'Save'}
            </button>
            <button className="btn ghost" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : value ? (
        <button className="card my-notes" onClick={start}>
          <p>{value}</p>
          <span className="sub">Tap to change</span>
        </button>
      ) : (
        <button className="card my-notes empty-notes" onClick={start}>
          <span>+ Add your own notes</span>
          <span className="sub">
            What you changed, what to try next time. Kept when the recipe is read again.
          </span>
        </button>
      )}
    </section>
  )
}
