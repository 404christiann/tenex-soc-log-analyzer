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

## 14b. Decisions made during implementation

**Theme — light mode only, no dark default.** The frontend agent shipped dark-as-default with a
toggle (a reasonable judgment call for a "SOC tool aesthetic," but not what was asked). Corrected:
light mode only. Simplifies the design surface (one palette to get right, one less thing to
explain) and matches explicit user preference over the agent's own aesthetic assumption.

**Testing strategy — integration tests written after v1 implementation is complete, not
alongside it; used as a TDD case study for the next bug fix found.** Each phase so far wrote its
own unit/module-level tests as it went (parser, rule engine, LLM layer, API routes all have real
test coverage, verified against a disposable local Postgres/Supabase stack). What's missing is a
comprehensive, automated, whole-system integration suite (the kind of full click-through the
Phase 8 agent did manually in a browser) — that gets written as its own explicit phase once v1
(through README/Phase 10) is finished, not folded into the phases that already have their own
tests. Once that suite exists, the very next thing done with it is TDD-style: write a failing
integration test that reproduces the `malformed-edge-cases.log` / whole-file-UTF-8-check bug
below, confirm it fails, then fix the underlying logic, confirm it passes. This is a deliberate
sequencing choice, not an oversight — worth mentioning in the interview as "here's a case where
I wrote a regression test before the fix, even though the rest of the build wasn't strict TDD."

**Bug found in Phase 8 verification, fix confirmed but sequenced after the integration-test
phase (see above):** the upload-time "require valid UTF-8" check (§14a's magic-byte
reinterpretation) validates the *whole file buffer* strictly, so `malformed-edge-cases.log` —
built specifically to demonstrate the parser's per-line graceful degradation — gets rejected
outright at the security gate before the parser ever sees it, since it deliberately contains a
few corrupted UTF-8 bytes among otherwise-valid content. **Resolution: loosen the check from
zero-tolerance to a threshold** (e.g. reject only if >2% of bytes are invalid/non-printable) —
genuine binary files fail this easily (mostly non-text), while a mostly-valid text file with a
few deliberately-corrupted bytes passes through to the parser, which already handles per-line
invalid UTF-8 correctly. Preserves the real security intent (reject disguised binaries) without
defeating the one example file built to prove graceful degradation.

**Fix landed.** `upload-validate.ts`'s zero-tolerance `decodeUtf8Strict()` (`TextDecoder("utf-8",
{ fatal: true })` over the whole buffer) was replaced with `decodeUtf8WithThreshold()`: decode
leniently (`TextDecoder("utf-8", { fatal: false })`, which substitutes U+FFFD for each invalid
byte sequence instead of throwing), then reject only if replacement characters exceed 2% of the
decoded text's length. The other three magic-byte checks (binary-signature rejection, null-byte
rejection, header/shape check) were left unchanged. The TDD regression test in
`apps/api/src/routes/logs.integration.test.ts` (previously labeled `[EXPECTED TO FAIL until
DECISIONS.md §14b's UTF-8-threshold fix lands]`) now passes: `malformed-edge-cases.log` uploads
successfully (201), reports the parser's known 19 errors / 2 skipped-blank counts, and persists
the 30 recovered events. Two new unit tests were added to `upload-validate.test.ts` covering the
threshold behavior directly (mostly-valid text with a couple of corrupted bytes passes; a
buffer that's mostly invalid bytes, simulating a disguised binary, still rejects) — binary-file
rejection (checked both via `checkBinarySignature`'s magic-byte tests and the threshold-based
UTF-8 check) remains intact. Full `apps/api` vitest suite: 160 passed, 1 skipped (the live LLM
smoke test, which requires a real `ANTHROPIC_API_KEY`), 0 failing. Playwright E2E suite (`apps/web`):
6/6 passed, no regressions. `tsc --noEmit` clean across `apps/web`, `apps/api`, and
`packages/shared`.

## 14c. Post-v1 design pass — results page, upload UI, real streaming summary (third grill round)

Triggered by user feedback referencing aicss.dev (an AI-component registry) and shadcn's newer
"base" components. Before asking questions, the actual source of every referenced component was
fetched directly from aicss.dev's registry JSON rather than guessed — this mattered, because one
reference component turned out to be built on fabricated demo content (see below), which directly
informed the recommendation and the resulting decision.

**Results page restructured into top-level tabs: Timeline / Anomalies / Events.** Rejected
alternative: independently-scrollable fixed-height panels within one page. Chosen because it
directly solves the real complaint (events table pushed far down the page by a long anomalies
list) and gives each section room to be presented well without competing for vertical space.
File header (name/status/upload date) stays fixed above the tabs.

**Anomalies tab: severity sub-tabs (High/Medium/Low, each labeled with a count) + soft-pill
badges (shadcn `base/badge` style) + anomalies converted from cards into a real table
(aicss `data-table` visual language — rounded-xl bordered shell, clean row lines) with
click-to-expand rows.** Collapsed row: severity badge, rule type, one-line truncated
explanation, confidence, timestamp. Expanded: full explanation text plus, when present, the
LLM's adjusted-confidence reasoning. Chosen over cramming full explanation text into a fixed
table cell (uneven, unreadable row heights) or dropping the table conversion entirely (loses
the scannable, data-dense presentation being asked for).

**Skeleton loading (shadcn `base/skeleton`) on navigating into a results page — minimum-floor
duration (~600-800ms), not a fixed 1-2s.** Shows for however long the real fetch takes, floored
so it never flickers on a fast response, never artificially delays already-arrived real data.

**Upload "thinking" rotating text — generic flavor text, not tied to real rule names.**
The reference component (`thinking-state`) is just a static shimmering label with no rotation
logic; the rotation itself had to be designed. The recommendation was to rotate through
real, stage-derived micro-copy (e.g. actual rule names during the "Rules" stage) to preserve the
anti-fake-UI discipline held everywhere else in this build — **the user explicitly chose generic
flavor text instead ("Analyzing…", etc.), overriding that recommendation.** Recorded as a
deliberate, informed choice, not an oversight: unlike a progress percentage or a confidence
score, decorative loading copy isn't a factual claim, so the honesty principle doesn't bind it
the same way. Applied to the existing real staged-progress system (Uploading → Parsing → Rules
→ AI review) — note "Summarizing" is removed as a stage, see below.

**Timeline summary — real streaming, not a frontend-only illusion. This is the highest-stakes
call of this round and amends two previously locked decisions (§4, §10).** The reference
component (`thinking-reasoning`) was found to be 100% hardcoded fake demo text on a fixed
timer — not real model output — which framed the choice as: (A) build real SSE streaming with
genuine model reasoning, a real architecture change, vs. (B) an honest frontend-only illusion
built from real facts already in the response, cheaper and non-architecture-changing. **The user
chose (A).** Locked shape:

1. **Model switch for the summary: Haiku 4.5 → Claude Sonnet 5.** Reverses part of §4's
   cost-conscious model-split rationale — Haiku 4.5 isn't in the tier that reliably exposes
   adaptive-thinking with visible summarized reasoning; Sonnet 5 (already used for the judge) is.
   Explicitly signed off on by the user, informed that the absolute cost delta is trivial at this
   app's scale (~4¢/file across the whole pipeline, established earlier in §4).
2. **Scope is narrow: only the summary streams.** The judge is unchanged — stays synchronous,
   part of the upload request, structured tool-call output (no natural "watch it stream" UX for
   JSON, and anomalies need their LLM-adjusted confidence ready immediately when the Anomalies
   tab opens).
3. **Summary generation is decoupled from the upload request entirely — amends §10.** Upload
   becomes: parse → rules → judge → persist → respond immediately with events + anomalies (no
   "Summarizing" stage in the upload flow anymore, and uploads get faster as a side effect).
   Summary generation moves to its own SSE endpoint, triggered when the Timeline tab is opened —
   deliberately chosen to land in the new tabbed structure above, since that's exactly where
   "watch it think, then read the result" belongs. §10's synchronous-single-request model still
   holds for parsing/rules/judge; it no longer covers the summary.
4. **Honest three-state failure handling carries over unchanged in substance, different
   transport.** No API key → the stream immediately emits a `not_configured` event, same locked
   banner copy, no fake thinking animation plays for a call that never happened. Mid-stream
   failure emits a `failed` event and falls back to the deterministic templated summary — same
   three-state design as §14a, just delivered as SSE events instead of upfront JSON fields.

**Implemented and verified live against the real Anthropic API**, via three subagents (two run
in parallel — backend streaming endpoint, and upload-flow flavor-text/skeleton — followed by the
full results-page restructuring once the streaming contract existed). Real, observed reasoning
text from a live run: *"I'm piecing together a chronological timeline of the anomalies, starting
with a high-confidence exfiltration event from Brittany Huels to Google Drive, followed by a
burst of rapid requests from Audra Kassulke's IP hitting multiple cloud storage domains..."* —
genuinely grounded in the real uploaded file, not fabricated. Cached replay confirmed instant
(no LLM call, no animation) on revisiting an already-generated Timeline tab. The `not_configured`
path was also proven live (no thinking animation for a call that never happened). Anomalies tab:
severity sub-tabs with live counts, table-with-expandable-rows preserving every field the old
always-expanded cards showed. Full test suites (Playwright + both API/web vitest) green,
`tsc --noEmit` clean across all three workspaces.

## 14d. Logo, timeline bullet legibility/linking, and passwordless auth (fourth grill round)

**Logo.** A real brand asset exists (`~/Downloads/tenexAILogo.webp`, 512×512 RGBA, teal
rounded-square with black "TENEX" wordmark) — the `ShieldHalf` lucide icon used everywhere until
now was always a placeholder. Decision: use the real asset as-is (don't recolor a provided brand
asset just because it introduces a second color alongside the blue-600 UI accent — that's normal,
logo color ≠ UI-accent color in most real products), mid-sized, in the app-shell header, the new
login page, and as the browser favicon.

**Timeline bullet linking — inline `event:`-scheme markdown links, not text-matching or a second
LLM call.** Text-matching a bullet's prose against the event table after generation is fragile
(shared IPs, timestamp-format mismatches) and a wrong link on a security tool is actively
misleading, worse than no link. Chosen instead: pass real event/anomaly IDs (not just descriptive
aggregate stats) into the summary prompt, instruct the model to cite specific events using
ordinary markdown links with a custom scheme (`[10.9.220.112](event:evt_abc123)`) inline as it
streams. The existing markdown renderer gains one addition — intercept `event:` link clicks and
reuse the same tab-switch/scroll/highlight interaction already built for Anomalies↔Events
cross-linking. No second LLM call, no bespoke parser. The model can only cite real IDs because
only real IDs are in its context (same "can't invent, can only reference what's real" discipline
as the judge, §3); the frontend can also silently de-link any ID that doesn't match a real event
it has loaded, so a hallucinated citation degrades to plain text rather than a broken/wrong link.
Presentation: bullets restyled from dense inline-code-heavy paragraphs into compact rows — bold
timestamp lead-in, one concise description line, IPs/users/domains as small pill/chip tokens
instead of raw inline `code`, citation rendered as a "View event →" affordance rather than an
inline text link.

**Passwordless auth overhaul — amends §7.** Complaint: Supabase's built-in magic link only
allowed "2 attempts, then a 1-hour wait." Diagnosed (not assumed) as Supabase's **default
built-in email service's rate limit** — deliberately throttled hard because it's meant only for
testing, not a limitation of the OTP/magic-link verification system itself. Confirmed this framing
before deciding anything, since it determined which of two very different paths was correct:

- **Path A (chosen):** keep Supabase Auth's native `signInWithOtp` (numeric-code mode) and all its
  built-in code generation/verification/expiry/rate-limiting exactly as-is; fix only *who sends
  the email* by configuring a custom SMTP provider (Resend) on the Supabase project. Small,
  low-risk, mostly configuration — consistent with §7's original "don't reinvent a security
  primitive" reasoning, just applied again here.
- **Path B (rejected):** build a fully custom OTP system (own code generation, storage, expiry,
  single-use enforcement, rate limiting, Resend API calls, session minting) — everything Supabase
  already gives correctly, we'd now own and have to get right ourselves. Rejected for the same
  reason hand-rolled auth was rejected in §7.

**Login/signup collapse into one screen, `/signup` removed entirely.** With `signInWithOtp`
(`shouldCreateUser: true` by default), there is no password step to distinguish "new" from
"returning" — both are identically "enter email → get a code → enter the code." A separate
signup screen would be two doors to the same room. One email-entry screen, no "Create account"
button, no separate route.

**Resend setup:** new dedicated subdomain **`tenexai.onziofutbol.com`** (not the existing
`auth.onziofutbol.com`, which is already the live Onzio platform's sending identity for a real
paying customer — mixing an unrelated take-home's mail traffic through it would blur sender
reputation and brand identity for no benefit). DNS verification is a user-side step (Resend hands
back SPF/DKIM records to add at the registrar) and isn't blocking, since local dev never touches
Resend at all — see below. The Resend API key does **not** go into this repo or any env file; SMTP
credentials are configured directly in the (not-yet-created) hosted Supabase project's dashboard
(Authentication → Email → SMTP Settings: host `smtp.resend.com`, user `resend`, password = API
key) — documented as a setup step in the README, not a functional variable our code reads.

**Local dev stays on Supabase's local Inbucket email catcher, never Resend.** Inbucket intercepts
outbound test emails without real delivery — already implicitly relied on all session via
auto-confirm. Verifying the OTP flow locally means reading the code from Inbucket's local
catcher/API instead of a real inbox.

**PIN input UI — 6 digits, real Preline markup as the visual reference, shadcn's `input-otp` for
the actual interaction logic (not Preline's vanilla-JS plugin — consistent with §11's original
Preline-vs-shadcn call: borrow the visual language, not the JS architecture).** Includes a
"Resend code" link with a short cooldown (~30-60s) so a non-arriving code isn't a dead end.

## 14e. Timeline summary — three-direction design bake-off (resolved: severity-grouped)

Three candidate redesigns of the Timeline tab were built in parallel git worktrees and compared
live side by side: an **executive digest** (client-computed stat strip + streaming LLM TL;DR hero
above the chronological bullets), a **severity-grouped** layout, and a **visual timeline**. The
executive digest was briefly picked and merged, but the call was reversed to **severity-grouped**
before it shipped anywhere real — that is what's merged into main now, and the digest changes
(`apps/web/src/lib/digest.ts`, the TL;DR prompt rules and their tests, the `eventsTotal` prop)
were fully reverted rather than layered under it.

What severity-grouped means: the summary's bullets are grouped under exact `### High severity` →
`### Medium severity` → `### Low severity` headings (plus an optional trailing `### Observations`
for uncited commentary), empty sections omitted, chronological within each section — a triaging
analyst reads the worst findings first, and the fixed severity-descending order is what lets
linear SSE streaming and grouping compose with no client-side reordering. Severity is told, never
guessed: `getSeverity`/`anomalySeverityConfidence` moved to `packages/shared/src/severity.ts`
(web's `severity.ts` re-exports them) so the API prompt and the UI badges band on literally one
function, and `buildSummaryUserPrompt` prints an authoritative `severity` field per top-anomaly
line — a bullet's section always matches the badge its citation jumps to. The h3 renderer turns
those headings into labeled dividers reusing the Anomalies tab's badge + dot language. All
§14c/§14d one-event-per-bullet, citation, and rendering-pipeline rules carry over verbatim, with
grouping tests added to `apps/api/src/llm/prompts.test.ts`. Verified live across three fresh
generations with every citation machine-checked into its real DB-banded tier (9/9 each run). The
two non-chosen worktrees are kept on disk for reference.

**Closing note — digest and severity-grouped combined (explicit user call).** The bake-off's
framing of the two finalists as mutually exclusive was reversed: the digest's client-computed
stat strip and streaming `**TL;DR:**` "Key takeaway" hero were reintegrated ON TOP OF the
severity-grouped structure, not instead of it. One prompt now produces one coherent shape —
TL;DR lead line first (explicitly not a heading), blank line, then the fixed-order severity
sections — and the frontend composes the two parsers by ordering: `splitTldr` peels the lead
off the raw stream before the h3 section-heading renderer ever sees the remainder. All digest
honesty rules carry over (computed-fallback hero only in terminal no-TL;DR states, never a
faked model sentence; older cached summaries without a TL;DR or headings still render
sensibly). Re-verified live across three fresh generations, every citation again
machine-checked into its DB-banded tier.

## 14. Deployment (bonus — deferred until v1 is fully functional)

**Planned target:** Vercel (frontend, matches the PDF's own suggestion, zero-config for Next.js)
+ Render (backend — needs a persistent Node process, not serverless functions, since Vercel's
serverless timeout is too tight for the ~20-25s synchronous processing chain) + Supabase
(already cloud-hosted).

**Known risk, not yet resolved:** Render's free tier sleeps after 15 min idle, ~30-50s cold
start on the next request — risky if the recruiter clicks the live link cold. Flagged for
later (keep-alive ping, paid tier, or switch to Fly.io) — intentionally not solved now since
deployment itself is in the deferred bucket.

## 15. Three of the four §5/§14 stretch items implemented: rate limiting, security headers/CORS, beaconing detection

Picked up as a post-v1 pass, independent of §14's still-deferred cloud deployment. All three
follow the same guiding principle established throughout this doc — don't hand-roll a security
or statistics primitive when a well-reviewed library/technique already gets the edge cases
right (§7's Supabase Auth call, §3's LLM-judge gate) — applied here to a rate-limiting library,
a security-headers middleware, and a scale-free statistical measure, respectively.

**Rate limiting — `express-rate-limit`, per-IP, on the two genuinely expensive/abusable routes.**
Not every route: `POST /api/logs/upload` (parses a file, runs all 8 rule modules, then makes a
real billed Anthropic call for the judge — plus the only route writing to Storage/DB) and
`GET /api/logs/:id/summary/stream` (cheap on a cache hit, but a real streamed Anthropic call
plus a full event re-page on a miss) are the two routes where a tight loop actually costs money
or resources; every other route is a plain authenticated Postgres read, no different from any
CRUD endpoint. Per-IP rather than per-user: `express-rate-limit`'s default IP-based keying
bounds load/spend from one source regardless of auth state, and a per-user quota would be
trivially bypassable by creating a new (free) Supabase account. Numbers picked for a
single-user take-home demo, not production SaaS — generous enough that a reviewer clicking
through the four example files and revisiting the Timeline tab never gets close (20
uploads / 15 min, 30 summary-stream requests / 15 min), tight enough to visibly stop a
scripted loop. Upload's limiter runs **before** `requireAuth` in the route chain — an
unauthenticated flood shouldn't get a free pass on JWT-verification cost just because it'll
401 anyway. **No separate login-endpoint limiter, and that's not a gap:** §14d's passwordless
overhaul means there is no server-side login route in this Express API to rate-limit at all —
`signInWithOtp`/`verifyOtp` are called directly from the browser against Supabase's own hosted
Auth service, which already enforces its own OTP send/verify rate limits server-side.
Implementation: `apps/api/src/middleware/rate-limit.ts`, wired into
`apps/api/src/routes/logs.ts`; error body matches `middleware/error-handler.ts`'s existing
`{ error: string }` shape (a 429 shouldn't look like a different API), and `RateLimit-*`
(not the legacy `X-RateLimit-*`) response headers are used.

**Security headers — `helmet()`, one deliberate override.** Applied with its full default set
(HSTS, `X-Content-Type-Options: nosniff`, frame-ancestors, a locked-down default CSP, etc.) —
this API is pure JSON/SSE with no HTML of its own to render, so almost none of it needs
tuning. The one override, `crossOriginResourcePolicy: { policy: "cross-origin" }`: helmet's
default `Cross-Origin-Resource-Policy: same-origin` tells the *browser* to refuse to expose a
response to a different-origin page even when the `cors` middleware below explicitly allowed
it via `Access-Control-Allow-Origin` — and apps/web calling apps/api is exactly that
cross-origin case, in local dev and in the §14 Vercel+Render plan alike. Verified empirically
(not just read off the docs): the unmodified default measurably broke the real upload/summary
calls from apps/web before the override was added. The CORS allowlist below is what's actually
gating who can read these responses, so CORP's blunter same-origin default would only have
broken the legitimate frontend.

**CORS — hardened beyond §5's "single-origin allow" starting point.** Still one configurable
origin via `FRONTEND_ORIGIN` (never a wildcard, which would silently undercut the RLS/JWT auth
model), now additionally explicit about `methods` (`GET`/`POST` only — the `cors` package's
default otherwise reflects every method in the preflight response) and `allowedHeaders`
(`Content-Type`, `Authorization` — nothing else this API reads). `credentials` flipped from the
original `true` to **`false`**, checked against how `apps/web/src/lib/api.ts` actually calls
this API: every request carries its Supabase access token as an explicit
`Authorization: Bearer <token>` header, never `fetch(..., { credentials: "include" })` or an
ambient cookie — Supabase's own session cookie lives on the Next.js origin only
(`lib/supabase/middleware.ts`) and is never sent to this Express API. `credentials: true` was a
leftover from an earlier, more permissive draft, not a real requirement; turning it off is a
strict tightening (the browser now refuses to expose responses to a cross-origin page even
under a forced credentialed request) with zero effect on the app's real Bearer-token-only call
pattern. Both changes live in `apps/api/src/app.ts`.

**Beaconing detection — the 8th deterministic rule, interval-regularity via coefficient of
variation.** Deferred out of v1 in §3 as "meaningfully more complex than the other seven";
implemented as `apps/api/src/rules/beaconing.ts`, wired into `runRuleEngine` alongside the
original seven (`apps/api/src/rules/engine.ts`).

- **Signal:** a compromised host phoning home to a C2 server on a fixed timer produces a tight,
  low-variance sequence of inter-arrival deltas to the same destination — a pattern normal
  human/application traffic essentially never produces, since real usage is bursty and
  irregular. Deliberately a different detection axis from `burst-per-ip` (§14a): a burst is
  about *volume* (too many requests in a window); a beacon is about *regularity* (a suspiciously
  even cadence, independent of volume — a beacon every 5 minutes is still a beacon).
- **Grouping:** events are grouped by (`cip`, destination host), host extracted from `url` via
  `new URL(...).hostname` with a raw-string fallback if it doesn't parse. Grouping by host
  rather than the full `url` deliberately tolerates path/query variation across check-ins (an
  attacker varying `/beacon?id=1`, `/beacon?id=2`, ... shouldn't split into separate,
  under-threshold groups).
- **Sample floor:** `BEACONING_MIN_SAMPLES = 6` (≥5 inter-arrival deltas) before computing
  anything — the same "too few samples = skip, not false-flag" floor philosophy as
  `EXFIL_MIN_SAMPLES` (§14a): with 2-3 points, "the deltas happen to look even" is
  indistinguishable from coincidence.
- **The statistic — coefficient of variation (CV = stddev / mean of consecutive inter-arrival
  deltas), not raw stddev.** CV is scale-free: a beacon every 5s with ±0.5s jitter and a beacon
  every 5min with ±30s jitter are *equally* regular (CV = 0.1 either way), but their raw
  stddevs differ by two orders of magnitude — one CV threshold works across every timescale,
  where a raw-stddev threshold would need per-timescale tuning. Same "self-calibrating against
  a dataset property, not a guessed constant" philosophy as burst-per-ip's p99 and exfil's
  z-score (§14a), applied to timing variance instead of a count/byte distribution. New scaling
  helper `scaleInverseThresholdConfidence` (`apps/api/src/rules/stats.ts`) is the mirror image
  of the existing `scaleExfilConfidence`: confidence rises as the statistic *falls* (tighter CV
  = more suspicious), the opposite ramp direction from every prior statistical rule, which is
  why it's a new function rather than a reused one.
- **Degenerate-case filter:** groups whose mean delta is under `BEACONING_MIN_MEAN_DELTA_MS`
  (2s) are skipped regardless of how low their CV is — a tight cluster of sub-2s requests is a
  browser retry/prefetch burst or a rapid double-click, not a beacon interval, and network-stack
  retries are often nearly as mechanically regular as a real timer, so the CV check alone
  wouldn't exclude them.
- **Thresholds (`apps/api/src/rules/config.ts`):** flag when CV ≤ `BEACONING_CV_LOOSE_THRESHOLD`
  (0.15); confidence scales from 55 at that loose edge up to 95 at/below
  `BEACONING_CV_TIGHT_THRESHOLD` (0.02, near-perfect regularity) via
  `scaleInverseThresholdConfidence`. Every event in a flagged group is flagged, not just one
  representative — the same "flag every participant" convention `burst-per-ip`/
  `repeated-blocked` already use, since every request in the beacon sequence is equally part of
  the evidence.
- **Known false-positive tradeoff, documented rather than hidden:** this is the same tradeoff
  every real beaconing detector has — legitimate, highly-regular polling traffic (streaming
  keep-alives, mail sync, a monitoring agent's own health-check heartbeat) can look statistically
  identical to a C2 check-in from timing alone. Not solved here, on purpose: triaging "regular
  because it's malware" vs. "regular because it's a keep-alive" is exactly the kind of
  open-ended, context-dependent judgment call §3 designed the bounded LLM judge layer to make
  (e.g. recognizing a known SaaS/CDN domain vs. an unrecognized one) — the deterministic rule's
  job is to surface the candidate, not adjudicate it alone.
- **Schema:** `'beaconing'` added to `packages/shared/src/anomaly.ts`'s
  `AnomalyRuleTypeSchema` (the Zod source of truth) and to the frontend's
  `RULE_TYPE_LABELS` map (`apps/web/src/components/anomalies-tab.tsx`, labeled "Beaconing (C2
  interval)"). The corresponding Postgres check-constraint widening
  (`supabase/migrations/0005_beaconing_rule_type.sql`, same drop-then-recreate pattern
  `0004_summary_pending.sql` used) is applied to the **local** dev Supabase instance only
  (required for `logs.integration.test.ts` to pass once the engine started producing real
  `beaconing` rows against `quick-demo.log`) — **not** applied to any hosted/remote Supabase
  project, which stays the user's call.
