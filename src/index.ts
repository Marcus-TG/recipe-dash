import { config } from './config.js'
import { openDb } from './db/index.js'
import { buildServer } from './server.js'

const db = openDb()
const app = await buildServer()

// db will be decorated onto the app / passed to routes as domain code arrives
// in M1; opening it here already runs migrations on boot.
void db

await app.listen({ port: config.PORT, host: '0.0.0.0' })
app.log.info(`Larder listening on :${config.PORT} — docs at /api/docs`)
