import { useRef, useState } from 'react'
import { api, del, post } from '../api'

/**
 * A recipe's picture, plus the two ways to give it one: upload a photo or
 * paste an image link. Pasted-text recipes always arrive without a picture,
 * so this is the normal path rather than an edge case.
 */
export function RecipeImage({
  recipeId,
  thumbnail,
  onChanged,
}: {
  recipeId: number
  thumbnail: string | null
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      await api(`/recipes/${recipeId}/image`, { method: 'POST', body: form })
      setOpen(false)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const fromUrl = async () => {
    if (!url.trim()) return
    setBusy(true)
    setError(null)
    try {
      await post(`/recipes/${recipeId}/image-url`, { url: url.trim() })
      setUrl('')
      setOpen(false)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await del(`/recipes/${recipeId}/image`)
      setOpen(false)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {thumbnail && <img className="hero" src={thumbnail} alt="" loading="lazy" />}

      {!open ? (
        <button
          className="btn ghost block"
          style={{ marginBottom: '1rem' }}
          onClick={() => setOpen(true)}
        >
          {thumbnail ? 'Change photo' : '📷 Add a photo'}
        </button>
      ) : (
        <div className="card">
          <div className="btn-row">
            <button
              className="btn grow"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? <span className="spinner" /> : '📷 Upload a photo'}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void upload(file)
                e.target.value = ''
              }}
            />
          </div>

          <div className="field" style={{ marginTop: '0.75rem' }}>
            <label htmlFor={`img-url-${recipeId}`}>…or paste an image link</label>
            <input
              id={`img-url-${recipeId}`}
              type="url"
              inputMode="url"
              placeholder="https://…jpg"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void fromUrl()}
            />
          </div>

          {error && <div className="error">{error}</div>}

          <div className="btn-row">
            <button
              className="btn primary grow"
              disabled={busy || !url.trim()}
              onClick={() => void fromUrl()}
            >
              Use this link
            </button>
            {thumbnail && (
              <button className="btn ghost danger" disabled={busy} onClick={() => void remove()}>
                Remove
              </button>
            )}
            <button className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  )
}
