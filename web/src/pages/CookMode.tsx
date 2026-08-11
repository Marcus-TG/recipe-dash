import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { post, useFetch } from '../api'
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
            {data.ingredients.map((ing) => (
              <p key={ing.id} style={{ fontSize: '1.15rem', padding: '0.35rem 0' }}>
                • {ing.rawText}
              </p>
            ))}
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
