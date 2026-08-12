import { useState } from 'react'
import { Link } from 'react-router-dom'
import { post, useFetch } from '../api'
import type { ItemView } from '../types'

type Filter = 'all' | 'low' | 'soon'

export function Pantry() {
  const { data, loading, error, reload } = useFetch<ItemView[]>('/items')
  const [filter, setFilter] = useState<Filter>('all')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const items = (data ?? []).filter((i) =>
    filter === 'low'
      ? i.level === 'low' || i.level === 'out'
      : filter === 'soon'
        ? i.useBySoon
        : true,
  )

  const addItem = async () => {
    if (!name.trim()) return
    await post('/items', { name: name.trim() })
    setName('')
    setAdding(false)
    reload()
  }

  return (
    <main className="page wide">
      <div className="page-head">
        <div>
          <h1>Pantry</h1>
          <p className="sub">
            Levels are guesses, not gospel — tap anything to correct it.
          </p>
        </div>
      </div>

      <div className="seg" style={{ marginBottom: '1rem' }}>
        {(['all', 'low', 'soon'] as Filter[]).map((f) => (
          <button
            key={f}
            className={filter === f ? 'on' : ''}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Everything' : f === 'low' ? 'Running low' : 'Use soon'}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && items.length === 0 && (
        <div className="empty">
          <span className="glyph">🧺</span>
          {filter === 'all'
            ? 'Nothing in the pantry yet. Confirm a receipt and it fills itself.'
            : 'Nothing here right now.'}
        </div>
      )}

      <div className="grid tight">
        {items.map((item) => (
          <Link className="card" to={`/pantry/${item.id}`} key={item.id}>
            <div className="card-title">
              <span className="grow truncate">{item.name}</span>
              <span className={`chip ${item.level}`}>{item.levelLabel}</span>
            </div>
            <div className="row" style={{ marginTop: '0.35rem' }}>
              <span className="sub grow">
                {item.quantityBase != null ? item.quantityLabel : 'no amount recorded'}
                {item.lastConfirmedLabel
                  ? ` · confirmed ${item.lastConfirmedLabel}`
                  : ''}
              </span>
              {item.useBySoon && <span className="chip uses-up">use soon</span>}
            </div>
          </Link>
        ))}
      </div>

      {adding ? (
        <div className="card">
          <div className="field">
            <label htmlFor="new-item">Item name</label>
            <input
              id="new-item"
              type="text"
              value={name}
              autoFocus
              placeholder="e.g. olive oil"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addItem()}
            />
          </div>
          <div className="btn-row">
            <button className="btn primary grow" onClick={() => void addItem()}>
              Add
            </button>
            <button className="btn ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn ghost block" onClick={() => setAdding(true)}>
          + Add an item by hand
        </button>
      )}
    </main>
  )
}
