# recipe-dash (Larder)

A self-hosted recipe app where the pantry is real. Grocery receipts scanned
into Paperless-ngx become pantry inventory automatically; recipes come in by
URL or photo; the app answers "what can I actually cook tonight?"

**Read [PLAN.md](PLAN.md) first** — it's the architecture, data model, and
build order, and the document to argue with.

## Status

M0 — walking skeleton. Server, database migrations, health endpoint, API
docs, web shell, Docker image pipeline. No features yet.

## Development

```bash
npm install
npm run dev        # API server on :3000 (tsx watch)
npm run dev:web    # Vite dev server for the UI, proxies /api to :3000
npm run build      # builds web (dist/web) + server (dist/server)
npm start          # run the built server (serves the built web UI too)
npm run check      # typecheck
npm run db:generate  # after editing src/db/schema.ts: generate a migration
```

Migrations in `drizzle/` are committed and run automatically on boot.
The server assumes it starts from the project root.

- Health: `GET /api/health` (always 200; reports Paperless/Ollama reachability)
- API docs: `/api/docs` (OpenAPI, generated from the Zod schemas)

## Deployment

CI builds `ghcr.io/marcus-tg/recipe-dash` on every push to `main`. The
compose stack lives in the homelab repo under `stacks/recipe-dash/`; the app
runs at `http://aria:8465`, LAN/Tailscale only.
