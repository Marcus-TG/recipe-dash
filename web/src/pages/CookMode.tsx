import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { post, useFetch } from '../api'
import { IngredientLine, noteNumbers, RecipeNotes } from '../components/RecipeText'
import type { Recipe, RecipeIngredient } from '../types'
import { useKeepAwake } from '../useKeepAwake'

type Payload = { recipe: Recipe; ingredients: RecipeIngredient[] }

/**
 * Full-screen, huge type, screen stays on, prev/next as bottom thumb zones.
 * No inventory interaction while cooking — that happens afterwards.
 */
export function CookMode() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading } = useFetch<Payload>(`/recipes/${id}`)
  const [step, setStep] = useState(-1) // -1 = the ingredients page
  const [finishing, setFinishing] = useState(false)
  useKeepAwake(true)

  const finish = async () => {
    setFinishing(true)
    try {
      const session = await post<{ id: number }>('/cook-sessions', {
        recipeId: Number(id),
      })
      navigate(`/cook/${session.id}/confirm`)
    } catch {
      setFinishing(false)
    }
  }

  if (loading || !data) return <main className="page">Loading…</main>

  const steps = data.recipe.instructions
  const notesByNumber = noteNumbers(data.recipe.notes)
  const atEnd = step >= steps.length - 1
  const total = steps.length

  return (
    <div className="cook">
      <div className="cook-head">
        <button
          className="btn ghost"
          style={{ minHeight: 40 }}
          onClick={() => navigate(`/recipes/${id}`)}
        >
          ✕ Exit
        </button>
        <span>
          {step < 0 ? 'Ingredients' : `Step ${step + 1} of ${total}`} · screen stays on
        </span>
      </div>

      <div className="cook-step">
        {step < 0 ? (
          <div className="cook-ings grow">
            <h1 style={{ marginBottom: '0.75rem' }}>{data.recipe.title}</h1>
            {data.ingredients.map((ing, n) => (
              <div key={ing.id}>
                {ing.section != null && ing.section !== data.ingredients[n - 1]?.section && (
                  <div className="ing-section" style={{ marginTop: n > 0 ? '0.9rem' : 0 }}>
                    {ing.section}
                  </div>
                )}
                <p className="cook-ing">
                  <IngredientLine display={ing.display} notes={notesByNumber} />
                </p>
              </div>
            ))}
            {/* Read before starting: "any potato works", "Note 1" for the line above. */}
            {data.recipe.notes.length > 0 && (
              <>
                <div className="ing-section" style={{ marginTop: '1.5rem' }}>
                  Notes
                </div>
                <RecipeNotes notes={data.recipe.notes} />
              </>
            )}
          </div>
        ) : (
          <p>{steps[step]}</p>
        )}
      </div>

      <div className="cook-tap">
        <button onClick={() => setStep((s) => Math.max(-1, s - 1))} disabled={step < 0}>
          ‹ Back
        </button>
        {atEnd && total > 0 ? (
          <button className="next" disabled={finishing} onClick={() => void finish()}>
            {finishing ? '…' : 'Done cooking'}
          </button>
        ) : (
          <button className="next" onClick={() => setStep((s) => s + 1)}>
            {step < 0 ? 'Start ›' : 'Next ›'}
          </button>
        )}
      </div>
    </div>
  )
}
