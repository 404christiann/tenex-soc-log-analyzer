# Tenex SOC Log Analyzer

A full-stack tool for a SOC analyst to upload a web proxy log, get it parsed into a readable
timeline, and see likely anomalies highlighted with an explanation and a confidence score —
built as a take-home for Tenex Engineering.

A user signs in passwordlessly (a 6-digit one-time code emailed by Supabase Auth — the account
is created transparently on first sign-in), uploads a synthetic Zscaler-style web proxy log
file, and the backend:

1. Validates the upload (extension, size, binary/content checks) before anything is persisted.
2. Parses it (tab-separated, NSS-style `key=value` fields) into structured events.
3. Runs a deterministic rule engine over the events to flag anomalies with a base confidence
   score.
4. Optionally sends the flagged anomalies to an LLM judge that can refine (never invent) them,
   and generates an LLM narrative summary of the timeline.

The frontend displays the parsed events, the highlighted anomalies (with both the rule engine's
base confidence and the LLM's adjusted confidence, plus its explanation), and the narrative
summary.

**Stack:** Next.js + TypeScript + shadcn/ui for the frontend, Express + TypeScript for the
backend, Supabase (Postgres + Auth + Storage, with Row Level Security) for data/auth/storage,
npm workspaces for the monorepo.

**Live demo:** https://tenex-soc-log-analyzer.vercel.app — sign in with any email (a real
6-digit code gets sent), then upload one of the files from [`examples/`](./examples/). No local
setup required to try it; the instructions below are for running/modifying the code.

---

## Local setup

These steps take you from a clean clone to both dev servers running against a fresh Supabase
project.

### Prerequisites

- **Node.js 20+** and npm (npm workspaces handle the monorepo — no separate package manager).
- **A Supabase account.** Use a fresh/dedicated project — migrations create tables and a
  storage bucket directly.
- **(Optional) Supabase CLI** — only needed to apply migrations from the command line instead
  of pasting SQL into the dashboard, or to run against a fully local Supabase stack (which also
  needs **Docker**, since `supabase start` boots Postgres/Auth/Storage in containers).
- **(Optional) An Anthropic API key.** The app is fully functional without one — the LLM judge
  and timeline summary degrade to an honest "not configured" state instead of breaking anything
  (see [AI usage](#ai-usage)).

### 1. Clone and install

```bash
git clone <this-repo-url>
cd tenex-soc-log-analyzer
npm install
```

This installs all three workspaces (`apps/web`, `apps/api`, `packages/shared`) in one pass.

### 2. Create a new Supabase project

1. Create a new project at [supabase.com](https://supabase.com) (any name/region).
2. In **Project Settings → API**, note down the **Project URL**, the **`anon` public key**, and
   the **`service_role` key** (server-side only — never expose it to the browser).
3. Check **Project Settings → API → JWT Settings**. If your project shows a legacy shared JWT
   secret (older projects sign access tokens with HS256), note it down too. Newer projects use
   asymmetric JWT signing keys and expose no shared secret — that's fine; the backend then
   verifies tokens against the project's public JWKS endpoint automatically, and this variable
   stays blank.

### 3. Apply the database migrations

The schema, Row Level Security policies, and the private Storage bucket all live in
[`supabase/migrations/`](./supabase/migrations/) as ordered, idempotent files:

- `0001_init.sql` — core tables (`log_files`, `log_events`, `anomalies`, `timeline_summaries`)
- `0002_rls.sql` — enables RLS on every table and creates the private `log-uploads` Storage
  bucket + its object-level policies
- `0003_data_api_grants.sql` — explicit role grants for `anon`/`authenticated`/`service_role`.
  **Required on any freshly created Supabase project** — new projects no longer auto-expose
  tables to the Data API, so without this every request fails with `permission denied for
  table ...` even though the RLS policies are correct.
- `0004`–`0007` — later additions (decoupled summary state, the beaconing rule type, and two
  grant-tightening migrations from a security self-review).

Run them **in order**, either way:

**Via the Supabase CLI:**

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

**Or via the dashboard:** open the SQL Editor and paste/run each file in numeric order.

If the SQL Editor's role can't write to `storage.buckets` directly (some hosted setups restrict
this), `0002_rls.sql`'s header comments explain the one manual fallback step (create the
private `log-uploads` bucket from the Storage tab, then re-run the rest of that file).

### 4. Configure environment variables

Two separate env files — one per app, since the frontend only ever gets the public-safe values
(prefixed `NEXT_PUBLIC_`).

**`apps/api/.env`** — copy the root [`.env.example`](./.env.example) and fill it in:

```bash
cp .env.example apps/api/.env
```

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 2 |
| `SUPABASE_ANON_KEY` | `anon` public key from step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key from step 2 |
| `SUPABASE_JWT_SECRET` | Legacy shared JWT secret, if your project has one; blank otherwise |
| `ANTHROPIC_API_KEY` | Optional — omit to run without AI features |
| `FRONTEND_ORIGIN` | `http://localhost:3000` (default, used for CORS) |
| `PORT` | `4000` (default) |

**`apps/web/.env.local`** — create this file (no template; none of these values are secret —
`NEXT_PUBLIC_*` variables are compiled into the client bundle by design):

```bash
NEXT_PUBLIC_SUPABASE_URL=<same Project URL as above>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<same anon key as above>
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### 5. Run the dev servers

Two terminals, from the repo root:

```bash
npm run dev:api   # Express on http://localhost:4000
npm run dev:web   # Next.js on http://localhost:3000
```

Open `http://localhost:3000` and sign in: enter any email address and Supabase Auth emails a
6-digit code (`signInWithOtp` — the account is created transparently on first use; there is no
separate signup screen). Then upload a log file from `examples/`.

**Where the code arrives locally:** against the local Supabase stack no email is really
delivered — the stack's built-in catcher (Mailpit, enabled via `[local_smtp]` in
`supabase/config.toml`) intercepts it. Open **http://localhost:55324** to read the 6-digit
code, then type it into the app's PIN input. Against a *hosted* Supabase project, Supabase's
built-in email service works without extra setup but is deliberately throttled to ~2 emails per
hour — fine for a single manual sign-in; see the SMTP note below for anything more.

### 6. Hosted deploys only — custom SMTP for sign-in codes

Skip this for local development. For a real hosted project (e.g. the deployed demo), a custom
SMTP provider (Resend) is configured **in the Supabase dashboard** (**Authentication → Email →
SMTP Settings**) so sign-in-code emails aren't limited by the built-in ~2/hour throttle:
host `smtp.resend.com`, port `465`, username `resend` (Resend's fixed SMTP username), password =
the Resend API key, and sender = an address on a Resend-verified domain. The **Confirm signup**
and **Magic Link** email templates must include `{{ .Token }}` so Supabase sends the numeric
code instead of a magic-link URL (local equivalents: `supabase/templates/otp_code.html`, wired
up in `supabase/config.toml`). Nothing in this repo reads or stores any of these values.

> **Gotcha, found on the live deploy:** if the sender email is left at Resend's sandbox default
> (`onboarding@resend.dev`), sign-in *appears* configured but fails for every email except the
> Resend account owner's — the sandbox address only delivers to its own account. The symptom is
> a generic `Error sending confirmation email` (a 500 from Supabase Auth, not a 429 rate
> limit). Fix: set the sender to an address on the verified domain.

### 7. (Optional) Regenerate the example log files

The four files in `examples/` are generated deterministically (fixed faker seed) and already
committed, so this isn't required to run the app:

```bash
npm run generate-logs    # regenerates all four example files
npm run validate-logs    # self-check: confirms clean-traffic.log never crosses a rule threshold
```

See [`examples/README.md`](./examples/README.md) for what each file demonstrates.

### 8. Run the test suites

```bash
npm run typecheck                          # all three workspaces
npm test --workspace=apps/api              # backend unit + integration tests (vitest)
npm run test:e2e --workspace=apps/web      # whole-system E2E suite (Playwright)
```

`apps/api`'s suite covers the parser, rule engine, upload validation, auth middleware, and LLM
layer, plus an integration test for the upload route (the integration and live-LLM tests need a
local Supabase stack — see their doc comments for the one-time setup).

`apps/web/e2e/` is a whole-system Playwright suite: a real Chromium browser against the real
Next.js dev server, the real Express API, and a real local Supabase stack — nothing mocked.
`playwright.config.ts` starts both dev servers itself but expects the Supabase stack to already
be up (`supabase status` / `supabase start`). The auth helpers drive the real passwordless
flow, reading the actual 6-digit code out of the local Mailpit catcher's REST API. Coverage:
first-time OTP sign-in, wrong-code and resend/cooldown paths, the unauthenticated-redirect
boundary and sign-out, the full upload → parse → detect → results flow (asserting a specific
known anomaly from `examples/ANSWER_KEY.md`), RLS isolation between two real signed-in users
through the actual UI, and client-side upload validation.

---

## Anomaly detection approach

Detection is deliberately **two layers**: a deterministic rule engine that does the actual
detecting, and a bounded LLM judge that can only refine what the rules already found. This
split exists so every flagged anomaly stays auditable — "why was this flagged" always has a
concrete, inspectable answer (a rule and a number), never just "the model said so."

### Layer 1 — deterministic rule engine

Eight rules run over every parsed event. Each rule assigns a **base confidence score** using
one of two strategies, chosen by what kind of signal it is:

- **Fixed confidence** for direct signals — things that are already confirmed-bad, not
  inferred (e.g. a populated threat name). A statistical score would understate how sure we
  actually are.
- **Statistical confidence** for distributional signals — z-scores, percentiles, or (for
  beaconing) a coefficient of variation, all computed against *that file's own* baseline rather
  than a guessed constant, so the score self-calibrates to whatever traffic pattern is in the
  uploaded file.

The eight rules:

1. **Threat name populated** — the proxy vendor itself identified a known threat on this
   request. A confirmed-bad direct signal.
2. **Malware-category access** — the destination falls in a high-risk category (malware,
   phishing, botnet callback, spyware/adware). Also a direct signal.
3. **Data exfiltration outlier** — an unusually large upload (`bytes_out` on a POST/PUT),
   measured as a z-score against the file's own distribution.
4. **Burst per IP** — one IP firing far more requests per minute than that file's own
   traffic pattern would suggest.
5. **Repeated blocked attempts** — the same user/IP getting blocked repeatedly in a short
   window, suggestive of probing or a misconfigured/compromised client.
6. **Off-hours access** — activity outside a fixed business-hours window, a weaker,
   contextual signal on its own.
7. **Rare or scripted user-agent** — a known automation signature (`curl`, `python-requests`,
   `wget`, an empty UA) or a user-agent statistically rare in the file, both associated with
   reconnaissance/automation rather than a human browsing.
8. **Beaconing (interval regularity)** — one IP hitting the same destination host at
   suspiciously *regular* intervals (a low coefficient of variation between consecutive
   request timestamps), the classic command-and-control check-in signature. Distinct from
   burst-per-IP: a burst is about *volume*, a beacon is about *regularity* — a beacon doesn't
   need to be fast, it needs to be mechanically even. Known tradeoff: like real beaconing
   detectors, it can also flag legitimate highly-regular polling traffic (streaming
   keep-alives, mail sync) — triaging that is exactly what the LLM judge layer is for.

When more than one rule fires on the same event, the anomaly shows the **highest** confidence
among them and lists every rule that triggered — not a combined/averaged score. A probabilistic
combination was considered and rejected: a strongest-signal-plus-full-reason-list is far easier
to defend and re-derive by hand than a blended score.

All thresholds and constants (exact z-score cutoffs, window sizes, confidence ranges) live in
one commented file: [`apps/api/src/rules/config.ts`](./apps/api/src/rules/config.ts).

### Layer 2 — bounded LLM judge

The judge runs **only** on the candidates Layer 1 already flagged. It cannot invent a new
anomaly, and it cannot fully override Layer 1's score — it can only:

- Nudge the confidence within **±15 points** of the base score.
- Rewrite the explanation with more context (e.g. distinguishing "large upload to a known SaaS
  backup domain" from "large upload to an unrecognized domain" — genuinely open-ended judgment
  the rule engine can't express as a threshold).

Why this split instead of letting the LLM decide anomalies from scratch: an LLM freely deciding
what's anomalous is both unexplainable and inconsistent run-to-run. Keeping detection
deterministic and using the LLM only to refine an already-real finding keeps every score
auditable — "it's math I wrote, with an LLM allowed to adjust it by a bounded amount" — while
still getting real value from the model's judgment where rules genuinely can't reach.

Guardrails, concretely:

- **Capped at the top 20** candidates by Layer 1 confidence, per file, in one batched call.
  Anything beyond the cap keeps Layer 1's templated explanation — explicitly capped, never
  silently dropped.
- **Structured output**: the model is forced into tool-calling against a defined JSON schema
  (event index, confidence delta, explanation string), not freeform text parsing — a security
  property as well as a robustness one (see [Security highlights](#security-highlights)).
- Each candidate is explicitly indexed in the prompt so the model can't merge, renumber, or
  invent entries.

### Timeline summary

Separately from the judge, an LLM generates the human-readable narrative summary the take-home
asks for ("a summarized timeline of events"). This is a low-risk use of the model — it
summarizes facts the pipeline already computed; it never decides what counts as anomalous.

---

## AI usage

Two distinct things worth separating clearly:

### 1. AI used in the product

- **LLM judge (Layer 2 above): Claude Sonnet 5.** This step needs actual contextual judgment
  (e.g. "is this destination plausible for a backup upload"), which is where a stronger model
  earns its cost.
- **Timeline summary: Claude Haiku 4.5.** Pure summarization of already-structured data — a
  cheaper, faster model is the right fit; reserving the stronger model for the step that
  actually needs reasoning is a deliberate cost choice, not a fallback.
- Both are Anthropic models — one SDK, one API key. A second provider for the cheap step was
  considered and rejected: at this volume the cost difference is a few cents per uploaded file,
  not worth a second API key, SDK, and failure path.
- **Graceful degradation is a must-have, not an afterthought.** The app runs completely without
  an `ANTHROPIC_API_KEY` — the judge and summary each report their own honest status
  (`not_configured`, `failed` with the actual reason, or `ok`) rather than silently disabling.
  A reviewer can evaluate the entire app — parsing, rule-based detection, auth, upload
  validation — without ever obtaining a key; the AI layer is opt-in, not a hard blocker.

### 2. AI used to build the project

Claude Code was used as a development tool throughout — disclosed here rather than downplayed,
since the take-home's ground rules explicitly encourage it.

The process: before any code was written, the architecture went through a structured
design interview — a back-and-forth interrogating every design choice (log format and fields,
the two-layer detection split, model selection, database/auth approach, monorepo tooling,
security posture) until each had an explicit, defensible rationale, recorded in a running
decisions log. Only after that record existed did implementation start, delegated
phase-by-phase to subagents working from the plan and the decisions record — including this
documentation. The rationale summaries in this README, and the decision references in code
comments, come from that log.

---

## Security highlights

- **Passwordless auth (emailed one-time codes) + session cookies via Supabase Auth**, not
  hand-rolled. There are no passwords anywhere — nothing to hash, leak, or reuse — and all of
  the security-critical OTP machinery (code generation, expiry, single-use enforcement,
  verification, rate limiting) is Supabase Auth's built-in, unmodified system; this codebase is
  only UI over `signInWithOtp`/`verifyOtp`. Sessions use httpOnly, secure, `sameSite`
  cookies — never `localStorage`, which any script that gets XSS'd onto the page can read.
- **Row Level Security enforced at the database layer**, not just filtered in application code.
  Every table's RLS policy checks `user_id = auth.uid()`, and the Express API builds a
  per-request Supabase client scoped to the *caller's own JWT* for all reads — Postgres itself
  decides which rows come back. Even if an API route forgot a `WHERE user_id = ...` clause, the
  database cannot return another user's rows, because the check lives in Postgres policy SQL,
  not in application code that could have a bug. (The service-role key, which bypasses RLS, is
  used only where structurally required — the Storage upload write and the initial row inserts
  during processing — never for a client-facing read.)
- **Least-privilege grants, caught in a self-review.** A later security pass found the
  `authenticated` role still had `insert`/`update`/`delete` grants on all four tables and the
  upload bucket — never a cross-tenant read risk thanks to RLS, but unused write surface no
  legitimate code path needed (every write goes through the service-role client). Tightened to
  `select`-only in migrations `0006`/`0007`, verified against the integration suite before and
  after applying.
- **Upload validation before anything is persisted**, in a fixed order, all independently
  unit-tested pure functions: extension allowlist (`.log`/`.txt`), a 10MB size cap, filename
  sanitization (rejects path traversal and control characters), known binary file-signature
  rejection (PDF/ZIP-Office/PNG/JPEG/ELF magic bytes), null-byte rejection, threshold-based
  UTF-8 validation (rejects only if >2% of decoded bytes are invalid, so a mostly-text log with
  a few corrupted bytes still parses), and a content-shape check on the first line. Nothing
  touches Storage or the database until every check passes.
- **Parameterized queries throughout** — all database access goes through the Supabase
  client/query builder, never raw string-interpolated SQL.
- **Input validation on every endpoint**, via Zod schemas shared between frontend and backend
  (`packages/shared`), so the same shape is enforced on both sides of the request.
- **Prompt-injection awareness for the LLM layer**: log content is attacker-controllable text
  (anything can appear in a `url` or `user_agent` field) and it's fed into LLM prompts. It's
  delimited explicitly as untrusted data, never concatenated as instruction text. More
  importantly, the *architecture* limits the blast radius: because the judge can only reword or
  reweight (±15 points) an anomaly Layer 1 already found, a successful injection's worst case
  is a misleading explanation on a real finding — never a fabricated or suppressed one.

---

## Stretch items — all implemented

Four items were originally scoped as stretch goals and deferred; all four are now done:

- **Rate limiting** — `POST /api/logs/upload` and `GET /api/logs/:id/summary/stream` (the two
  expensive/abusable routes — the second makes a real, billed LLM call on a cache miss) sit
  behind a per-IP `express-rate-limit` (`apps/api/src/middleware/rate-limit.ts`). Sign-in was
  never a gap: the passwordless flow inherits Supabase Auth's own OTP send/verify rate limits,
  and there is no server-side login endpoint in this API to protect.
- **Hardened security headers and CORS** — `helmet()` (one deliberate override:
  `Cross-Origin-Resource-Policy: cross-origin`, since web and api are different origins even in
  local dev) plus CORS explicit about methods (`GET`/`POST` only), headers
  (`Content-Type`/`Authorization` only), and `credentials: false` (every request carries a
  Bearer token; no cookie crosses this boundary). See `apps/api/src/app.ts`.
- **Cloud deployment** — frontend on Vercel, backend on Render, Supabase cloud-hosted.
  Render's free-tier cold-start risk is mitigated with an external keep-alive ping
  (cron-job.org, every 10 minutes) rather than left unresolved.
- **Beaconing detection** — the 8th anomaly rule (see the rule list above, including its known
  false-positive tradeoff on legitimate regular polling traffic).

---

## Why a simplified log format

The real Zscaler NSS feed spec has 100+ fields. This project uses a deliberately scoped subset
of 12 (`datetime`, `cip`, `login`, `url`, `action`, `urlcat`, `threatname`, `respcode`,
`bytes_out`, `bytes_in`, `useragent`, `reqmethod`), each chosen because it directly earns its
place in either a detection rule or the timeline view — not because parsing the full spec was
out of reach. Tenex's own product is an AI SOC analyst platform, so a proxy/security log format
is more domain-relevant than a generic access log; but faithfully implementing the entire
proprietary NSS spec would burn most of the time budget on field-plumbing rather than the parts
actually being evaluated — detection logic, security posture, and product design. Scoping it
down, and being explicit about why, is the intended signal.
