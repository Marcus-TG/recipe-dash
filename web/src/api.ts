import { useCallback, useEffect, useState } from 'react'

export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  // Only declare a JSON body when there actually is one. Sending
  // content-type: application/json with an empty body makes Fastify reject the
  // request outright, which silently broke every DELETE in the app.
  const isJsonBody = init?.body != null && !(init.body instanceof FormData)
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: isJsonBody
      ? { 'content-type': 'application/json', ...(init?.headers ?? {}) }
      : init?.headers,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as any)?.message ?? `Request failed (${res.status})`)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const post = <T = unknown,>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const patch = <T = unknown,>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })

export const del = <T = unknown,>(path: string) =>
  api<T>(path, { method: 'DELETE' })

export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    if (!path) return
    setLoading(true)
    api<T>(path)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps])

  useEffect(reload, [reload])
  return { data, error, loading, reload, setData }
}
