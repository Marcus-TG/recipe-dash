import { useState } from 'react'

/**
 * Recipe thumbnail. Images are cached locally by the server, but a recipe can
 * legitimately have none (pasted text, hand-typed) — so the placeholder is a
 * first-class state, not an error.
 */
export function Thumb({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div className="thumb" aria-hidden="true">
        🍲
      </div>
    )
  }
  return (
    <img
      className="thumb"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}
