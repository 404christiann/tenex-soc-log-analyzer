# Tenex SOC Log Analyzer

A full-stack tool for a SOC analyst to upload a web proxy log, get it parsed into a readable
timeline, and see likely anomalies highlighted with an explanation and a confidence score —
built as a take-home for Tenex Engineering.

A user signs in passwordlessly (a 6-digit one-time code emailed by Supabase Auth — the account
is created transparently on first sign-in, there is no separate signup), uploads a synthetic
Zscaler-style web proxy log file, and the backend:

1. Validates the upload (extension, size, binary/content checks) before anything is persisted.
2. Parses it (tab-separated, NSS-style `key=value` fields) into structured events.
3. Runs a deterministic rule engine over the events to flag anomalies with a base confidence
   score.
4. Optionally sends the flagged anomalies to an LLM judge that can refine (never invent) them,
   and generates an LLM narrative summary of the timeline.

The frontend displays the parsed events, the highlighted anomalies (with both the rule engine's
base confidence and the LLM's adjusted confidence, plus its explanation), and the narrative
summary.

**Stack:** Next.js + TypeScript + shadcn/ui (light mode only) for the frontend, Express +
TypeScript for the backend, Supabase (Postgres + Auth + Storage, with Row Level Security) for
data/auth/storage, npm workspaces for the monorepo.

For the full reasoning behind every decision below — including ones this README only
summarizes — see [`DECISIONS.md`](./DECISIONS.md), the running record of the architecture
interview this project was designed from before any code was written.

---

## Local setup

These steps take you from a clean clone to both dev servers running against a fresh Supabase
project.

### Prerequisites

- **Node.js 20+** and npm (npm workspaces are used for the monorepo, no separate package manager
  needed).
- **A Supabase account.** Use a fresh/dedicated project for this — don't reuse an existing
  unrelated project, since migrations create tables and a storage bucket directly.
- **(Optional) Supabase CLI** — only needed if you want to apply migrations from the command
  line instead of pasting SQL into the dashboard, or if you want to run the app against a fully
  local Supabase stack instead of a hosted project. The local-stack path also needs **Docker**
  running, since `supabase start` boots Postgres/Auth/Storage/etc. in containers.
- **An Anthropic API key** — optional. The app is fully functional without one; the LLM judge
  and timeline summary degrade to an honest "not configured" state instead of breaking anything
  (see [AI usage](#ai-usage) below).

### 1. Clone and install

```bash
git clone <this-repo-url>
cd tenex-soc-log-analyzer
npm install
```

This installs dependencies for all three workspaces (`apps/web`, `apps/api`,
`packages/shared`) from the root in one pass.

### 2. Create a new Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project (any name/region).
2. Once it's provisioned, go to **Project Settings → API** and note down:
   - **Project URL**
   - **`anon` public key**
   - **`service_role` key** (server-side only — never expose this to the browser)
3. Check **Project Settings → API → JWT Settings**. If your project shows a legacy shared JWT
   secret (older Supabase projects sign access tokens with HS256), note it down too. Newer
   projects use asymmetric "JWT Signing Keys" by default and don't expose a shared secret at
   all — that's fine, the backend verifies those tokens against the project's public JWKS
   endpoint automatically instead, and this variable can be left blank.

### 3. Apply the database migrations

The schema, Row Level Security policies, and the private Storage bucket all live in
[`supabase/migrations/`](./supabase/migrations/), as three ordered, idempotent files:

- `0001_init.sql` — core tables (`log_files`, `log_events`, `anomalies`, `timeline_summaries`)
- `0002_rls.sql` — enables RLS on every table and creates the private `log-uploads` Storage
  bucket + its object-level policies
- `0003_data_api_grants.sql` — explicit role grants for `anon`/`authenticated`/`service_role`.
  **Required on any freshly created Supabase project** — new projects no longer
  auto-expose tables to the Data API, so without this migration every request fails with
  `permission denied for table ...` even though the RLS policies themselves are correct.

Run them **in order**, either way:

**Via the Supabase CLI:**

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

**Or via the dashboard:** open the SQL Editor and paste/run the contents of
`0001_init.sql`, then `0002_rls.sql`, then `0003_data_api_grants.sql`, in that order.

If the SQL Editor's role can't write to `storage.buckets` directly (some hosted setups
restrict this), `0002_rls.sql`'s own header comments explain the one manual fallback step
(create the `log-uploads` bucket — private — from the Storage tab, then re-run the rest of that
file for the policies).

### 4. Configure environment variables

There are **two** separate env files — one per app, since the backend and frontend need
different variable names (the frontend only ever gets the public-safe values, prefixed
`NEXT_PUBLIC_`).

**`apps/api/.env`** — copy the root [`.env.example`](./.env.example) here and fill it in:

```bash
cp .env.example apps/api/.env
```

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 2 |
| `SUPABASE_ANON_KEY` | `anon` public key from step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key from step 2 |
| `SUPABASE_JWT_SECRET` | Legacy shared JWT secret from step 2, if your project has one; leave blank otherwise |
| `ANTHROPIC_API_KEY` | Optional — omit to run without AI features |
| `FRONTEND_ORIGIN` | `http://localhost:3000` (default, used for CORS) |
| `PORT` | `4000` (default) |

**`apps/web/.env.local`** — create this file (no template exists for it since none of these
values are secret; `NEXT_PUBLIC_*` variables are compiled into the client bundle by design):

```bash
NEXT_PUBLIC_SUPABASE_URL=<same Project URL as above>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<same anon key as above>
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### 4b. Hosted project only — configure SMTP so sign-in codes actually get delivered

> **Skip this entirely for local development.** The local Supabase stack catches all auth
> emails in Mailpit (see step 5) and never sends real mail, so no SMTP provider is involved.
> This step matters only once a real hosted Supabase project exists (e.g. for the deployed
> demo): without it, sign-in-code emails go through Supabase's **built-in email service, which
> is deliberately rate-limited to ~2 emails per hour** (it's meant for testing only — this is
> exactly the "2 attempts, then a 1-hour wait" behavior documented in DECISIONS.md §14d).

Configure a custom SMTP provider (Resend) **in the Supabase dashboard** — this is purely a
dashboard setting; nothing in this repo reads or stores any of these values, and the Resend
API key must never be committed to this repo or any env file:

1. In [Resend](https://resend.com): verify the sending domain (`tenexai.onziofutbol.com` — a
   dedicated subdomain per DECISIONS.md §14d; Resend hands back SPF/DKIM DNS records to add at
   the registrar) and create an API key.
2. In the Supabase dashboard: **Authentication → Email → SMTP Settings**, enable custom SMTP
   with:

   | Setting | Value |
   |---|---|
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` (literally — Resend's fixed SMTP username) |
   | Password | the Resend **API key** (Resend uses the API key as the SMTP password) |
   | Sender email | something at the verified domain, e.g. `auth@tenexai.onziofutbol.com` |
   | Sender name | `Tenex SOC Log Analyzer` |

3. Also in the dashboard, edit the **Confirm signup** and **Magic Link** email templates to
   include the `{{ .Token }}` variable — that's what makes Supabase send the numeric 6-digit
   code instead of a magic-link URL (the local equivalents live in
   `supabase/templates/otp_code.html`, wired up in `supabase/config.toml`).

### 5. Run the dev servers

Two terminals, from the repo root:

```bash
npm run dev:api   # Express on http://localhost:4000
npm run dev:web   # Next.js on http://localhost:3000
```

Open `http://localhost:3000` and sign in: enter any email address, and Supabase Auth emails a
6-digit code (`signInWithOtp` — the account is created transparently the first time an address
is used; there is no separate signup screen). Then upload a log file from `examples/`.

**Where the code arrives locally:** when running against the local Supabase stack, no email is
ever really delivered — the stack's built-in email catcher (Mailpit, enabled via `[local_smtp]`
in `supabase/config.toml`) intercepts it. Open **http://localhost:55324** to read the 6-digit
code, then type it into the app's PIN input. (If you're running against a *hosted* Supabase
project instead, see the SMTP step below — without it, Supabase's built-in email service works
but is deliberately throttled to ~2 emails per hour, which is fine for a single manual sign-in
and useless for anything more.)

### 6. (Optional) Regenerate the example log files

The four files in `examples/` are generated deterministically (fixed faker seed) and already
committed, so this step isn't required to run the app — it's here in case you want to inspect
or modify the generator:

```bash
npm run generate-logs    # regenerates all four example files
npm run validate-logs    # self-check: confirms clean-traffic.log never crosses a rule threshold
```

See [`examples/README.md`](./examples/README.md) for what each file demonstrates.

### 7. Run the test suites

```bash
npm run typecheck                          # all three workspaces
npm test --workspace=apps/api              # backend unit + integration tests (vitest)
npm run test:e2e --workspace=apps/web      # whole-system E2E suite (Playwright)
```

`apps/api`'s suite includes unit tests for the parser, rule engine, upload validation, auth
middleware, and LLM layer, plus an integration test for the upload route (both of the latter two
need a local Supabase stack — see their own doc comments for the one-time setup).

`apps/web/e2e/` is a comprehensive, automated **whole-system integration suite** (Playwright),
formalizing what earlier phases verified only by hand in a browser. It drives a real Chromium
browser against the real Next.js dev server, the real Express API, and a real local Supabase
stack — nothing mocked. `apps/web/playwright.config.ts` starts both dev servers itself (reusing
them if already running) but expects the Supabase stack to already be up (`supabase status` to
check, `supabase start` if not — same disposable local stack `apps/api`'s integration tests use).
The auth helpers drive the real passwordless flow: they request a code through the UI, read the
**actual 6-digit code** GoTrue emailed out of the local Mailpit catcher's REST API (port 55324 —
never guessed, faked, or mocked), and type it into the real PIN input.
Covers: first-time OTP sign-in → authenticated dashboard (account created transparently — the
suite also asserts the removed `/signup` route bounces to `/login`), the wrong-code inline-error
path plus recovery with the genuine code, resend (verified by a second real email landing in the
catcher) and its cooldown, the change-email back link, the unauthenticated-redirect boundary and
a real sign-out/sign-back-in, the full upload → parse → detect → results flow (including the
`not_configured` LLM-status banner and a specific known anomaly from `examples/ANSWER_KEY.md`),
RLS isolation between two real signed-in users navigating the actual UI (not just an API check),
and client-side upload validation rejecting a wrong-extension file before any network call.

---

## Anomaly detection approach

Detection is deliberately **two layers**: a deterministic rule engine that does the actual
detecting, and a bounded LLM judge that can only refine what the rules already found. This
split exists so every flagged anomaly stays auditable — "why was this flagged" always has a
concrete, inspectable answer (a rule and a number), never just "the model said so."

### Layer 1 — deterministic rule engine

Seven rules run over every parsed event. Each rule assigns a **base confidence score** using
one of two strategies, chosen per rule based on what kind of signal it is:

- **Fixed confidence** for direct signals — things that are already confirmed-bad, not
  inferred (e.g. a populated threat name). A statistical score would understate how sure we
  actually are.
- **Statistical confidence** for volume/size signals — z-scores or percentiles computed
  against *that file's own* baseline, rather than a guessed constant, so the score is
  self-calibrating to whatever traffic pattern is in the uploaded file.

The seven rules:

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
   `wget`, an empty UA) or a user-agent that's statistically rare in the file, both associated
   with reconnaissance/automation rather than a human browsing.

When more than one rule fires on the same event, the anomaly shows the **highest** confidence
among them and lists every rule that triggered — not a combined/averaged score. A probabilistic
combination across rules was considered and rejected: it looks more sophisticated, but a
strongest-signal-plus-full-reason-list is much easier to defend and explain than a blended
score nobody can re-derive by hand.

Full thresholds and constants (exact z-score cutoffs, window sizes, confidence ranges) live in
one commented file, `apps/api/src/rules/config.ts`, and the full table is in DECISIONS.md §14a.

### Layer 2 — bounded LLM judge

The judge runs **only** on the candidates Layer 1 already flagged. It cannot invent a new
anomaly, and it cannot fully override Layer 1's score — it can only:

- Nudge the confidence within **±15 points** of the base score.
- Rewrite the explanation with more context (e.g. distinguishing "large upload to a known SaaS
  backup domain" from "large upload to an unrecognized domain" — a distinction the rule engine
  alone can't express, since it's genuinely open-ended judgment rather than a threshold).

Why this split instead of letting the LLM decide anomalies from scratch: an LLM freely deciding
what's anomalous is both unexplainable ("why did this get flagged?" has no concrete answer) and
inconsistent run-to-run. Keeping detection deterministic and using the LLM only to refine an
already-real finding keeps every score auditable — "it's math I wrote, with an LLM allowed to
adjust it by a bounded amount" — while still getting real value from the model's judgment where
rules genuinely can't reach.

Guardrails, concretely:

- **Capped at the top 20** candidates by Layer 1 confidence, per file, in one batched call
  (not one call per anomaly). Anything beyond the cap keeps Layer 1's templated explanation —
  explicitly capped, never silently dropped.
- **Structured output**: the model is forced into tool-calling against a defined JSON schema
  (event index, confidence delta, explanation string), not freeform text parsing. This is also
  a security property, not just robustness — see [Security highlights](#security-highlights).
- Each candidate is explicitly indexed in the prompt so the model can't merge, renumber, or
  invent entries.

### Timeline summary

Separately from the judge, an LLM generates the human-readable narrative summary the take-home
asks for ("a summarized timeline of events"). This is a low-risk use of the model — it's
summarizing facts the pipeline already computed, not deciding what counts as anomalous.

---

## AI usage

Two distinct things worth separating clearly:

### 1. AI used in the product

- **LLM judge (Layer 2 above): Claude Sonnet 5.** This step needs actual contextual judgment
  (e.g. "is this destination plausible for a backup upload"), which is where a stronger model
  earns its cost.
- **Timeline summary: Claude Haiku 4.5.** Pure summarization of already-structured data — a
  cheaper, faster model is the right fit, and reserving the stronger model for the step that
  actually needs reasoning is a deliberate cost-conscious choice, not a fallback.
- Both are Anthropic models, one SDK, one API key. A cheaper "fast" model from a second
  provider was considered and rejected — at this project's volume, the entire cost difference
  between an all-Haiku and a Sonnet+Haiku pipeline is on the order of a few cents per uploaded
  file, not worth a second API key, SDK, and failure path to maintain and explain.
- **Graceful degradation is a must-have, not an afterthought.** The app runs completely without
  an `ANTHROPIC_API_KEY` set — the judge and summary each report their own honest status
  (`not_configured`, `failed` with the actual reason, or `ok`) rather than silently disabling or
  generically erroring. A reviewer can clone this repo and evaluate the entire app — parsing,
  rule-based detection, auth, upload validation — without ever obtaining an Anthropic key; the
  AI layer is something you opt into to see the enhanced version, not a hard blocker.

### 2. AI used to build the project

Claude Code was used as a development tool throughout, and that's disclosed here rather than
downplayed — the take-home's own ground rules explicitly encourage this.

The process: before any code was written, the architecture went through a `/grill-me`-style
interview — a structured back-and-forth interrogating every design choice (log format and
fields, the two-layer detection split, model selection, database/auth approach, monorepo
tooling, security posture, etc.) until each one had an explicit, defensible rationale. Every
decision and *why* it was made is recorded in [`DECISIONS.md`](./DECISIONS.md), including a
second round of decisions surfaced once an implementation plan exposed sub-questions the
original interview hadn't reached (§14a), and a few decisions made mid-implementation, including
a bug found during manual verification (§14b).

Only after that record existed did implementation start, delegated phase-by-phase to
subagents working from the plan and the decisions record — including this documentation phase.

---

## Security highlights

- **Passwordless auth (emailed one-time codes) + session cookies via Supabase Auth**, not
  hand-rolled (DECISIONS.md §7/§14d). There are no passwords anywhere — nothing to hash, leak,
  or reuse — and all of the security-critical OTP machinery (code generation, expiry,
  single-use enforcement, verification, rate limiting) is Supabase Auth's built-in, unmodified
  system; this codebase is only UI over `signInWithOtp`/`verifyOtp`. Sessions use httpOnly,
  secure, `sameSite` cookies — never `localStorage`, which is readable by any script that gets
  XSS'd onto the page.
- **Row Level Security enforced at the database layer**, not just filtered in application code.
  Every table's RLS policy checks `user_id = auth.uid()`, and the Express API builds a
  per-request Supabase client scoped to the *caller's own JWT* for all reads — Postgres itself
  decides which rows come back. This distinction matters: even if an API route had a bug and
  forgot a `WHERE user_id = ...` clause, the database physically cannot return another user's
  rows, because the check isn't expressed in apps/api code that could have a bug — it's
  expressed in Postgres policy SQL that runs regardless. (The service-role key, which bypasses
  RLS, is used only where structurally required — the Storage upload write and the initial row
  inserts during processing, before there's a "read" to scope — never for a client-facing read.)
- **Upload validation before anything is persisted**, in a fixed order, all as independently
  unit-tested pure functions: extension allowlist (`.log`/`.txt`), a 10MB size cap, filename
  sanitization (rejects path traversal and control characters), known binary file-signature
  rejection (PDF/ZIP-Office/PNG/JPEG/ELF magic bytes), null-byte rejection, threshold-based UTF-8
  validation (rejects only if more than 2% of decoded bytes are invalid — DECISIONS.md §14b), and
  a content-shape check (the first line must look like the expected log format). Nothing touches
  Storage or the database until every check passes.
- **Parameterized queries throughout** — all database access goes through the Supabase
  client/query builder, never raw string-interpolated SQL.
- **Input validation on every endpoint**, via Zod schemas shared between frontend and backend
  (`packages/shared`), so the same shape is enforced on both sides of the request.
- **Prompt-injection awareness for the LLM layer**: log content is attacker-controllable text
  (a malicious actor could put anything in a `url` or `user_agent` field), and it's fed into an
  LLM prompt for the judge and summary steps. It's delimited explicitly as untrusted data, never
  concatenated as instruction text. More importantly, the *architecture* itself limits the blast
  radius: because the judge can only reword or reweight (within ±15 points) an anomaly Layer 1
  already found — and can never invent or delete one — a successful injection's worst case is a
  misleading explanation on a real finding, never a fabricated or suppressed one.

---

## Known limitations

**Consciously deferred, not forgotten** (see DECISIONS.md for the reasoning behind each):

- **Rate limiting** on the upload endpoint. (Sign-in is no longer a gap: the passwordless flow
  inherits Supabase Auth's built-in OTP send/verify rate limits.)
- **Hardened security headers and CORS.** CORS is currently basic and functional — locked to a
  single configurable frontend origin, not a wildcard — but the fuller stretch item (a
  helmet-equivalent security-headers pass, per-environment origin allowlisting) hasn't been
  done yet.
- **Cloud deployment.** The plan (Vercel for the frontend, Render for the backend, Supabase
  already cloud-hosted) is written but not yet executed, including a known, unresolved risk
  around Render's free tier cold-starting after idle.
- **Beaconing detection** (an 8th anomaly rule — interval-regularity across grouped events,
  e.g. a compromised host calling home on a fixed cadence) was scoped out of v1 as meaningfully
  more complex than the other seven rules.

---

## Why a simplified log format

The real Zscaler NSS feed spec has 100+ fields. This project uses a deliberately scoped subset
of 12 (`datetime`, `cip`, `login`, `url`, `action`, `urlcat`, `threatname`, `respcode`,
`bytes_out`, `bytes_in`, `useragent`, `reqmethod`), each chosen because it directly earns its
place in either a detection rule or the timeline view — not because parsing the full spec was
out of reach. Tenex's own product is an AI SOC analyst platform, so a proxy/security log format
is more domain-relevant than a generic access log; but faithfully implementing the entire
proprietary NSS spec would burn most of the project's time budget on field-plumbing rather than
the parts actually being evaluated — detection logic, security posture, and product design.
Scoping it down, and being explicit about why here rather than quietly cutting corners, is the
intended signal.
