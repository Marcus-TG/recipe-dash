import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { del, post, useFetch } from '../api'
import type { ItemView, LedgerEvent } from '../types'

type Payload = {
  item: { id: number; name: string; category: string; unitFamily: string }
  view: ItemView
  ledger: LedgerEvent[]
}

const EVENT_WORDS: Record<string, string> = {
  purchase: 'bought',
  consume: 'used',
  spoilage: 'threw out',
  adjust_delta: 'adjusted',
  snapshot: 'you said',
}

function when(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ItemDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading, error, reload } = useFetch<Payload>(`/items/${id}`)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const say = async (level: 'plenty' | 'some' | 'low' | 'out') => {
    await post(`/items/${id}/events`, { type: 'snapshot', level })
    reload()
  }

  const remove = async () => {
    setDeleteError(null)
    try {
      await del(`/items/${id}`)
      navigate('/pantry')
    } catch (err) {
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

  const { view, ledger } = data

  return (
    <main className="page">
      <Link className="back" to="/pantry">
        ‹ Pantry
      </Link>
      <div className="page-head">
        <div>
          <h1>{view.name}</h1>
          <p className="sub">
            <span className={`chip ${view.level}`}>{view.levelLabel}</span>{' '}
            {view.lastConfirmedLabel
              ? `last confirmed ${view.lastConfirmedLabel}`
              : 'never confirmed by you'}
          </p>
        </div>
      </div>

      <div className="card">
        <h2>How much is there really?</h2>
        <p className="sub" style={{ marginBottom: '0.75rem' }}>
          One tap. This overrides everything below and resets the clock.
        </p>
        <div className="seg">
          <button onClick={() => void say('plenty')}>Plenty</button>
          <button onClick={() => void say('some')}>Some</button>
          <button onClick={() => void say('low')}>Low</button>
          <button className="on bad" onClick={() => void say('out')}>
            Out
          </button>
        </div>
      </div>

      <section className="section">
        <div className="section-label">Why it thinks that</div>
        <div className="card">
          {ledger.length === 0 && <p className="muted">Nothing recorded yet.</p>}
          {ledger.map((e) => (
            <div className="ledger-item" key={e.id}>
              <span className="ledger-when">{when(e.occurredAt)}</span>
              <span className="grow">
                <strong>{EVENT_WORDS[e.type] ?? e.type}</strong>{' '}
                {e.level
                  ? e.level
                  : e.quantity != null
                    ? `${e.quantity} ${e.unit ?? ''}`
                    : 'some'}
                {e.source && (
                  <>
                    <br />
                    <span className="raw">
                      {e.source.kind === 'receipt' ? '🧾 ' : '🍳 '}
                      {e.source.label}
                    </span>
                  </>
                )}
                {e.note && (
                  <>
                    <br />
                    <span className="sub">{e.note}</span>
                  </>
                )}
              </span>
              {e.source?.receiptId && (
                <Link className="sub" to={`/inbox/${e.source.receiptId}`}>
                  receipt ›
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {deleteError && <div className="error">{deleteError}</div>}

      {confirmDelete ? (
        <div className="btn-row">
          <button className="btn danger grow" onClick={() => void remove()}>
            Yes, delete {view.name} and its history
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
          Delete this item
        </button>
      )}
    </main>
  )
}
