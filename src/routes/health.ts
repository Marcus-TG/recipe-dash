import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { config } from '../config.js'
import { version } from '../version.js'

const CheckResult = z.enum(['ok', 'unconfigured', 'unreachable', 'error'])

const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.object({
    paperless: CheckResult,
    ollama: CheckResult,
  }),
})

async function probe(url: string, headers?: Record<string, string>) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(2500) })
    return res.ok ? ('ok' as const) : ('error' as const)
  } catch {
    return 'unreachable' as const
  }
}

// Always returns 200: "forte is asleep" is degraded, not down, and must not
// make Docker restart-loop the container.
export async function healthRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/health',
    schema: {
      description:
        'Liveness + dependency reachability. Paperless and Ollama being down degrades, never fails.',
      tags: ['system'],
      response: { 200: HealthResponse },
    },
    handler: async () => {
      const [paperless, ollama] = await Promise.all([
        config.PAPERLESS_URL && config.PAPERLESS_API_TOKEN
          ? probe(`${config.PAPERLESS_URL}/api/`, {
              Authorization: `Token ${config.PAPERLESS_API_TOKEN}`,
            })
          : ('unconfigured' as const),
        config.OLLAMA_URL
          ? probe(`${config.OLLAMA_URL}/api/tags`)
          : ('unconfigured' as const),
      ])
      const degraded = [paperless, ollama].some(
        (c) => c === 'unreachable' || c === 'error',
      )
      return {
        status: degraded ? ('degraded' as const) : ('ok' as const),
        version,
        checks: { paperless, ollama },
      }
    },
  })
}
