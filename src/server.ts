import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { config } from './config.js'
import { cookRoutes } from './routes/cook.js'
import { healthRoutes } from './routes/health.js'
import { itemRoutes } from './routes/items.js'
import { receiptRoutes } from './routes/receipts.js'
import { recipeRoutes } from './routes/recipes.js'
import { version } from './version.js'

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 25 * 1024 * 1024,
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } })

  // OpenAPI is generated from the same Zod schemas that validate requests —
  // /api/docs is the integration contract for n8n and the dashboard.
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Larder API',
        description:
          'Recipes in, groceries in, meals out. Everything the UI can do, this API can do.',
        version,
      },
    },
    transform: jsonSchemaTransform,
  })
  await app.register(swaggerUi, { routePrefix: '/api/docs' })

  await app.register(
    async (api) => {
      await api.register(healthRoutes)
      await api.register(itemRoutes)
      await api.register(receiptRoutes)
      await api.register(recipeRoutes)
      await api.register(cookRoutes)
    },
    { prefix: '/api' },
  )

  // Uploaded recipe photos
  const uploads = path.join(config.DATA_DIR, 'uploads')
  fs.mkdirSync(uploads, { recursive: true })
  await app.register(fastifyStatic, {
    root: uploads,
    prefix: '/uploads/',
    decorateReply: false,
  })

  // Serve the built web app when it exists (production image); in dev the UI
  // runs on Vite's dev server and proxies /api here instead.
  const webDir = path.join(process.cwd(), 'dist', 'web')
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir })
    app.setNotFoundHandler((req, reply) => {
      // Only client-side routes fall back to the app shell. An API path or a
      // missing upload must 404, or a broken image looks like a valid page.
      if (req.url.startsWith('/api') || req.url.startsWith('/uploads/')) {
        return reply.code(404).send({ message: 'Not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}
