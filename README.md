# RAB·BIT — Rigor Above Belief · Built for Integrity & Trust

Version 1.0.1 makes archive saving prominent in the Fact-check and Judge pages and robustly maps AI judge results to their rubric gauges.

A workbench for verifying AI output. Express backend on Render, Supabase Postgres
for the audit record, and server-side model connections that keep every secret
out of the browser.

```
server.js          all routes; the only thing that holds secrets
public/index.html  the whole app — one file, no build step
db/schema.sql      Supabase schema + the reporting views
render.yaml        Render blueprint (no secrets in it)
.github/workflows  automatic checks for every GitHub push and pull request
.env.example       what to set locally
```

---

## Why this shape

Three things have to be true, and they decide the architecture:

1. **API keys must never reach the browser.** So the page only ever calls
   same-origin `/api/*` routes, and this server makes the real call.
2. **The record has to be queryable.** Claims and scores are their own rows, not
   a JSON blob. That is what makes "which claim types fail checking" and "which
   model produces the most unsupported claims" answerable at all.
3. **Nothing may pretend to work.** If no key is set, the model selector says so
   and the Run button is disabled. If no database is configured, the archive and
   Reports say so plainly rather than failing on click.

---

## Deploy (about 20 minutes)

### 1. Supabase

Create a project at supabase.com, then **SQL Editor → New query**, paste all of
`db/schema.sql`, run it. That creates three tables, their indexes, four reporting
views, and enables row-level security with no public policy — nothing reaches the
data except through this server.

From **Settings → API Keys**, copy:

- the **Project URL** → `SUPABASE_URL`
- a **secret key** (`sb_secret_...`) → `SUPABASE_SECRET_KEY`

> Use a **secret** key, never a publishable one. It bypasses row-level security,
> which is exactly why this server is the only thing that ever holds it — it must
> not appear in client code. Supabase is retiring the older `service_role` JWT by
> the end of 2026; if your project still shows one, `SUPABASE_SERVICE_KEY` is
> still accepted as a fallback.

### 2. GitHub

Push this folder to a new repo. `.gitignore` already excludes `.env` and
`node_modules/`.

### 3. Render

**New → Web Service**, connect the repo. Render reads `render.yaml`, so the build
and start commands are already set. Leave **Root Directory** blank if this folder
is the repo root — if you nest it, set Root Directory to the folder containing
`package.json`, and confirm it under Settings → Build before assuming.

Then **Environment → Add Environment Variable** for each:

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | for Claude models | platform.claude.com → API keys |
| `OPENAI_API_KEY` | optional | omit and the GPT models simply aren't offered |
| `SUPABASE_URL` | for the archive | from Supabase settings |
| `SUPABASE_SECRET_KEY` | for the archive | a secret key, `sb_secret_...` |
| `RAB_USERNAME` / `RAB_PASSWORD` | strongly recommended | protects the entire workbench and its model credits with browser sign-in |
| `RAB_ASK_DAILY_LIMIT` | optional | daily Ask AI ceiling; defaults to 100 questions |
| `MODEL_QUICK` / `MODEL_DEFAULT` / `MODEL_COMPLEX` | optional | choose a catalog model for each internal tier |
| `ANTHROPIC_MODEL_*` / `OPENAI_MODEL_*` | optional | update provider API IDs without changing the app when a vendor renames a model |

Deploy. `/healthz` reports what is actually configured, which is the fastest way
to confirm the environment took.

### 4. Custom domain

Render → Settings → Custom Domain. Add the CNAME it gives you at your DNS host.
TLS is issued automatically.

---

## The one thing to decide before launch

The included Blueprint starts on Render's free web-service plan. Free services
can take longer to answer after being idle. Move to a paid compute plan later if
you need the workbench to respond immediately at all times.

Set `RAB_USERNAME` and `RAB_PASSWORD` before sharing the URL. When both are set,
the entire workbench is protected by browser sign-in while `/healthz` remains
available to Render. For a larger team, replace this simple gate with Supabase
Auth or your company identity provider so each reviewer has an individual login.

The **Ask AI** workflow uses the site owner's `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`, depending on the model selected. Its API route refuses to
run unless browser sign-in is enabled. It is limited to 8 questions per minute
and 100 per day by default. Set `RAB_ASK_DAILY_LIMIT` in Render if you want a
different daily ceiling.

Add a spend limit at your model provider regardless.

---

## What is enforced in code

- **Model allowlist** — `MODEL_CATALOG` in `server.js` is both the menu and the
  gate. A crafted request cannot make this server call a model that is not listed.
- 64 KB input cap, 4096 output tokens.
- Streaming is normalised server-side: both vendors' event formats become one
  `{delta}` / `{done,text}` shape, so the browser has no provider-specific code.
- Temperature is clamped 0–1 and **is live here** — it is sent with every run.
  Internal calls (claim extraction, second opinion, judge) are pinned at 0
  regardless of the dial, because those must not vary between runs.

Model calls are limited per IP to reduce accidental loops and casual API-credit
abuse. This built-in limiter is appropriate for a single Render instance. If you
scale to multiple instances, replace it with a shared Redis-backed limiter.

---

## Reports

The Reports panel reads `/api/reports`, which is backed by the SQL views in
`db/schema.sql`:

| View | Answers |
|---|---|
| `v_claim_type_quality` | Which kinds of claim fail checking most often |
| `v_model_quality` | Which model produces answers that survive review |
| `v_review_discipline` | How often a refuted claim was recorded with no source — the honesty check |
| `v_audits_weekly` | Volume over time |

Because these are database views rather than app code, you can point Metabase,
Looker, Power BI or a notebook straight at Supabase and get the same numbers
without going through the app.

**On the charts:** no reading in this dashboard depends on telling two colours
apart. Red and amber sit 2.2 ΔE apart under deuteranopia — a stacked verdict bar
would be unreadable for a large minority of people — so every bar carries its own
written label and its own number, and magnitude charts use a single hue.

---

## Local development

```bash
cp .env.example .env      # fill it in
npm ci
node --env-file=.env server.js
```

Open http://localhost:3000. `/healthz` tells you what is wired up.

---

## Model IDs get retired

When a run starts failing with `upstream_rejected`, check the provider's current
model list and update the matching `ANTHROPIC_MODEL_*` or `OPENAI_MODEL_*`
environment variable. The stable IDs stored in audit records do not need to
change just because a provider changes an API model name.
