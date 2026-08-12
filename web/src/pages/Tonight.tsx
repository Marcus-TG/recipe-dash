import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useFetch } from '../api'
import { Thumb } from '../components/Thumb'
import type { RecipeMatch } from '../types'

const HEADINGS: Record<RecipeMatch['verdict'], string> = {
  cookable: 'Cook these right now',
  check_shelf: 'Probably — check the shelf',
  almost: 'One or two things short',
  not_tonight: 'Not tonight',
}

function MatchCard({ match }: { match: RecipeMatch }) {
  return (
    <Link className="card" to={`/recipes/${match.recipeId}`}>
      <div className="row">
        <Thumb src={match.thumbnail} alt="" />
        <div className="grow">
          <div className="card-title">
            <span className="grow">{match.title}</span>
            <span className={`chip ${match.verdict}`}>
              {match.verdict === 'cookable'
                ? 'ready'
                : match.verdict === 'check_shelf'
                  ? 'check'
                  : `${match.missing.length} short`}
            </span>
          </div>
        </div>
      </div>
      {match.usesUp.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <span className="chip uses-up">uses up: {match.usesUp.join(', ')}</span>
        </div>
      )}
      {match.missing.length > 0 && (
        <p className="sub" style={{ marginTop: '0.4rem' }}>
          grab {match.missing.join(', ')}
        </p>
      )}
      {match.uncertain.length > 0 && (
        <p className="sub" style={{ marginTop: '0.4rem' }}>
          not sure about {match.uncertain.join(', ')}
        </p>
      )}
      {match.untracked.length > 2 && (
        <p className="sub" style={{ marginTop: '0.4rem' }}>
          doesn’t track {match.untracked.length} of its ingredients
        </p>
      )}
    </Link>
  )
}

export function Tonight() {
  const { data, loading, error } = useFetch<RecipeMatch[]>('/recipes/cookable')
  const [showAll, setShowAll] = useState(false)

  const groups = (['cookable', 'check_shelf', 'almost', 'not_tonight'] as const).map(
    (verdict) => ({
      verdict,
      matches: (data ?? []).filter((m) => m.verdict === verdict),
    }),
  )
  const hasAny = (data?.length ?? 0) > 0

  return (
    <main className="page wide">
      <div className="page-head">
        <div>
          <h1>Tonight</h1>
          <p className="sub">What the pantry says you can actually make.</p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Checking the shelves…</p>}

      {!loading && !hasAny && (
        <div className="empty">
          <span className="glyph">🍳</span>
          No recipes yet.
          <br />
          <Link to="/recipes">Add one</Link> and this fills in.
        </div>
      )}

      {groups.map(({ verdict, matches }) => {
        if (matches.length === 0) return null
        if (verdict === 'not_tonight' && !showAll) return null
        return (
          <section className="section" key={verdict}>
            <div className="section-label">{HEADINGS[verdict]}</div>
            <div className="grid">
              {matches.map((m) => (
                <MatchCard key={m.recipeId} match={m} />
              ))}
            </div>
          </section>
        )
      })}

      {!showAll && groups[3]!.matches.length > 0 && (
        <button className="btn ghost block" onClick={() => setShowAll(true)}>
          Show {groups[3]!.matches.length} more that need shopping
        </button>
      )}
    </main>
  )
}
