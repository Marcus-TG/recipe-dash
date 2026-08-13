import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { del, patch, post, useFetch } from '../api'
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
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)

  const say = async (level: 'plenty' | 'some' | 'low' | 'out') => {
    await post(`/items/${id}/events`, { type: 'snapshot', level })
    reload()
  }

  const rename = async () => {
    setRenameError(null)
    try {
      const res = await patch<Payload>(`/items/${id}`, { name: draftName })
      setRenaming(false)
      // A rename onto an existing name merges the two, and the survivor may
      // not be the item we were looking at.
      if (String(res.item.id) !== id) navigate(`/pantry/${res.item.id}`)
      else reload()
    } catch (err) {
      setRenameError((err as Error).message)
    }
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

      {renaming ? (
        <div className="card">
          <h2>What is this, generically?</h2>
          <p className="sub" style={{ marginBottom: '0.75rem' }}>
            Recipes ask for “gnocchi”, not “vita sana potato gnocchi”. Drop the
            brand and the pack size and recipes will start finding it. If
            something else already has that name, the two get merged and both
            histories are kept.
          </p>
          {renameError && <div className="error">{renameError}</div>}
          <input
            type="text"
            value={draftName}
            autoFocus
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void rename()}
          />
          <div className="btn-row" style={{ marginTop: '0.75rem' }}>
            <button
              className="btn primary grow"
              disabled={!draftName.trim()}
              onClick={() => void rename()}
            >
              Save name
            </button>
            <button className="btn ghost" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="btn ghost block"
          onClick={() => {
            setDraftName(view.name)
            setRenameError(null)
            setRenaming(true)
          }}
        >
          Rename this item
        </button>
      )}

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
