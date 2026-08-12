import { useState } from 'react'
import { Link } from 'react-router-dom'
import { post, useFetch } from '../api'
import type { ReceiptSummary } from '../types'

function when(iso: string | null) {
  if (!iso) return 'unknown date'
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function Inbox() {
  const { data, loading, error, reload } = useFetch<ReceiptSummary[]>('/receipts')
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const checkNow = async () => {
    setChecking(true)
    setMessage(null)
    try {
      const res = await post<{ ingested: number }>('/receipts/poll')
      setMessage(
        res.ingested > 0
          ? `Found ${res.ingested} new receipt${res.ingested === 1 ? '' : 's'}.`
          : 'Nothing new in Paperless.',
      )
      reload()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const pending = (data ?? []).filter((r) => r.status === 'needs_review')
  const done = (data ?? []).filter((r) => r.status !== 'needs_review')

  return (
    <main className="page wide">
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="sub">Receipts from Paperless, waiting on a tap.</p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <p className="sub" style={{ marginBottom: '0.75rem' }}>{message}</p>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && pending.length === 0 && (
        <div className="empty">
          <span className="glyph">🧾</span>
          Nothing waiting. Scan a receipt into Paperless and it shows up here.
        </div>
      )}

      <div className="grid">
        {pending.map((r) => (
          <Link className="card" to={`/inbox/${r.id}`} key={r.id}>
            <div className="card-title">
              <span className="grow truncate">{r.storeName ?? 'Unknown store'}</span>
              <span className="chip">{r.lineCount} lines</span>
            </div>
            <p className="sub">{when(r.purchasedAt)}</p>
            {r.note && <p className="sub">⚠ {r.note}</p>}
          </Link>
        ))}
      </div>

      <button
        className="btn ghost block"
        onClick={() => void checkNow()}
        disabled={checking}
      >
        {checking ? <span className="spinner" /> : 'Check Paperless now'}
      </button>

      {done.length > 0 && (
        <section className="section">
          <div className="section-label">Already handled</div>
          <div className="grid tight">
            {done.slice(0, 20).map((r) => (
              <Link className="card" to={`/inbox/${r.id}`} key={r.id}>
                <div className="row-between">
                  <span className="grow truncate">
                    {r.storeName ?? 'Unknown store'}
                  </span>
                  <span className="chip">{r.status}</span>
                </div>
                <p className="sub">{when(r.purchasedAt)}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </main>
  )
}
