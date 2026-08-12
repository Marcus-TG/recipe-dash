# Larder — v1 Plan

*The plan for a self-hosted recipe app where the pantry is real. Argue with this
document, not with the code.*

---

## The shape of it

One Docker container on `aria`, one SQLite database, one volume. It polls your
Paperless for receipt-tagged documents, parses them (deterministically first,
Ollama on `forte` only for lines it's never seen), and queues them for a
tap-to-confirm review on your phone. Recipes come in by pasted URL or photo.
Cooking marks ingredients consumed. A "tonight" screen ranks what you can
actually cook, sorted so things about to go bad float to the top.

```
┌─ aria ─────────────────────────────────────────────┐
│  larder (single container, one Node process)       │
│   ├─ REST API  /api/v1/*  (OpenAPI docs at /docs)  │
│   ├─ React web app (served as static files)        │
│   ├─ Paperless poller (every ~3 min)               │
│   ├─ LLM job runner (drains a SQLite job table)    │
│   └─ SQLite in /data (one volume = whole backup)   │
└────────────────────────────────────────────────────┘
     │ read-mostly                  │ optional at runtime
     ▼                              ▼
 Paperless-ngx (existing)     Ollama on forte:11434
```

**Why one container, no Redis, no worker, no Postgres:** at single-household
scale there is no problem those solve. The job queue is a SQLite table, which
means jobs survive restarts and you can debug them with plain SQL. Backup =
copy one volume. This is a deliberate call: SQLite can't do concurrent multi-
process writers, which will never matter here, and the design ports to
Postgres cleanly if it ever did.

**Stack:** TypeScript end-to-end (your ecosystem — Astro, Workers, n8n).
Fastify + Zod, because that combination generates a live OpenAPI spec from the
same schemas that validate requests — your "anything the UI can do, the API
can do" requirement becomes a free byproduct instead of documentation chores.
Drizzle ORM on better-sqlite3 (the schema file *is* the data-model doc).
React + Vite web app, built into the image, served by the same server.

**Paperless and forte are peers, not dependencies.** The app boots and serves
with both unreachable. `/health` reports `degraded` with reasons but never
fails, so the container doesn't restart-loop because forte is asleep.

---

## Access: plain HTTP at `aria:8465` — decided

One service, one port, finance-dash style; LAN/Tailscale reachability only.
Marcus explicitly doesn't want install-to-home-screen or any HTTPS machinery,
so there is no PWA, no service worker, no manifest, no Tailscale sidecar.
Keep-screen-on in cook mode uses the invisible-looping-video trick
(NoSleep.js approach), which works on plain HTTP — the official Wake Lock API
requires HTTPS, so we don't use it. The stack definition lives in
`homelab/stacks/recipe-dash/`.

---

## Data model — the parts that carry the design

### The ledger (hard problems #3 and #4)

`pantry_events` is **append-only** — never updated, never deleted. Types:
`purchase`, `consume`, `spoilage`, `adjust_delta`, and crucially **`snapshot`**:
an absolute assertion ("about half a bag", "actually out"). Pure-delta ledgers
make drift correction arithmetic homework — you never know the delta, you know
what's on the shelf. On-hand = most recent snapshot + events since. A snapshot
is also implicitly a human confirmation, resetting confidence to full. That's
what makes drift a two-tap fix.

Every event carries `source_type` + `source_id`, so "why does it think I have
4kg of rice?" is a chain you can walk: event → receipt line → receipt →
the actual document in Paperless.

`item_state` is a materialized rollup updated in the same transaction as every
event, **rebuildable from the ledger** via an admin endpoint. If it ever looks
wrong: rebuild. The ledger stays the sole source of truth.

### Honesty about quantities

Confidence is **derived at read time** from `now − last_human_confirmed_at`
against a per-category staleness half-life (produce ~4 days, dairy ~10,
dry/canned ~90). Nothing stores a decaying number (stored decay is stale the
moment it's written). The UI speaks in words — *plenty / some / low / probably
out / 🕐 stale info (last confirmed 6 weeks ago)* — with the precise ledger one
tap away.

### The learning layer (hard problem #1)

`aliases`: `(store, normalized raw text) → item + default quantity/unit`.
Checked **before** the LLM, written on **every** human confirmation.
Human-sourced rows permanently beat LLM-sourced rows. So `GRT VAL CHKN BRST
2LB` costs you one correction, ever — and it learns the quantity too, so next
time the 2 lb is pre-filled. Normalization keeps embedded pack sizes ("2LB",
"796ML") because they're part of the product's identity; stripping them would
merge distinct products.

Emergent property worth noticing: the learning loop *is* the offline
resilience. A mature alias table makes forte nearly optional for routine
shopping.

### Units (hard problem #2)

Three unit families — mass, volume, count — with exact in-family conversions
living in code (physics doesn't vary per deployment). **Cross-family
conversion never happens without a per-item density a human provided.** When a
recipe says "2 cups" and the pantry tracks grams, matching degrades to
presence-only ("have it") rather than guessing. Conversions happen at
comparison time and are never written back — so a wrong quantity can at worst
mis-rank a recipe, never silently poison the ledger.

### Everything else

`items` (canonical: "chicken breast" — brands and pack sizes are aliases, not
items), `stores`, `receipts` + `receipt_lines` (status flow: `pending_parse` →
`needs_review` → `confirmed`), `recipes` + `recipe_ingredients` (an
**unresolved** ingredient is a legal permanent state — "not tracked: fresh
basil" — and never blocks anything), `cook_sessions` + lines, `llm_jobs`
(queue with retry/backoff), `settings` (Paperless cursor, tag id).

---

## Receipt intake pipeline

1. Poller (or an optional Paperless/n8n webhook — both idempotent by
   `paperless_doc_id`) spots a new receipt-tagged doc, caches its OCR text.
2. **Deterministic pass, no network:** detect store, segment lines, drop junk
   (SUBTOTAL/TAX/loyalty rows), look up each line in `aliases` — hits resolve
   instantly with pre-filled quantities.
   - The Paperless tag covers *all* receipts, not just groceries. Stores carry
     a `non_grocery` flag: dismissing a receipt from a store once ("not
     groceries") sets it, and future receipts from that store auto-skip
     without review or LLM calls. Unknown stores get a cheap "is this
     groceries at all?" triage at the start of the LLM pass.
3. Unmatched lines go to **one** LLM job for the whole receipt (batched, with
   store context — better results and politer to forte than per-line calls).
   gpt-oss:20b, structured output. All LLM output lands as *proposed*, never
   auto-confirmed.
4. Receipt hits the phone confirm queue. Confirming runs one transaction:
   purchase events + alias upserts for every confirmed line + state update.
5. **Vision fallback, not default:** if the OCR-text parse looks broken, or
   you tap "reparse from image", fetch the image from Paperless and run the
   Qwen VL model instead. Same review flow.

**forte offline:** step 2 still works, alias-matched lines are confirmable
immediately, unmatched lines show "awaiting parse" and retry with backoff. You
can also resolve any line by hand. Nothing blocks, nothing is lost.

First receipt from a store: mostly LLM proposals needing review. Fifth:
mostly instant alias hits. That's the "gets smarter" requirement, made
concrete.

## Recipe ingestion

**URL:** fetch page → schema.org/Recipe JSON-LD (covers the vast majority of
recipe sites; no heavyweight scraper dependency) → microdata fallback → LLM
fallback on the readable text. **Photo:** upload → Qwen VL with a structured
schema → same review screen. **Paste:** many sites (simplyrecipes,
allrecipes, seriouseats) return 403 to anything that isn't a real browser, so
pasted page text goes through the same extraction — which doubles as the
debloater, since the prompt discards the story, ads, nutrition and comments.

**Chat:** each recipe has an ask box for substitutions, scaling, and
technique, with the pantry in the prompt so "what can I swap?" has a useful
answer. Requests to change the recipe come back as a complete proposed
revision you can apply in one tap; applying re-resolves the ingredients
against the pantry. Deliberately two LLM calls — intent/answer first, then a
rewrite — because one call asked to do both wrote the revision into the prose
and left the structured fields empty.

Ingredient lines resolve through a ladder, cheapest first: deterministic
qty/unit parse → ingredient-alias lookup → normalized name match → embedding
similarity (nomic-embed-text; optional, never a blocker) → batched LLM →
`unresolved` (legal, labeled honestly).

## "Cookable tonight"

Presence gates, quantity refines, uncertainty is displayed rather than turned
into a fake "no":

- **Cookable now** — everything's there.
- **Cookable, but check the shelf** — would be cookable, but some ingredient
  hasn't been confirmed in ages ("mushrooms — last seen 5 weeks ago").
- **One thing short** — named: "grab canned tomatoes."
- **Not tonight** — 3+ missing.

Sorted so recipes using items nearest `purchased_at + shelf_life` rise, with a
quiet "uses up: spinach" tag. The spoilage nudge is a **sort order, not a
notification** — the app stays quiet.

## Cook flow

Cook mode: full-screen steps, huge type, keep-screen-on, prev/next as bottom
half-screen tap zones. Zero inventory interaction while cooking. Afterwards, a
confirm screen with one row per ingredient — **used / less / didn't use /
didn't have** — defaulting to "used" so the fast path is one tap. "Didn't
have" quietly writes a `snapshot(out)` event: a free drift correction
harvested from cooking. The whole confirmation is skippable; skipping degrades
confidence, never corrupts.

---

## Build order

Each milestone ends deployable on aria and pokeable from your phone. Receipt
intake goes early on purpose — it's the riskiest subsystem and its learning
loop needs calendar time (real shopping trips) to prove itself.

| # | Milestone | Delivers |
|---|-----------|----------|
| M0 | Walking skeleton: repo, Fastify+Drizzle+migrations, `/health`, OpenAPI page, Dockerfile+compose, deployed via Portainer. | Deploy risk retired |
| M1 | Pantry core: items, ledger, state rollup + rebuild, fuzzy levels, mobile pantry list + per-item "why" screen | An honest pantry |
| M2a | Receipt pipeline, headless: poller, segmentation, aliases, LLM jobs, offline path — tested against your real Paperless receipts before any UI | The hard problem, de-risked |
| M2b | Confirm queue UI on the phone | **Done-criteria 1 & 2** |
| M3 | Recipe import: URL first, then photo | Recipes in |
| M4 | Cookable-tonight screen | **Done-criterion 3** |
| M5 | Cook mode + consume flow | **Done-criterion 4** |
| M6 | Mobile polish: keep-screen-on in cook mode, one-handed audit of every screen on a real phone | **Done-criterion 5** |

From M2b onward, every real grocery trip is a free integration test that also
trains the alias table.

## Deliberately not building (v1)

Per your brief: no nutrition, no price history, no native apps, no multi-user,
no barcode scanning, no notifications of any kind (spoilage stays a sort
order). Additionally parked for v2: shopping list generated from "one thing
short" gaps (the natural next feature — the data model already supports it),
outbound webhooks for n8n (v1 is pull-only API), Litestream off-box backups
(v1 backup = copy the volume), Mealie/Tandoor import, meal planning,
leftovers tracking.

## Calls you might not realize are calls

1. **SQLite over Postgres** — trades away multi-process scale you'll never
   need for radically simpler ops.
2. **Item granularity:** an item is one thing if it's *interchangeable in
   cooking*. Canned vs. fresh tomatoes = two items; no-name vs. Hunt's diced
   tomatoes = one item + two aliases. This rule decides how useful matching is.
3. **Confidence computed from timestamps at read time**, not stored — stored
   decay rots the moment it's written.
4. **Snapshot events over delta-only ledger** — corrections are statements
   about the shelf, not arithmetic.
5. **Batched LLM calls per receipt**, one in flight at a time — forte is a
   shared box; be a polite neighbor.
6. **Vision parsing is a fallback**, not the default — Paperless already OCR'd
   the receipt; use it.
7. **Presence-based matching with quantity as a tiebreaker** — the design
   answer to "silent unit bugs poison everything."
