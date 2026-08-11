# recipe-dash (Larder)

Self-hosted recipe + pantry app. PLAN.md is the source of truth for
architecture, data model, and milestone order — read it before building
anything, and keep it updated when decisions change.

## Stack

- TypeScript ESM end-to-end. Node 26, single package, no workspaces.
- Server: Fastify 5 + fastify-type-provider-zod (Zod 4). Every route gets Zod
  schemas — that's what generates /api/docs, which is the n8n integration
  contract. No undocumented endpoints.
- DB: SQLite via better-sqlite3 + Drizzle. Schema in `src/db/schema.ts`;
  after changes run `npm run db:generate` and commit the `drizzle/` output.
  Migrations run on boot. The pantry ledger (`pantry_events`) is append-only —
  never UPDATE or DELETE ledger rows.
- Web: React + Vite in `web/`, built to `dist/web`, served by Fastify in
  production. Phone-first: big tap targets, dark, honest uncertainty wording.
- Server code imports use `.js` extensions (NodeNext ESM).
- The server assumes cwd = project root (migrations path, package.json
  version, dist/web).

## Commands

- `npm run dev` / `npm run dev:web` — API on :3000, Vite UI proxying to it
- `npm run build && npm start` — production mode locally
- `npm run check` — typecheck (run before considering work done)

## Environment

Local dev needs no env vars (Paperless/Ollama report "unconfigured" —
everything must keep working without them; that's a design rule, not a bug).
Real values live in the homelab repo: `stacks/recipe-dash/.env.example`.
Ollama on forte is reachable during dev at `http://forte:11434`
(models: gpt-oss:20b for text, a Qwen 27B VL for vision).

## Deploy

Push to `main` → GitHub Action builds `ghcr.io/marcus-tg/recipe-dash:latest`
→ Marcus redeploys the Portainer stack (homelab repo, `stacks/recipe-dash/`)
→ app at http://aria:8465. Plain HTTP by choice: no PWA, no service worker,
no HTTPS machinery. Keep-screen-on uses the looping-video trick, not the
Wake Lock API (which needs HTTPS).

## Conventions

- Commits: plain human-style messages, no attribution trailers, commit
  directly to `main` (Marcus's global preference).
- Marcus builds with AI assistance and isn't from a traditional CS
  background: explain reasoning, flag judgment calls explicitly.
