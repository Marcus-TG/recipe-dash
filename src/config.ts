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

  // Open Food Facts needs no account, so it's on by default — set this to
  // false to keep receipt parsing entirely inside the house.
  OPENFOODFACTS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OPENFOODFACTS_URL: z.string().default('https://world.openfoodfacts.org'),
  // Their API asks every caller to identify itself as "App/Version (contact)".
  // Defaults to the repo rather than a personal address, since it's sent to a
  // third party on every request.
  OPENFOODFACTS_CONTACT: z
    .string()
    .default('https://github.com/Marcus-TG/recipe-dash'),
})

export const config = Env.parse(process.env)
export type Config = typeof config
