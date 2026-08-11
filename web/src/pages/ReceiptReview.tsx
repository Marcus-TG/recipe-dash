import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { post, useFetch } from '../api'
import type { ReceiptDetail } from '../types'

type Decision = {
  id: number
  action: 'confirm' | 'ignore'
  name: string
  quantity: number | null
  unit: string | null
}

export function ReceiptReview() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading, error, reload } = useFetch<ReceiptDetail>(`/receipts/${id}`)
  const [decisions, setDecisions] = useState<Record<number, Decision>>({})
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)

  // Seed from the server's proposals: anything it resolved defaults to
  // "confirm", anything it couldn't name defaults to "ignore".
  useEffect(() => {
    if (!data) return
    const seeded: Record<number, Decision> = {}
    for (const line of data.lines) {
      const name = line.itemName ?? line.proposedName ?? ''
      seeded[line.id] = {
        id: line.id,
        action: line.status === 'ignored' || !name ? 'ignore' : 'confirm',
        name,
        quantity: line.quantity,
        unit: line.unit,
      }
    }
    setDecisions(seeded)
  }, [data])

  // While the model is still working on this receipt, poll for its results.
  useEffect(() => {
    if (!data?.awaitingParse) return
    const timer = setInterval(reload, 4000)
    return () => clearInterval(timer)
  }, [data?.awaitingParse, reload])

  const update = (lineId: number, patch: Partial<Decision>) =>
    setDecisions((d) => ({ ...d, [lineId]: { ...d[lineId]!, ...patch } }))

  const confirm = async () => {
    setSaving(true)
    try {
      await post(`/receipts/${id}/confirm`, {
        lines: Object.values(decisions).map((d) => ({
          id: d.id,
          action: d.action,
          name: d.name || null,
          quantity: d.quantity,
          unit: d.unit,
        })),
      })
      navigate('/inbox')
    } finally {
      setSaving(false)
    }
  }

  const dismiss = async (markStore: boolean) => {
    await post(`/receipts/${id}/dismiss`, { markStoreNonGrocery: markStore })
    navigate('/inbox')
  }

  if (loading) return <main className="page">Loading…</main>
  if (error || !data)
    return (
      <main className="page">
        <div className="error">{error ?? 'Not found'}</div>
      </main>
    )

  const confirmCount = Object.values(decisions).filter(
    (d) => d.action === 'confirm',
  ).length
  const isDone = data.receipt.status !== 'needs_review'

  return (
    <main className="page">
      <Link className="back" to="/inbox">
        ‹ Inbox
      </Link>
      <div className="page-head">
        <div>
          <h1>{data.receipt.storeName ?? 'Receipt'}</h1>
          <p className="sub">
            {isDone
              ? `Already ${data.receipt.status}.`
              : 'Tap anything that looks wrong. Everything you fix is remembered.'}
          </p>
        </div>
      </div>

      {data.receipt.note && <div className="error">⚠ {data.receipt.note}</div>}

      {data.awaitingParse && (
        <p className="sub" style={{ marginBottom: '0.75rem' }}>
          <span className="spinner" /> forte is reading the unfamiliar lines…
        </p>
      )}

      {data.lines.map((line) => {
        const d = decisions[line.id]
        if (!d) return null
        const isEditing = editing === line.id
        return (
          <div className="card" key={line.id}>
            <div className="row-between">
              <div className="grow">
                <div className="card-title">
                  <span className="grow truncate">
                    {d.name || <span className="muted">not recognised</span>}
                  </span>
                </div>
                <div className="raw">{line.rawText}</div>
              </div>
              {line.resolution === 'alias' && <span className="chip plenty">known</span>}
              {line.resolution === 'llm' && <span className="chip some">guess</span>}
            </div>

            {!isDone && (
              <>
                <div className="seg" style={{ marginTop: '0.75rem' }}>
                  <button
                    className={d.action === 'confirm' ? 'on' : ''}
                    onClick={() => update(line.id, { action: 'confirm' })}
                  >
                    In the pantry
                  </button>
                  <button
                    className={d.action === 'ignore' ? 'on bad' : ''}
                    onClick={() => update(line.id, { action: 'ignore' })}
                  >
                    Skip
                  </button>
                  <button onClick={() => setEditing(isEditing ? null : line.id)}>
                    {isEditing ? 'Done' : 'Fix'}
                  </button>
                </div>

                {isEditing && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <div className="field">
                      <label>What is it?</label>
                      <input
                        type="text"
                        value={d.name}
                        placeholder="e.g. chicken breast"
                        onChange={(e) => update(line.id, { name: e.target.value })}
                      />
                    </div>
                    <div className="row">
                      <div className="field grow">
                        <label>How much</label>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={d.quantity ?? ''}
                          onChange={(e) =>
                            update(line.id, {
                              quantity: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                        />
                      </div>
                      <div className="field grow">
                        <label>Unit</label>
                        <select
                          value={d.unit ?? 'ea'}
                          onChange={(e) => update(line.id, { unit: e.target.value })}
                        >
                          {['ea', 'g', 'kg', 'lb', 'oz', 'ml', 'l'].map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}

      {!isDone && (
        <div className="stack" style={{ marginTop: '1rem' }}>
          <button
            className="btn primary block"
            disabled={saving}
            onClick={() => void confirm()}
          >
            {saving ? <span className="spinner" /> : `Add ${confirmCount} to the pantry`}
          </button>
          <button className="btn ghost block" onClick={() => void dismiss(false)}>
            Not groceries — skip this one
          </button>
          {data.receipt.storeName && (
            <button className="btn ghost block" onClick={() => void dismiss(true)}>
              Never ask about {data.receipt.storeName} again
            </button>
          )}
        </div>
      )}

      {data.receipt.documentUrl && (
        <p className="sub" style={{ marginTop: '1rem' }}>
          <a href={data.receipt.documentUrl} target="_blank" rel="noreferrer">
            View the scan in Paperless ›
          </a>
        </p>
      )}
    </main>
  )
}
