import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { healthRoutes } from './routes/health.js'
import { version } from './version.js'

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

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

  await app.register(healthRoutes, { prefix: '/api' })

  // Serve the built PWA when it exists (production image); in dev the web app
  // runs on Vite's dev server and proxies /api here instead.
  const webDir = path.join(process.cwd(), 'dist', 'web')
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir })
    // SPA fallback: unknown non-API paths get index.html so client-side
    // routing works after a page refresh.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) {
        return reply.code(404).send({ message: 'Not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}
