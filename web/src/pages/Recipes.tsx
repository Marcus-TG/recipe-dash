import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, post, useFetch } from '../api'
import type { Recipe } from '../types'

export function Recipes() {
  const { data, loading, error, reload } = useFetch<Recipe[]>('/recipes')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const importUrl = async () => {
    if (!url.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await post('/recipes/import-url', { url: url.trim() })
      setUrl('')
      setMessage('Reading it now — it will appear in a moment.')
      reload()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const importPhoto = async (file: File) => {
    setBusy(true)
    setMessage(null)
    try {
      const form = new FormData()
      form.append('file', file)
      await api('/recipes/import-photo', { method: 'POST', body: form })
      setMessage('forte is reading the photo — it will appear in a moment.')
      reload()
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Recipes</h1>
          <p className="sub">Paste a link or photograph one. No typing.</p>
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label htmlFor="url">Recipe URL</label>
          <input
            id="url"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void importUrl()}
          />
        </div>
        <div className="btn-row">
          <button
            className="btn primary grow"
            disabled={busy || !url.trim()}
            onClick={() => void importUrl()}
          >
            {busy ? <span className="spinner" /> : 'Import'}
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()}>
            📷 Photo
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void importPhoto(file)
              e.target.value = ''
            }}
          />
        </div>
        {message && (
          <p className="sub" style={{ marginTop: '0.6rem' }}>
            {message}
          </p>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && (data?.length ?? 0) === 0 && (
        <div className="empty">
          <span className="glyph">📖</span>
          No recipes yet.
        </div>
      )}

      {(data ?? []).map((recipe) => (
        <Link className="card" to={`/recipes/${recipe.id}`} key={recipe.id}>
          <div className="card-title">
            <span className="grow truncate">{recipe.title}</span>
            {recipe.status === 'pending_parse' && (
              <span className="chip">
                <span className="spinner" /> reading
              </span>
            )}
            {recipe.status === 'parse_failed' && (
              <span className="chip missing">failed</span>
            )}
          </div>
          {recipe.servings && <p className="sub">serves {recipe.servings}</p>}
        </Link>
      ))}
    </main>
  )
}
