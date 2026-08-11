# recipe-dash (Larder)

A self-hosted recipe app where the pantry is real. Grocery receipts scanned
into Paperless-ngx become pantry inventory automatically; recipes come in by
URL or photo; the app answers "what can I actually cook tonight?"

**Read [PLAN.md](PLAN.md) first** — it's the architecture, data model, and
build order, and the document to argue with.

## Status

v1 feature-complete. Receipts flow in from Paperless, parse against a learned
alias table (falling back to gpt-oss on forte for unfamiliar lines), and land
in a tap-to-confirm inbox. Confirming writes purchase events to an append-only
ledger and teaches the alias table. Recipes import by URL (schema.org JSON-LD,
model fallback) or photo (vision model). The Tonight screen ranks what's
cookable; cook mode keeps the screen on and the follow-up screen records what
was actually used.

Not yet exercised against real grocery receipts in Paperless — the tag
currently holds invoices, not shopping. That's the next real-world test.

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
- Jobs: `GET /api/jobs` shows the parse queue when debugging
- `POST /api/admin/rebuild-state` re-folds the ledger into the projection —
  the fix for anything that looks wrong in the pantry

### Testing without Paperless

`POST /api/receipts {rawText, storeName}` runs pasted receipt text through the
exact same parse → confirm → learn path.

## Deployment

CI builds `ghcr.io/marcus-tg/recipe-dash` on every push to `main`. The
compose stack lives in the homelab repo under `stacks/recipe-dash/`; the app
runs at `http://aria:8465`, LAN/Tailscale only.
