import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { del, post, useFetch } from '../api'
import type { CookLine, Recipe } from '../types'

type Payload = { session: { id: number }; recipe: Recipe | null; lines: CookLine[] }

type Action = 'used' | 'used_less' | 'used_more' | 'not_used' | 'didnt_have'

const OPTIONS: { value: Action; label: string; tone?: string }[] = [
  { value: 'used', label: 'Used' },
  { value: 'used_less', label: 'Less' },
  { value: 'not_used', label: 'Didn’t' },
  { value: 'didnt_have', label: 'Was out', tone: 'bad' },
]

export function CookConfirm() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const { data, loading } = useFetch<Payload>(`/cook-sessions/${sessionId}`)
  const [actions, setActions] = useState<Record<number, Action>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!data) return
    const seeded: Record<number, Action> = {}
    for (const line of data.lines) {
      seeded[line.id] = (line.action as Action) ?? 'used'
    }
    setActions(seeded)
  }, [data])

  const confirm = async () => {
    setSaving(true)
    try {
      await post(`/cook-sessions/${sessionId}/confirm`, {
        lines: Object.entries(actions).map(([id, action]) => ({
          id: Number(id),
          action,
        })),
      })
      navigate('/pantry')
    } finally {
      setSaving(false)
    }
  }

  const skip = async () => {
    await del(`/cook-sessions/${sessionId}`)
    navigate('/')
  }

  if (loading || !data) return <main className="page">Loading…</main>

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>What did you use?</h1>
          <p className="sub">
            Everything’s already set to “used” — just fix what’s wrong and confirm.
          </p>
        </div>
      </div>

      {data.lines.map((line) => (
        <div className="card" key={line.id}>
          <div className="row-between">
            <span className="grow">{line.label}</span>
            {!line.itemId && <span className="chip untracked">not tracked</span>}
          </div>
          {line.itemId && (
            <div className="seg" style={{ marginTop: '0.6rem' }}>
              {OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={
                    actions[line.id] === opt.value
                      ? `on ${opt.tone ?? ''}`.trim()
                      : ''
                  }
                  onClick={() =>
                    setActions((a) => ({ ...a, [line.id]: opt.value }))
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      <div className="stack" style={{ marginTop: '1rem' }}>
        <button
          className="btn primary block"
          disabled={saving}
          onClick={() => void confirm()}
        >
          {saving ? <span className="spinner" /> : 'Confirm and update the pantry'}
        </button>
        <button className="btn ghost block" onClick={() => void skip()}>
          Skip — don’t record anything
        </button>
      </div>
    </main>
  )
}
