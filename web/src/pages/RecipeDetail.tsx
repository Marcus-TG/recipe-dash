import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { del, patch, post, useFetch } from '../api'
import { RecipeChat } from '../components/RecipeChat'
import { RecipeImage } from '../components/RecipeImage'
import { IngredientLine, noteNumbers, RecipeNotes } from '../components/RecipeText'
import type { IngredientCheck, Recipe, RecipeIngredient, RecipeMatch } from '../types'

type Payload = {
  recipe: Recipe
  match: RecipeMatch | null
  ingredients: RecipeIngredient[]
}

const SOURCE_WORD: Record<string, string> = {
  url: 'page',
  photo: 'photo',
  text: 'pasted text',
}

const VERDICT_WORDS: Record<IngredientCheck['verdict'], string> = {
  have: 'have it',
  short: 'not enough',
  uncertain: 'not sure',
  missing: 'out',
  untracked: 'not tracked',
}

export function RecipeDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading, error, reload } = useFetch<Payload>(`/recipes/${id}`)
  const [fixing, setFixing] = useState<number | null>(null)
  const [fixName, setFixName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [listed, setListed] = useState(false)
  const [confirmReread, setConfirmReread] = useState(false)
  const [rereading, setRereading] = useState(false)
  const [rereadNote, setRereadNote] = useState<string | null>(null)

  // Still being parsed — poll until it lands.
  useEffect(() => {
    if (data?.recipe.status !== 'pending_parse') return
    const timer = setInterval(reload, 4000)
    return () => clearInterval(timer)
  }, [data?.recipe.status, reload])

  const saveFix = async (ingredientId: number) => {
    await patch(`/recipes/${id}/ingredients/${ingredientId}`, {
      itemName: fixName.trim() || null,
    })
    setFixing(null)
    setFixName('')
    reload()
  }

  const addToList = async () => {
    await post('/grocery/list/recipes', { recipeId: Number(id) })
    setListed(true)
  }

  /**
   * Read the recipe from its source again, to pick up what the importer has
   * learned since it came in — notes, the author's metric amounts. A link is
   * fetched while you wait, and a site that refuses leaves the recipe as it was.
   */
  const reread = async () => {
    setConfirmReread(false)
    setRereading(true)
    setRereadNote(null)
    try {
      const res = await post<{ result: 'done' | 'queued' }>(`/recipes/${id}/reread`)
      setRereadNote(
        res.result === 'done'
          ? 'Read it again — this is the fresh copy.'
          : 'forte is reading it again. The new version replaces this one when it’s done.',
      )
      reload()
    } catch (err) {
      setRereadNote((err as Error).message)
    } finally {
      setRereading(false)
    }
  }

  const remove = async () => {
    setDeleteError(null)
    try {
      await del(`/recipes/${id}`)
      navigate('/recipes')
    } catch (err) {
      // This used to fail silently, which looked like a dead button.
      setDeleteError((err as Error).message)
      setConfirmDelete(false)
    }
  }

  if (loading) return <main className="page">Loading…</main>
  if (error || !data)
    return (
      <main className="page">
        <div className="error">{error ?? 'Not found'}</div>
      </main>
    )

  const { recipe, match, ingredients } = data
  const checkByIngredient = new Map(
    (match?.checks ?? []).map((c) => [c.ingredientId, c]),
  )
  const notesByNumber = noteNumbers(recipe.notes)
  const anyEstimate = ingredients.some((i) => i.display.estimate)

  if (recipe.status === 'pending_parse') {
    return (
      <main className="page">
        <Link className="back" to="/recipes">
          ‹ Recipes
        </Link>
        <div className="empty">
          <span className="spinner" />
          <p style={{ marginTop: '1rem' }}>
            Reading the recipe…
            <br />
            <span className="sub">
              If forte is offline this waits patiently and picks up later.
            </span>
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="page">
      <Link className="back" to="/recipes">
        ‹ Recipes
      </Link>
      {/* On desktop this splits: picture on the left, title and actions right.
          With no picture there's nothing to put in the left column, so it
          stays a single stack. */}
      <div className={`detail-head${recipe.thumbnail ? ' has-photo' : ''}`}>
        <div>
          <RecipeImage
            recipeId={recipe.id}
            thumbnail={recipe.thumbnail}
            onChanged={reload}
          />
        </div>

        <div>
          <div className="page-head">
            <div>
              <h1>{recipe.title}</h1>
              <p className="sub">
                {recipe.servings ? `serves ${recipe.servings} · ` : ''}
                {recipe.sourceUrl && (
                  <a href={recipe.sourceUrl} target="_blank" rel="noreferrer">
                    source ›
                  </a>
                )}
              </p>
            </div>
          </div>

          {match && (
            <div className="card">
              <div className="row-between">
                <span className={`chip ${match.verdict}`}>
                  {match.verdict === 'cookable'
                    ? 'You can make this now'
                    : match.verdict === 'check_shelf'
                      ? 'Probably — check the shelf'
                      : `${match.missing.length} thing${match.missing.length === 1 ? '' : 's'} short`}
                </span>
                {match.usesUp.length > 0 && (
                  <span className="chip uses-up">
                    uses up {match.usesUp.join(', ')}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="btn-row">
            <button
              className="btn primary grow"
              onClick={() => navigate(`/recipes/${recipe.id}/cook`)}
            >
              Start cooking
            </button>
            {/* Shopping for several recipes at once is the point: the list
                merges what they all need before subtracting the pantry. */}
            <button
              className="btn"
              disabled={listed}
              onClick={() => void addToList()}
            >
              {listed ? '🛒 On the list' : '🛒 Add to list'}
            </button>
          </div>
          {listed && (
            <p className="sub note">
              <Link to="/shopping">See the shopping list ›</Link>
            </p>
          )}
        </div>
      </div>

      <div className="detail-cols">
        <section className="section">
          <div className="section-label">Ingredients</div>
          {/* One line per ingredient. A recipe's ingredient list is something
              you read at a glance, so the pantry verdict is a coloured dot and
              a short word rather than a chip on a card of its own — the "which
              pantry item is this?" editor opens on tap, for the rare line that
              needs it. */}
          <div className="card" style={{ padding: '0.25rem 0.35rem' }}>
            {ingredients.map((ing, n) => {
              const check = checkByIngredient.get(ing.id)
              const open = fixing === ing.id
              const startsSection =
                ing.section != null && ing.section !== ingredients[n - 1]?.section
              return (
                <div className="ing-row" key={ing.id}>
                  {startsSection && <div className="ing-section">{ing.section}</div>}
                  <button
                    className="ing-tap"
                    onClick={() => {
                      setFixing(open ? null : ing.id)
                      setFixName(ing.itemName ?? '')
                    }}
                  >
                    <span className={`ing-dot ${check?.verdict ?? 'untracked'}`} />
                    <span className="ing-text">
                      <IngredientLine display={ing.display} notes={notesByNumber} />
                    </span>
                  </button>
                  <span className="ing-why">
                    {check ? VERDICT_WORDS[check.verdict] : ''}
                  </span>
                  {open && (
                    <div className="ing-edit">
                      {/* The line is shown rearranged, so the original is
                          here for checking against. */}
                      <p className="sub ing-written">As written: {ing.rawText}</p>
                      {ing.display.estimate && (
                        <p className="sub ing-written">
                          <span className="ing-metric est">{ing.display.metric}</span>{' '}
                          {ing.display.estimate}
                        </p>
                      )}
                      <div className="field">
                        <label>Which pantry item is this?</label>
                        <input
                          type="text"
                          autoFocus
                          value={fixName}
                          placeholder={ing.itemName ?? 'e.g. canned tomatoes'}
                          onChange={(e) => setFixName(e.target.value)}
                        />
                      </div>
                      {check?.detail && (
                        <p className="sub" style={{ marginBottom: '0.6rem' }}>
                          {check.detail}
                        </p>
                      )}
                      <div className="btn-row">
                        <button
                          className="btn primary grow"
                          onClick={() => void saveFix(ing.id)}
                        >
                          Remember this
                        </button>
                        <button
                          className="btn ghost"
                          onClick={() => setFixing(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {anyEstimate && (
            <p className="sub note">
              <span className="ing-metric est">≈</span> is a weight from measured data,
              not from this recipe. Tap a line to see where it came from.
            </p>
          )}
        </section>

        <div>
          {recipe.instructions.length > 0 && (
            <section className="section">
              <div className="section-label">Method</div>
              <div className="card">
                <ol style={{ paddingLeft: '1.1rem' }}>
                  {recipe.instructions.map((step, i) => (
                    <li key={i} style={{ marginBottom: '0.75rem' }}>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          )}

          {recipe.notes.length > 0 && (
            <section className="section">
              <div className="section-label">Notes</div>
              <RecipeNotes notes={recipe.notes} />
            </section>
          )}

          <RecipeChat recipeId={recipe.id} onRevised={reload} />
        </div>
      </div>

      {/* Housekeeping, kept apart from the recipe and from each other. */}
      <div className="detail-foot">
        <div>
          {confirmReread ? (
            <div className="btn-row">
              <button className="btn primary grow" onClick={() => void reread()}>
                Read it again
              </button>
              <button className="btn ghost" onClick={() => setConfirmReread(false)}>
                Keep this version
              </button>
            </div>
          ) : (
            <button
              className="btn ghost block"
              disabled={rereading}
              onClick={() => setConfirmReread(true)}
            >
              {rereading ? 'Reading it again…' : 'Read this recipe again'}
            </button>
          )}
          {confirmReread && (
            <p className="sub note">
              Replaces the ingredients, method and notes with a fresh read of the{' '}
              {SOURCE_WORD[recipe.sourceType] ?? 'source'}, including anything you
              changed with the chat. Pantry matches you fixed are remembered.
            </p>
          )}
          {rereadNote && <p className="sub note">{rereadNote}</p>}
        </div>

        <div>
          {deleteError && <div className="error">{deleteError}</div>}
          {confirmDelete ? (
            <div className="btn-row">
              <button className="btn danger grow" onClick={() => void remove()}>
                Yes, delete “{recipe.title}”
              </button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button
              className="btn ghost danger block"
              onClick={() => setConfirmDelete(true)}
            >
              Delete recipe
            </button>
          )}
        </div>
      </div>
    </main>
  )
}
