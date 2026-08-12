import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { del, patch, useFetch } from '../api'
import { RecipeChat } from '../components/RecipeChat'
import type { IngredientCheck, Recipe, RecipeIngredient, RecipeMatch } from '../types'

type Payload = {
  recipe: Recipe
  match: RecipeMatch | null
  ingredients: RecipeIngredient[]
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
              <span className="chip uses-up">uses up {match.usesUp.join(', ')}</span>
            )}
          </div>
        </div>
      )}

      <button
        className="btn primary block"
        onClick={() => navigate(`/recipes/${recipe.id}/cook`)}
      >
        Start cooking
      </button>

      <section className="section">
        <div className="section-label">Ingredients</div>
        {ingredients.map((ing) => {
          const check = checkByIngredient.get(ing.id)
          return (
            <div className="card" key={ing.id}>
              <div className="row-between">
                <span className="grow">{ing.rawText}</span>
                {check && (
                  <span className={`chip ${check.verdict}`}>
                    {VERDICT_WORDS[check.verdict]}
                  </span>
                )}
              </div>
              {check?.detail && <p className="sub">{check.detail}</p>}

              {fixing === ing.id ? (
                <div style={{ marginTop: '0.6rem' }}>
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
                  <div className="btn-row">
                    <button
                      className="btn primary grow"
                      onClick={() => void saveFix(ing.id)}
                    >
                      Remember this
                    </button>
                    <button className="btn ghost" onClick={() => setFixing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn ghost"
                  style={{ marginTop: '0.5rem', minHeight: 40 }}
                  onClick={() => {
                    setFixing(ing.id)
                    setFixName(ing.itemName ?? '')
                  }}
                >
                  {ing.itemId ? `→ ${ing.itemName}` : 'Link to a pantry item'}
                </button>
              )}
            </div>
          )
        })}
      </section>

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

      <RecipeChat recipeId={recipe.id} onRevised={reload} />

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
    </main>
  )
}
