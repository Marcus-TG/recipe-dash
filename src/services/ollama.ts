import { z } from 'zod'
import { config } from '../config.js'

export class LlmUnavailableError extends Error {
  constructor(cause: string) {
    super(`Ollama unavailable: ${cause}`)
  }
}

/**
 * One gateway for every LLM call. Structured output via Ollama's `format`
 * (a JSON schema). Throws LlmUnavailableError when forte is asleep so callers
 * can requeue instead of failing the user's action.
 */
export async function structured<T extends z.ZodType>(opts: {
  schema: T
  system: string
  user: string
  images?: string[] // base64, for the vision model
  vision?: boolean
  timeoutMs?: number
}): Promise<z.infer<T>> {
  if (!config.OLLAMA_URL) throw new LlmUnavailableError('not configured')
  const model = opts.vision
    ? (config.OLLAMA_VISION_MODEL ?? config.OLLAMA_TEXT_MODEL)
    : config.OLLAMA_TEXT_MODEL

  let res: Response
  try {
    res = await fetch(`${config.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0 },
        format: z.toJSONSchema(opts.schema, { io: 'output' }),
        messages: [
          { role: 'system', content: opts.system },
          {
            role: 'user',
            content: opts.user,
            ...(opts.images?.length ? { images: opts.images } : {}),
          },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    })
  } catch (err) {
    throw new LlmUnavailableError(String(err))
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // 4xx is our bug (bad model name/schema); 5xx or connection issues are forte's.
    if (res.status >= 500) throw new LlmUnavailableError(`${res.status} ${body}`)
    throw new Error(`Ollama rejected the request: ${res.status} ${body}`)
  }
  const body = (await res.json()) as { message?: { content?: string } }
  const content = body.message?.content ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // Models occasionally wrap JSON in prose despite the schema.
    const match = content.match(/[[{][\s\S]*[\]}]/)
    if (!match) throw new Error(`Model did not return JSON: ${content.slice(0, 200)}`)
    parsed = JSON.parse(match[0])
  }
  return opts.schema.parse(parsed)
}

export async function ollamaReachable(): Promise<boolean> {
  if (!config.OLLAMA_URL) return false
  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    })
    return res.ok
  } catch {
    return false
  }
}
