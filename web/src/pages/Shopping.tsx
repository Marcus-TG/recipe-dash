import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, post, useFetch } from '../api'
import type { GroceryLine, GroceryList, Recipe } from '../types'

const REASON_WORDS: Record<GroceryLine['reason'], string> = {
  missing: 'out',
  short: 'not enough',
  uncertain: 'check the shelf',
  untracked: 'not tracked',
  manual: 'added by hand',
}

/**
 * One line, one row. The whole complaint this screen answers is scrolling up
 * and back down hunting for something, so a row stays a single line: the
 * reason lives in the colour of its left edge and the amount is right-aligned
 * where the eye can run down the column. Details are a toggle, not a default.
 */
function Row({
  line,
  detailed,
  onToggle,
  onDismiss,
}: {
  line: GroceryLine
  detailed: boolean
  onToggle: () => void
  onDismiss: () => void
}) {
  const amount =
    line.needLabel ?? (line.asks.length > 0 ? line.asks.join(' + ') : '')
  return (
    <div className={`glist-row ${line.reason}${line.checked ? ' checked' : ''}`}>
      <button className="glist-tap" onClick={onToggle}>
        <span className="glist-box" aria-hidden>
          {line.checked ? '✓' : ''}
        </span>
        <span className="glist-name">
          {line.label}
          {line.optional && <span className="glist-opt"> optional</span>}
        </span>
        <span className="glist-amount">{amount}</span>
      </button>
      <button
        className="glist-x"
        aria-label={`Remove ${line.label}`}
        onClick={onDismiss}
      >
        ×
      </button>
      {detailed && (
        <p className="glist-meta">
          {[
            REASON_WORDS[line.reason],
            // "out · out" — the pantry's word for it is sometimes the same
            // word, and saying it twice reads like a stutter.
            line.haveLabel === REASON_WORDS[line.reason] ? null : line.haveLabel,
            line.forRecipes.length > 0
              ? `for ${line.forRecipes.join(', ')}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  )
}

export function Shopping() {
  const { data, loading, error, setData } = useFetch<GroceryList>('/grocery/list')
  const { data: allRecipes } = useFetch<Recipe[]>('/recipes')
  const [detailed, setDetailed] = useState(false)
  const [picking, setPicking] = useState(false)
  const [showCovered, setShowCovered] = useState(false)
  const [newItem, setNewItem] = useState('')
  const [busy, setBusy] = useState(false)

  const onList = useMemo(
    () => new Set((data?.recipes ?? []).map((r) => r.recipeId)),
    [data],
  )

  // Every mutation answers with the whole list, so there is no second
  // round-trip — which matters on shop wifi.
  const send = async (fn: () => Promise<GroceryList>) => {
    setBusy(true)
    try {
      setData(await fn())
    } finally {
      setBusy(false)
    }
  }

  const toggle = (line: GroceryLine) => {
    // Tick it locally first: in a shop the tap has to feel instant.
    setData((prev) =>
      prev
        ? {
            ...prev,
            aisles: prev.aisles.map((a) => ({
              ...a,
              lines: a.lines.map((l) =>
                l.key === line.key ? { ...l, checked: !l.checked } : l,
              ),
            })),
            counts: {
              ...prev.counts,
              checked: prev.counts.checked + (line.checked ? -1 : 1),
              remaining: prev.counts.remaining + (line.checked ? 1 : -1),
            },
          }
        : prev,
    )
    void send(() =>
      api<GroceryList>('/grocery/list/lines', {
        method: 'PATCH',
        body: JSON.stringify({
          key: line.key,
          label: line.label,
          checked: !line.checked,
        }),
      }),
    )
  }

  const dismiss = (line: GroceryLine) =>
    send(() =>
      api<GroceryList>('/grocery/list/lines', {
        method: 'PATCH',
        body: JSON.stringify({
          key: line.key,
          label: line.label,
          dismissed: true,
        }),
      }),
    )

  const addManual = async () => {
    if (!newItem.trim()) return
    await send(() =>
      post<GroceryList>('/grocery/list/lines', { label: newItem.trim() }),
    )
    setNewItem('')
  }

  if (loading) return <main className="page wide">Loading…</main>
  if (error || !data)
    return (
      <main className="page wide">
        <div className="error">{error ?? 'Not found'}</div>
      </main>
    )

  const { counts } = data
  const empty = counts.total === 0 && data.recipes.length === 0

  return (
    <main className="page wide">
      <div className="glist-head">
        <div className="row-between">
          <div>
            <h1>Shopping</h1>
            <p className="sub">
              {counts.total === 0
                ? 'Nothing to buy yet.'
                : `${counts.remaining} to go · ${counts.checked} in the cart`}
            </p>
          </div>
          <div className="btn-row">
            <button
              className={`btn ghost small${detailed ? ' on' : ''}`}
              onClick={() => setDetailed((d) => !d)}
            >
              {detailed ? 'Compact' : 'Details'}
            </button>
            {counts.checked > 0 && (
              <button
                className="btn primary small"
                disabled={busy}
                onClick={() =>
                  void send(() => post<GroceryList>('/grocery/list/complete'))
                }
              >
                Done
              </button>
            )}
          </div>
        </div>
        {counts.total > 0 && (
          <div className="glist-bar">
            <span
              style={{
                width: `${Math.round((counts.checked / counts.total) * 100)}%`,
              }}
            />
          </div>
        )}
      </div>

      {/* Which recipes this list is for. Removing one re-totals the rest. */}
      <div className="glist-recipes">
        {data.recipes.map((r) => (
          <span className="chip recipe-chip" key={r.recipeId}>
            <Link to={`/recipes/${r.recipeId}`}>{r.title}</Link>
            {r.servings && r.recipeServings && r.servings !== r.recipeServings && (
              <span className="muted">
                {' '}
                ×{Math.round((r.servings / r.recipeServings) * 100) / 100}
              </span>
            )}
            <button
              aria-label={`Remove ${r.title}`}
              onClick={() =>
                void send(() =>
                  api<GroceryList>(`/grocery/list/recipes/${r.recipeId}`, {
                    method: 'DELETE',
                  }),
                )
              }
            >
              ×
            </button>
          </span>
        ))}
        <button className="chip add-chip" onClick={() => setPicking((p) => !p)}>
          + recipe
        </button>
      </div>

      {picking && (
        <div className="card">
          <div className="section-label">Add a recipe to the list</div>
          {(allRecipes ?? [])
            .filter((r) => !onList.has(r.id) && r.status !== 'pending_parse')
            .map((r) => (
              <button
                className="glist-pick"
                key={r.id}
                disabled={busy}
                onClick={() =>
                  void send(() =>
                    post<GroceryList>('/grocery/list/recipes', { recipeId: r.id }),
                  )
                }
              >
                <span className="grow truncate">{r.title}</span>
                <span className="muted">add</span>
              </button>
            ))}
          {(allRecipes ?? []).filter((r) => !onList.has(r.id)).length === 0 && (
            <p className="sub">Every recipe you have is already on the list.</p>
          )}
        </div>
      )}

      {empty && (
        <div className="empty">
          <span className="glyph">🛒</span>
          Add a recipe or two and this fills with what you don’t already have.
          <br />
          <Link to="/">See what’s cookable</Link>
        </div>
      )}

      {/* Grouped by aisle, in the order you walk a shop — so you never have to
          scroll back up to check whether there was anything else in produce. */}
      <div className="glist">
        {data.aisles.map((aisle) => (
          <section className="glist-aisle" key={aisle.category}>
            <div className="glist-aisle-head">
              {aisle.label}
              <span className="muted">
                {aisle.lines.filter((l) => !l.checked).length || '✓'}
              </span>
            </div>
            {aisle.lines.map((line) => (
              <Row
                key={line.key}
                line={line}
                detailed={detailed}
                onToggle={() => toggle(line)}
                onDismiss={() => void dismiss(line)}
              />
            ))}
          </section>
        ))}
      </div>

      <div className="card glist-add">
        <input
          type="text"
          value={newItem}
          placeholder="+ something else (milk, foil…)"
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addManual()}
        />
        <button
          className="btn"
          disabled={busy || !newItem.trim()}
          onClick={() => void addManual()}
        >
          Add
        </button>
      </div>

      {data.covered.length > 0 && (
        <section className="section">
          <button
            className="btn ghost block"
            onClick={() => setShowCovered((s) => !s)}
          >
            {showCovered ? 'Hide' : 'Show'} {data.covered.length} you already have
          </button>
          {showCovered && (
            <div className="glist covered">
              {data.covered.map((c, i) => (
                <div className="glist-row have" key={`${c.label}-${i}`}>
                  <div className="glist-tap">
                    <span className="glist-box" aria-hidden>
                      ✓
                    </span>
                    <span className="glist-name">{c.label}</span>
                    <span className="glist-amount">{c.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {counts.total > 0 && (
        <p className="sub note">
          Ticking a row is just a memory aid — the pantry updates from the
          receipt, which knows what you actually bought.
        </p>
      )}
    </main>
  )
}
