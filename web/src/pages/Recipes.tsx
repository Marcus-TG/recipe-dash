import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, post, useFetch } from '../api'
import { Thumb } from '../components/Thumb'
import type { Recipe } from '../types'

export function Recipes() {
  const { data, loading, error, reload } = useFetch<Recipe[]>('/recipes')
  const [url, setUrl] = useState('')
  const [pasted, setPasted] = useState('')
  const [mode, setMode] = useState<'url' | 'paste'>('url')
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

  const importText = async () => {
    if (pasted.trim().length < 20) return
    setBusy(true)
    setMessage(null)
    try {
      await post('/recipes/import-text', {
        text: pasted,
        sourceUrl: url.trim() || null,
      })
      setPasted('')
      setMessage('Stripping out the fluff — it will appear in a moment.')
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
    <main className="page wide">
      <div className="page-head">
        <div>
          <h1>Recipes</h1>
          <p className="sub">Paste a link or photograph one. No typing.</p>
        </div>
      </div>

      <div className={`card importer ${mode}`}>
        <div className="seg">
          <button
            className={mode === 'url' ? 'on' : ''}
            onClick={() => setMode('url')}
          >
            Link
          </button>
          <button
            className={mode === 'paste' ? 'on' : ''}
            onClick={() => setMode('paste')}
          >
            Paste text
          </button>
        </div>

        {mode === 'url' ? (
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
        ) : (
          <>
            <div className="field">
              <label htmlFor="pasted">
                Paste the whole page — the story and ads get stripped out
              </label>
              <textarea
                id="pasted"
                rows={7}
                value={pasted}
                placeholder="Select all on the recipe page, copy, paste here…"
                onChange={(e) => setPasted(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="src">Source link (optional)</label>
              <input
                id="src"
                type="url"
                inputMode="url"
                placeholder="https://…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="btn-row">
          {mode === 'url' ? (
            <button
              className="btn primary grow"
              disabled={busy || !url.trim()}
              onClick={() => void importUrl()}
            >
              {busy ? <span className="spinner" /> : 'Import'}
            </button>
          ) : (
            <button
              className="btn primary grow"
              disabled={busy || pasted.trim().length < 20}
              onClick={() => void importText()}
            >
              {busy ? <span className="spinner" /> : 'Clean it up'}
            </button>
          )}
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
        {message && <p className="sub note">{message}</p>}
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && (data?.length ?? 0) === 0 && (
        <div className="empty">
          <span className="glyph">📖</span>
          No recipes yet.
        </div>
      )}

      <div className="grid">
        {(data ?? []).map((recipe) => (
          <Link className="card" to={`/recipes/${recipe.id}`} key={recipe.id}>
            <div className="row">
              <Thumb src={recipe.thumbnail} alt="" />
              <div className="grow">
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
              </div>
            </div>
          </Link>
        ))}
      </div>
    </main>
  )
}
