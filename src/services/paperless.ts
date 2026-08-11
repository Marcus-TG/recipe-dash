import { config } from '../config.js'

export type PaperlessDoc = {
  id: number
  title: string
  content: string
  created: string
  added: string
  correspondent: number | null
  tags: number[]
}

function headers() {
  return { Authorization: `Token ${config.PAPERLESS_API_TOKEN ?? ''}` }
}

export function paperlessConfigured() {
  return Boolean(
    config.PAPERLESS_URL &&
      config.PAPERLESS_API_TOKEN &&
      config.PAPERLESS_RECEIPT_TAG,
  )
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${config.PAPERLESS_URL}${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Paperless ${path} → ${res.status}`)
  return (await res.json()) as T
}

export async function resolveTagId(name: string): Promise<number | null> {
  const data = await api<{ results: { id: number; name: string }[] }>(
    `/api/tags/?name__iexact=${encodeURIComponent(name)}`,
  )
  return data.results[0]?.id ?? null
}

export async function correspondentName(id: number): Promise<string | null> {
  try {
    const data = await api<{ name: string }>(`/api/correspondents/${id}/`)
    return data.name ?? null
  } catch {
    return null
  }
}

/** Documents carrying the receipt tag, oldest first, added after `since`. */
export async function fetchTaggedDocs(
  tagId: number,
  since: Date | null,
): Promise<PaperlessDoc[]> {
  const params = new URLSearchParams({
    tags__id__all: String(tagId),
    ordering: 'added',
    page_size: '25',
  })
  if (since) params.set('added__gt', since.toISOString())
  const data = await api<{ results: PaperlessDoc[] }>(
    `/api/documents/?${params.toString()}`,
  )
  return data.results
}

/** Original scan, base64 — only fetched when falling back to vision parsing. */
export async function fetchDocumentImageBase64(
  docId: number,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${config.PAPERLESS_URL}/api/documents/${docId}/thumb/`,
      { headers: headers(), signal: AbortSignal.timeout(30_000) },
    )
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.toString('base64')
  } catch {
    return null
  }
}

export async function paperlessReachable(): Promise<boolean> {
  if (!config.PAPERLESS_URL || !config.PAPERLESS_API_TOKEN) return false
  try {
    const res = await fetch(`${config.PAPERLESS_URL}/api/`, {
      headers: headers(),
      signal: AbortSignal.timeout(2500),
    })
    return res.ok
  } catch {
    return false
  }
}

export function documentUrl(docId: number) {
  return `${config.PAPERLESS_URL}/documents/${docId}/details`
}
