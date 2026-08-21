# Tenex Take-Home — Architecture Decisions

Record of decisions made during a `/grill-me` design interview, before any code was written.
Kept so the reasoning survives past the build — useful for the interview follow-up ("explain
your code") and for remembering *why*, not just *what*.

## Context

- Take-home: full-stack SOC log analysis tool. Upload a log file, parse it, display it in a
  human-consumable format for a SOC analyst (including a summarized timeline), with basic auth.
- Bonus: anomaly detection — highlight anomalous entries, explain why, give a confidence score.
- Recruiter explicitly said to go above and beyond on **security** and **design** specifically.
- Guidance from the PDF: "functionality over production-readiness," 6-8 hour estimate.
- Decision: ship all must-haves first as a fully working app, then treat "above and beyond"
  security/polish items as an optional second pass — not required to ship v1.

---

## 1. Log format — scoped Zscaler-style web proxy log

**Decision:** Synthetic log generator producing a simplified subset of the real Zscaler NSS
feed format, not the full 100+ field spec.

**Why:** Tenex's own product is an AI SOC analyst platform, so a proxy/security log is more
domain-relevant than a generic access log — it signals engagement with their actual space. The
full NSS spec is large and proprietary; parsing all of it burns hours on plumbing that isn't
what's being evaluated. Scoping it down and documenting *why* in the README shows judgment,
not corner-cutting.

## 2. Fields — 12 total

`timestamp, client_ip, user, url/domain, action (allowed/blocked), url_category, threat_name
(nullable), http_status, bytes_sent, bytes_received, user_agent, http_method`

**Why each field earns its place** (every field maps to a specific anomaly rule or timeline need):
- `timestamp` — ordering, rolling-window calculations, off-hours detection
- `client_ip` / `user` — actor identity; per-IP rate anomalies
- `url` / `url_category` / `threat_name` — what happened, direct + category-based risk signals
- `action` / `http_status` — outcome, severity coloring
- `bytes_sent` / `bytes_received` — data-exfiltration signal
- `user_agent` — bot/script/recon detection
- `http_method` — sharpens the exfil rule (e.g. "large POST" is more concrete than "large bytes_sent")

Cut: no fields beyond these 12 — everything else needed (rates, rarity, windows) is *computed*
at analysis time, not stored in the raw schema.

## 3. Anomaly detection architecture — two layers, deterministic gate + bounded LLM judge

**Layer 1 (deterministic, does the actual detection):**
- Direct-signal rules (e.g. `threat_name` populated, malware category) → **fixed high confidence**
  (~90-95) — these are confirmed-bad, not inferred, so a statistical score would understate them.
- Volume/size rules (per-IP request burst, `bytes_sent` outlier) → **statistical deviation score**
  (z-score / percentile against the *dataset's own* baseline, scaled to 0-100). Self-calibrating
  rather than a guessed constant.
- Weaker/contextual rules (off-hours access, rare/scripted user-agent) → lower base confidence
  (~50-65), suggestive not conclusive alone.
- When multiple rules fire on one event: **take the max confidence, list all triggered reasons**
  in the explanation. (Rejected: probabilistic/noisy-OR combination across rules — looks
  sophisticated but is much harder to defend live in an interview than "we show the strongest
  signal's score and list every reason.")
- v1 rule set: burst-per-IP, bytes_sent exfil outlier, threat_name hit, malware-category access,
  repeated-blocked-attempts, off-hours access, rare/scripted user-agent.
- **Deferred to stretch:** beaconing detection (interval-regularity across grouped events) —
  meaningfully more complex than the others, not required for a working v1.

**Layer 2 (LLM-as-judge, refines only what Layer 1 already flagged):**
- Runs only on candidates Layer 1 already surfaced — **cannot invent new anomalies**, only
  reword/contextualize and nudge confidence within a bounded delta (±15).
- **Why this split, not LLM-driven detection:** an LLM deciding what's anomalous from scratch is
  unexplainable and inconsistent — a bad answer to "why did this get flagged" in an interview.
  A deterministic gate that the LLM can only refine keeps every score auditable ("it's math I
  wrote") while still using the LLM for genuinely open-ended judgment (e.g. "large upload to a
  known SaaS backup domain" vs "large upload to an unrecognized domain" — a distinction rules
  alone can't express well).
- **Batched, capped:** one batched call per file, top-N (e.g. 20) candidates by Layer 1 confidence,
  each explicitly indexed so the LLM can't merge/renumber/invent. Anything past N shows the
  Layer 1 templated explanation as a fallback — capped explicitly, never silently truncated.
- **Structured output:** forced tool-calling with a defined JSON schema (event index, confidence
  delta, explanation string) — not freeform text parsing. More robust, and it bounds what the
  model can express, narrowing prompt-injection blast radius further.

**Separately, LLM-generated timeline summary:** takes the parsed + flagged events and generates
the human-readable "summarized timeline of events" the PDF asks for. Low-risk use of the LLM
(summarizing facts already computed, not deciding anomalies) and a clean, honest answer for the
README's required AI-usage documentation.

## 4. LLM provider/model — Anthropic only, split by task

- **Judge layer:** Claude Sonnet 5 — needs actual contextual judgment.
- **Timeline summary:** Claude Haiku 4.5 — pure summarization of already-structured data; cheaper/
  faster model is the right fit, and using the stronger model only where reasoning matters is a
  good cost-conscious detail for the README.
- Single vendor, one SDK. Considered splitting to OpenAI for a cheaper "fast" model — rejected:
  at take-home volume the cost delta between tiers is fractions of a cent per file (~4¢
  difference between an all-Haiku and Sonnet+Haiku pipeline for one uploaded log). Not worth a
  second API key, SDK, and failure path to explain later for negligible savings.

## 5. Security posture — must-have now, stretch deferred

**Must-have (in v1):**
- Password hashing (via Supabase Auth — see §7, not hand-rolled)
- httpOnly, secure, sameSite session cookie — not localStorage (XSS-readable)
- File upload hardening: extension allowlist, size cap, filename sanitization, magic-byte/content
  sniffing (never trust the client's `Content-Type` header), stored outside anything served
  statically, validated **before** anything is persisted to storage
- Parameterized queries only (via Supabase client / query builder — no raw string-interpolated SQL)
- Input validation on every endpoint

**Stretch (optional pass 2, after v1 works end-to-end):**
- Prompt-injection defense write-up for the LLM layer: log entries are attacker-controllable text
  fed into a prompt. Mitigation already baked into the architecture (§3) — Layer 1's deterministic
  gate means even a successful injection can only suppress/reword an explanation, never invent or
  remove a flagged anomaly. Document this explicitly in the README as a specific, on-theme
  security detail (log data = untrusted data, never concatenated as instruction text).
- Rate limiting on login + upload endpoints
- Security headers (helmet-equivalent) + CORS locked to the frontend origin

## 6. Backend — Express + TypeScript

**Why not Flask or Go:** one language across the whole stack (shared Zod schemas between
frontend/backend), easier to explain later with no context-switch between language idioms.
Flask's data-science ecosystem isn't needed since the rule engine is simple threshold/z-score
math. Go is a performance/production signal this project isn't being evaluated on.

**Why a separate service, not Next.js API routes:** the PDF calls out "Build a RESTful API" as
its own numbered requirement — a distinct backend signals that was read as a deliberate ask, not
incidental. Also keeps Docker Compose clean (`postgres`/`api`/`web` as distinct services,
pre-Supabase decision — see §7).

## 7. Database / Auth / Storage — Supabase (new project, new account)

**Decision:** Supabase Postgres + Supabase Auth + Supabase Storage, replacing the original plan
of local Postgres + hand-rolled bcrypt/JWT + local disk storage. Requires a **new Supabase
account** (user is creating one to use the free tier — the only existing project, "Onzio
Platform Staging," is unrelated and must not be reused).

**Why this is a stronger security story, not just convenience:**
- **Row Level Security (RLS)** on every table scoped to `auth.uid()` gives **database-level**
  authorization, not just API-layer checks — real defense-in-depth, concrete and verifiable
  (the policy SQL itself is the proof), and a strong, legible answer for a security-focused
  interviewer ("even if the API layer had a bug, the DB itself won't return another user's rows").
- Not hand-rolling auth crypto is itself a legitimate senior-engineer judgment call — the trade
  is less "I wrote JWT code" to show, in exchange for "I chose not to reinvent a security
  primitive, and layered RLS on top" — which is the better answer.
- Supabase Storage private bucket + RLS covers the "store outside served directory" upload
  hardening requirement naturally.
- Side benefit: since Supabase is already cloud-hosted, the DB/Auth/Storage third of the
  "deploy to a cloud platform" bonus is already done once the project exists.

**Auth scope — full signup + login (not a seeded demo-only user):** Supabase Auth makes signup
essentially free once login is wired up (no separate password-hashing/validation code to write),
so the marginal cost is low. Avoids the minor awkwardness of handing a reviewer hardcoded shared
credentials in a README for a security-focused evaluation. Email confirmation off/auto-confirm
for local/demo simplicity — no transactional email setup.

## 8. Data model

Tables: `User` (via Supabase Auth), `LogFile` (id, user_id, filename, uploaded_at, status,
storage_path), `LogEvent` (parsed rows, `log_user` field name to avoid clashing with the auth
user table), `Anomaly` (base_confidence and llm_adjusted_confidence kept as **separate columns**,
not overwritten — lets the UI/interview show "deterministic score vs. what the judge nudged it
to and why"), `TimelineSummary` (the LLM-generated narrative).

**Raw file storage:** kept on disk (Supabase Storage private bucket) after parsing, not
discarded — supports audit/reprocessing. `storage_path` on `LogFile` points to it.

## 9. Upload flow — validate in Express before anything touches storage

**Decision:** client → Express (multipart) → Express validates (extension, size, magic bytes) →
only then does Express write to the private Supabase Storage bucket (service-role key,
server-side only, path-scoped `uploads/{user_id}/{file_id}.log`) → parse → detect.

**Rejected:** direct-to-Storage signed-URL upload from the client. That's the right pattern at
production scale (offloads bandwidth from your API), which isn't the problem this project has.
It also introduces a race/webhook-polling problem ("how do we know the upload finished") that a
synchronous validate-then-store flow avoids entirely. The chosen flow's security property is
also just better for this project: nothing is ever persisted, even transiently, before
server-side validation clears it.

## 10. Processing model — synchronous, single request

**Decision:** `POST /api/logs/upload` does parse → deterministic rules → LLM judge → LLM summary
→ returns the full result in one response. No job queue, no polling endpoint, no websocket.

**Why:** estimated worst-case latency ~20-25s (parsing + rules are near-instant; batched judge
call ~5-15s; summary ~3-5s) — acceptable with a client-side loading state and a bumped endpoint
timeout. A queue/worker/websocket layer would solve a concurrency problem this project doesn't
have (one user, one file at a time) and would eat timebox for no real payoff.

## 11. Frontend UI library — shadcn/ui (not Preline)

**Why not Preline:** Preline's components are vanilla-JS-driven (`HSStaticMethods.autoInit()`),
not native React — needs manual reinit on route/state changes in Next.js, a known friction point.

**Why shadcn:** actual React/TS components (Radix-based), no reinit boilerplate. Tiebreaker:
Supabase's own official Next.js starter templates ship with shadcn/ui by default, so the
auth screens (login/signup, session-aware layout) have less custom wiring once Supabase Auth
is in the stack.

## 12. Monorepo — plain npm workspaces (not pnpm/Turborepo)

**Why:** at this scale (2-3 packages, single contributor, 6-8hr build) Turborepo's task-caching
solves a problem this project doesn't have, and pnpm's disk-dedup benefit is irrelevant. npm
workspaces needs zero extra tooling and is one less thing to explain in the walkthrough recording.

```
/apps
  /web       (Next.js + shadcn)
  /api       (Express — talks to Supabase via server-side client)
/packages
  /shared    (Zod schemas shared between web/api — log event shape, API request/response types)
```

## 13. Example log files — four, each testing something different

Not just "plural to satisfy the requirement" — each file has a distinct purpose:
1. `normal-traffic.log` — large (~2-5K rows), realistic mixed traffic, embedded anomalies across
   every rule type — the main "needle in a haystack" demo
2. `quick-demo.log` — small (~150-200 rows), obvious anomalies — for the walkthrough recording,
   so it doesn't require scrolling through thousands of benign rows on camera
3. `clean-traffic.log` — small, **zero** embedded anomalies — a negative control proving the
   detector doesn't just flag everything (false-positive-rate evidence, not just taken on faith)
4. `malformed-edge-cases.log` — deliberately broken input (truncated lines, missing fields, bad
   encoding) — proves the parser degrades gracefully; doubles as evidence for the input-validation
   security must-have, not just a parser robustness test

Generated via a seeded (`@faker-js/faker`, fixed seed) TS script for reproducibility. A private
`examples/ANSWER_KEY.md` records which rows are anomalies and why, for development-time
validation only — **never read by the detection code itself**, so testing stays honest rather
than circular.

## 14a. Open items resolved after Fable's implementation plan (second grill round)

The Plan agent (run on Claude Fable 5) surfaced several sub-decisions that DECISIONS.md's
architecture left open. Resolved as follows:

**Log wire format — tab-separated `key=value`, not CSV.** Deliberately closer to the real
Zscaler NSS syntax than a CSV would be, to demonstrate engagement with the actual format spec
(overriding the original CSV recommendation). Field names follow NSS-style naming: `datetime=`,
`cip=`, `login=`, `url=`, `action=`, `urlcat=`, `threatname=`, `respcode=`, `bytes_out=`,
`bytes_in=`, `useragent=`, `reqmethod=`. Parsing implication: split each line on tabs first,
then each token on the *first* `=` only — this keeps a `url=` value containing `=` (e.g. a query
string) safe, since the tab (not the equals sign) is the true field delimiter. "Missing field" =
a key simply absent from the line; "malformed" = a token with no `=`, an unterminated line,
non-UTF-8 bytes, or an unescaped tab inside a value.

**RLS enforcement — Option A: per-request client scoped to the caller's JWT.** Express extracts
the user's Supabase access token and constructs a Supabase client with it for all **reads** —
Postgres RLS itself decides what rows come back, the API never manually filters by `user_id` on
reads. Service-role key is used only where it's structurally required: the Storage upload write
and the initial row inserts during processing (before there's a "read" to scope). This is what
makes the RLS story real rather than decorative — the DB physically cannot return another user's
rows regardless of API code correctness, which is the entire point of choosing Supabase in §7.

**"Magic-byte sniffing" for a plain-text format — translated into four checks**, run server-side
before anything is persisted: (1) reject known binary file signatures at the start of the upload
(`%PDF`, zip/docx/xlsx `PK\x03\x04`, PNG, JPEG, ELF, etc.), (2) reject files containing null
bytes, (3) require valid UTF-8 decoding, (4) confirm the first line matches the expected NSS-style
header shape (e.g. starts with a recognizable `datetime=` field). Documented in the README
explicitly as a deliberate translation of "inspect actual bytes, don't trust the extension or
Content-Type header" for a text format — not a downgrade of the requirement.

**LLM graceful degradation — must-have, with transparent (not silent) failure states.** The app
must fully function with no `ANTHROPIC_API_KEY` set or on a failed call — but the *reason* is
surfaced to the user rather than a generic "unavailable" message. The API response carries an
explicit status per LLM feature (judge and summary tracked separately, since one can fail while
the other works): `not_configured` (no key set), `failed` (key present, call errored — auth
failure, rate limit, timeout, refusal — with the actual reason captured), or `ok`. Frontend shows
the specific reason: *"AI-enhanced analysis is disabled — no API key configured. Showing
rule-based detection only."* vs *"AI-enhanced analysis failed (`{reason}`) — showing rule-based
detection only."* On judge failure: anomalies still ship with Layer 1's templated explanation,
`llm_adjusted_confidence` left `null`. On summary failure: a deterministic templated fallback
("214 events analyzed, 6 anomalies flagged across 4 rule types, time range 09:02–17:44") plus the
status banner. Why this matters beyond robustness: a reviewer can clone the repo and see the
entire app work without first obtaining an Anthropic key — the AI layer is something they opt
into to see the enhanced version, not a hard blocker to evaluating anything else — while never
hiding *why* something is degraded.

**`ANSWER_KEY.md` — commit it.** It's evidence the detection engine was validated against known
ground truth, not eyeballed. The "risk" of a reviewer comparing it to live output isn't a real
risk — the whole point is proving they match. README states explicitly that detection code never
reads this file at runtime, so it reads as a validation artifact, not a hardcoded answer sheet.

**`url_category` taxonomy — locked, 12 categories:**
- Benign: `Business`, `Social Networking`, `Streaming Media`, `News & Media`, `Technology`,
  `Shopping`, `Webmail`, `File Sharing`
- High-risk (drives the malware-category rule): `Malware Sites`, `Phishing`, `Botnet Callback`,
  `Spyware or Adware`
- Fallback: `Uncategorized`

**Rule thresholds/constants — locked starting values** (centralized in one commented
`apps/api/src/rules/config.ts` so every number has a documented reason in one place):

| Rule | Threshold | Confidence |
|---|---|---|
| Burst-per-IP | 60s sliding window; flags when a window's count exceeds the file's own per-IP-per-minute p99, with an absolute floor of ≥15 req/min | scaled by how far over |
| Exfil (`bytes_out`) | z-score > 3 on POST/PUT events; requires ≥30 events in the dataset before the statistical rule runs at all (too few samples = skip, not false-flag) | z=3 → ~65, z≥6 → ~95 |
| Off-hours | outside 08:00–18:00 UTC weekdays (fixed synthetic-org hours, documented in README) | ~50 |
| Rare/scripted user-agent (known signature) | `curl`, `python-requests`, `wget`, empty UA | ~60 |
| Rare user-agent (statistical) | UA appears in <1% of the file, no known-script match | ~50 |
| Repeated-blocked | ≥5 blocked events, same user or IP, within a 10-min window | scales with count |
| `threatname` populated | direct signal | fixed 95 |
| Malware-category access | direct signal (Malware Sites/Phishing/Botnet Callback/Spyware Or Adware) | fixed 90 |

## 14. Deployment (bonus — deferred until v1 is fully functional)

**Planned target:** Vercel (frontend, matches the PDF's own suggestion, zero-config for Next.js)
+ Render (backend — needs a persistent Node process, not serverless functions, since Vercel's
serverless timeout is too tight for the ~20-25s synchronous processing chain) + Supabase
(already cloud-hosted).

**Known risk, not yet resolved:** Render's free tier sleeps after 15 min idle, ~30-50s cold
start on the next request — risky if the recruiter clicks the live link cold. Flagged for
later (keep-alive ping, paid tier, or switch to Fly.io) — intentionally not solved now since
deployment itself is in the deferred bucket.
