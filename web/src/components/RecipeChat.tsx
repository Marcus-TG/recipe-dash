import { useState } from 'react'
import { post } from '../api'

type Turn = { role: 'user' | 'assistant'; content: string }

type Proposal = {
  title: string
  servings: number | null
  ingredients: string[]
  instructions: string[]
}

type ChatResponse = { reply: string; proposal: Proposal | null }

const SUGGESTIONS = [
  'Halve this',
  'What can I substitute?',
  'Make it vegetarian',
  'Simplify the steps',
]

export function RecipeChat({
  recipeId,
  onRevised,
}: {
  recipeId: number
  onRevised: () => void
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [applying, setApplying] = useState(false)

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || busy) return
    setInput('')
    setError(null)
    setProposal(null)
    const history = turns
    setTurns([...history, { role: 'user', content: message }])
    setBusy(true)
    try {
      const res = await post<ChatResponse>(`/recipes/${recipeId}/chat`, {
        message,
        history,
      })
      setTurns((t) => [...t, { role: 'assistant', content: res.reply }])
      if (res.proposal) setProposal(res.proposal)
    } catch (err) {
      setError((err as Error).message)
      setTurns(history)
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!proposal) return
    setApplying(true)
    try {
      await post(`/recipes/${recipeId}/revise`, proposal)
      setProposal(null)
      setTurns((t) => [
        ...t,
        { role: 'assistant', content: '✓ Recipe updated.' },
      ])
      onRevised()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setApplying(false)
    }
  }

  return (
    <section className="section">
      <div className="section-label">Ask about this recipe</div>

      {turns.length === 0 && (
        <div className="btn-row" style={{ marginBottom: '0.75rem' }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="btn ghost"
              style={{ minHeight: 40, fontSize: '0.9rem' }}
              onClick={() => void send(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {turns.map((turn, i) => (
        <div
          className="card"
          key={i}
          style={
            turn.role === 'user'
              ? { background: 'var(--surface-2)', marginLeft: '2rem' }
              : { marginRight: '2rem' }
          }
        >
          <span className="sub">{turn.role === 'user' ? 'You' : 'Larder'}</span>
          <p style={{ whiteSpace: 'pre-wrap' }}>{turn.content}</p>
        </div>
      ))}

      {busy && (
        <p className="muted" style={{ padding: '0.5rem 0' }}>
          <span className="spinner" /> thinking…
        </p>
      )}
      {error && <div className="error">{error}</div>}

      {proposal && (
        <div className="card">
          <h2>Proposed version</h2>
          <p className="sub">
            {proposal.title}
            {proposal.servings ? ` · serves ${proposal.servings}` : ''}
          </p>
          <div style={{ margin: '0.6rem 0' }}>
            {proposal.ingredients.map((line, i) => (
              <p key={i} className="sub">
                • {line}
              </p>
            ))}
          </div>
          <div className="btn-row">
            <button
              className="btn primary grow"
              disabled={applying}
              onClick={() => void apply()}
            >
              {applying ? <span className="spinner" /> : 'Replace the recipe with this'}
            </button>
            <button className="btn ghost" onClick={() => setProposal(null)}>
              Keep original
            </button>
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: '0.5rem' }}>
        <input
          className="grow"
          type="text"
          value={input}
          placeholder="Can I use butter instead?"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send(input)}
        />
        <button
          className="btn primary"
          disabled={busy || !input.trim()}
          onClick={() => void send(input)}
        >
          Ask
        </button>
      </div>
    </section>
  )
}
