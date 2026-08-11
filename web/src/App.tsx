import { useEffect, useState } from 'react'

type Health = {
  status: 'ok' | 'degraded'
  version: string
  checks: Record<string, 'ok' | 'unconfigured' | 'unreachable' | 'error'>
}

const CHECK_LABELS: Record<string, string> = {
  paperless: 'Paperless (receipts in)',
  ollama: 'Ollama on forte (parsing)',
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setError(true))
  }, [])

  return (
    <main className="shell">
      <h1>Larder</h1>
      <p className="tagline">Recipes in, groceries in, meals out.</p>

      <section className="card">
        <h2>Walking skeleton</h2>
        {error && <p className="bad">Can’t reach the server.</p>}
        {!health && !error && <p className="muted">Checking…</p>}
        {health && (
          <>
            <p>
              Server <strong>v{health.version}</strong> —{' '}
              <span className={health.status === 'ok' ? 'good' : 'warn'}>
                {health.status}
              </span>
            </p>
            <ul className="checks">
              {Object.entries(health.checks).map(([name, state]) => (
                <li key={name}>
                  <span
                    className={
                      state === 'ok'
                        ? 'good'
                        : state === 'unconfigured'
                          ? 'muted'
                          : 'warn'
                    }
                  >
                    ●
                  </span>{' '}
                  {CHECK_LABELS[name] ?? name}: {state}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="muted">
        <a href="/api/docs">API docs</a>
      </p>
    </main>
  )
}
