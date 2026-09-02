import { config } from './config.js'
import './db/client.js' // opens the database and runs migrations
import './pipelines/receipts.js' // registers the receipt job handler
import { backfillIngredientSections } from './pipelines/recipes.js' // also registers the job handlers
import { buildServer } from './server.js'
import { startJobRunner } from './services/jobs.js'
import { startPaperlessPoller } from './pipelines/receipts.js'

// One-off tidy for recipes imported before section headings were understood.
const resectioned = backfillIngredientSections()

const app = await buildServer()
await app.listen({ port: config.PORT, host: '0.0.0.0' })

startJobRunner()
startPaperlessPoller()

app.log.info(`Larder listening on :${config.PORT} — docs at /api/docs`)
if (resectioned > 0) app.log.info(`Folded section headings on ${resectioned} recipe(s)`)
