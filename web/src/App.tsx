import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useFetch } from './api'
import type { ReceiptSummary } from './types'

const TABS = [
  { to: '/', glyph: '🍳', label: 'Tonight' },
  { to: '/pantry', glyph: '🧺', label: 'Pantry' },
  { to: '/inbox', glyph: '🧾', label: 'Inbox' },
  { to: '/recipes', glyph: '📖', label: 'Recipes' },
  { to: '/shopping', glyph: '🛒', label: 'Shopping' },
]

export function App() {
  const location = useLocation()
  // Re-check the inbox on every navigation so the badge stays honest.
  const { data: pending } = useFetch<ReceiptSummary[]>(
    '/receipts?status=needs_review',
    [location.pathname],
  )
  const count = pending?.length ?? 0

  return (
    <div className="app">
      <Outlet />
      <nav className="nav">
        <div className="nav-brand">
          <span aria-hidden>🍲</span> Larder
        </div>
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.to === '/'}>
            <span className="glyph">
              {tab.glyph}
              {tab.to === '/inbox' && count > 0 && (
                <span className="badge">{count}</span>
              )}
            </span>
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
