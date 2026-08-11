import { z } from 'zod'

// All runtime configuration comes from env vars (see homelab stack .env.example).
// Paperless/Ollama are optional: the app must boot and serve without them.
const Env = z.object({
  PORT: z.coerce.number().default(3000),
  DATA_DIR: z.string().default('./data'),

  PAPERLESS_URL: z.string().optional(),
  PAPERLESS_API_TOKEN: z.string().optional(),
  PAPERLESS_RECEIPT_TAG: z.string().optional(),

  OLLAMA_URL: z.string().optional(),
  OLLAMA_TEXT_MODEL: z.string().default('gpt-oss:20b'),
  OLLAMA_VISION_MODEL: z.string().optional(),
})

export const config = Env.parse(process.env)
export type Config = typeof config
