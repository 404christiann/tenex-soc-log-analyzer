# Handoff — Tenex SOC Log Analyzer

Written because the prior session's context window filled up. Read this first, then
`DECISIONS.md` for the full "why" behind every architecture/design choice — this file is just
"where things stand right now and what to do next," not a replacement for that record.

## It's committed, pushed, and deployed

Everything is on GitHub (`github.com/404christiann/tenex-soc-log-analyzer`, public, `main`) and
live in production:
- **Frontend:** https://tenex-soc-log-analyzer.vercel.app (Vercel, auto-deploys on push to `main`)
- **Backend:** https://tenex-soc-log-analyzer.onrender.com (Render free tier, same deploy trigger)
- **Database/Auth:** Supabase project `tenexai` (`jjtmuqmzimpmkybojjdx`), all migrations applied
  through `0004_summary_pending.sql`; `0005_beaconing_rule_type.sql` (this session's stretch-item
  work) is written but applied to **local dev only** — see the stretch-items section below for
  why it still needs a deliberate hosted-apply step before beaconing works in production.
- **Keep-alive:** a cron-job.org job pings the Render `/health` endpoint every 10 minutes (outside
  this repo — configured directly in the user's cron-job.org account) to dodge the free tier's
  15-minute idle sleep.
- **Auth is fully working end-to-end in production**, not just locally: hosted Supabase's Site
  URL, redirect URLs, Resend SMTP (sandbox sender `onboarding@resend.dev`, no domain verification
  yet), both email templates, and the OTP code length (was defaulting to 8, app expects 6) were
  all fixed against the *hosted* project this session — none of this lives in `config.toml`, which
  only governs the local CLI stack.

## What this project is

A full-stack SOC log analysis take-home for Tenex Engineering. Upload a web proxy log, get it
parsed, anomaly-detected (deterministic rule engine + a bounded LLM judge), and summarized with
a real-time-streamed AI narrative. Every architecture decision — and the reasoning, including
several reversed decisions — is recorded in `DECISIONS.md` in this repo. Read §1 for the
overview and work forward; the most recent sections (§14a onward) cover the post-v1 design
passes done across this and the prior session.

## Is v1 done?

Yes. Every must-have from the take-home is built and verified:
- Passwordless OTP auth (Supabase Auth, no passwords anywhere)
- Log upload with real server-side validation (extension/size/magic-byte/content checks)
- Parser + 8-rule deterministic anomaly engine (statistically grounded confidence scores —
  the 8th rule, beaconing, was added post-v1 as a stretch item, DECISIONS.md §15)
- LLM judge (Claude Sonnet 5) that can only refine existing findings within a ±15 confidence
  band — never invents or removes anomalies
- Real streaming AI timeline summary (Sonnet 5, adaptive thinking visible while it streams),
  now combining: an instant stat strip + a "Key takeaway" TL;DR hero + severity-grouped
  (High/Medium/Low) chronological findings, each citing a real event you can click through to
  in the Anomalies tab
- RLS-enforced multi-tenant isolation (attack-tested against a disposable Postgres)
- Full Playwright E2E suite + API integration/unit suite, all green

## How to run it right now

```bash
cd /Users/christianalcala/tenex-soc-log-analyzer
npx supabase status          # confirm local Supabase is up; `npx supabase start` if not
npm run dev:api               # apps/api, port 4000
npm run dev:web -- --port 3018   # apps/web, port 3018
```

Health check: `curl http://localhost:4000/health`. Local sign-in codes land in Mailpit at
**http://localhost:55324** (auth is passwordless — there's no password to hand anyone).

**Known quirk:** dev servers do not reliably survive between Claude Code sessions/restarts —
always verify with a real `curl`, don't assume "I started it earlier" means it's still up.

## This session's arc (the short version — full detail in DECISIONS.md §14c–§14e)

Did a UI/UX polish pass across the whole app (Preline-referenced dropzone + progress states,
real logo, light-mode-only theming), then a deep pass specifically on the Timeline tab:
1. Fixed several real rendering bugs (citation pills breaking out of sentence flow — a genuine
   `<button>`-vs-`<span>` browser quirk, not styling; badge vertical misalignment, measured to
   the pixel; timestamp formatting; bullet structure — one flagged event per bullet, verified
   against a deliberately adversarial stress-test file).
2. User asked for a genuine redesign of the Timeline tab's presentation. Built **three parallel
   design directions in isolated git worktrees** (Executive Digest / Severity-Grouped / Visual
   Timeline), each a real working prototype, verified live against the real Anthropic API.
3. After back-and-forth (the user picked one, reconsidered, picked another, then asked to
   **combine** two of them), the shipped result — now live in `main`'s actual working tree, not
   a worktree — is: **stat strip + TL;DR hero + severity-grouped findings**, all in one summary.

## Loose ends / things a fresh session might need to know about

- **Two unused design-exploration worktrees still exist on disk**, intentionally not deleted:
  - `.claude/worktrees/agent-ace46e2b52ef2373b` — the standalone severity-grouped prototype
    (superseded by what's now in main, which already includes severity-grouping)
  - `.claude/worktrees/agent-a8b07cd300ad741d6` — the **Visual Timeline** direction (density
    strip + marker rail). This one was built and verified but never chosen. If the user wants to
    revisit it, it's still there — a `tenex-timeline-visual-web`/`-api` entry exists in
    `~/.claude/launch.json` (ports 3021/4021) to run it. Its `apps/api/.env` has
    `FRONTEND_ORIGIN=http://localhost:3021` (was `127.0.0.1`, fixed during this session).
  - Both are safe to `git worktree remove` if the user confirms they're done comparing —
    not done automatically since deleting real work isn't this session's call to make alone.
- **`~/.claude/launch.json`** has accumulated entries from this session's server juggling —
  currently should just have `tenex-soc-log-analyzer-web`/`-api` (main app) and the
  visual-timeline pair above. Worth a glance if dev-server names seem to not match reality.
- **A separate local git repo** at `~/Downloads/tenexTestingLogFiles/` holds the four official
  example files plus three adversarial stress-test files (high-density, multi-burst,
  sparse-spike) for manual testing — local commits only, never pushed anywhere.
- The preview/dev-server tool this session used caps at **5 concurrent servers** — running the
  main app plus more than one exploration worktree at once isn't possible; expect to stop one
  to start another if comparing things side-by-side again.

## Deferred stretch items (all explicitly optional per DECISIONS.md §5/§14)

Three of the original five are now **done** (this session — DECISIONS.md §15 has the full
design/reasoning for all three):
- ~~Rate limiting on login/upload endpoints~~ — done. `POST /api/logs/upload` and
  `GET /api/logs/:id/summary/stream` are behind a per-IP `express-rate-limit`
  (`apps/api/src/middleware/rate-limit.ts`). There was never a server-side login endpoint to
  rate-limit (§14d: auth is Supabase's own `signInWithOtp`/`verifyOtp`, called directly from
  the browser), so "login" here always meant upload's abuse surface.
- ~~Security headers (helmet-equivalent) + CORS hardening beyond the current single-origin
  allow~~ — done. `helmet()` (one deliberate override — `Cross-Origin-Resource-Policy:
  cross-origin`, since apps/web/apps/api are different origins) plus CORS now explicit about
  methods/allowed headers and `credentials: false`. See `apps/api/src/app.ts`.
- ~~Beaconing detection (interval-regularity anomaly rule)~~ — done, the 8th rule.
  `apps/api/src/rules/beaconing.ts` — coefficient-of-variation on inter-arrival deltas grouped
  by (`cip`, destination host). Wired into `runRuleEngine`, the `AnomalyRuleType` union, and the
  Anomalies tab's rule-type labels. Known, documented false-positive tradeoff: can flag
  legitimate highly-regular polling (keep-alives, mail sync) the same way real beaconing
  detectors do — that's what the LLM judge layer is for.
  **Not yet live in production**: `supabase/migrations/0005_beaconing_rule_type.sql` (widens
  `anomalies.rule_type`'s check constraint) has only been applied to local dev Postgres, by
  deliberate choice during this session — hosted DB changes were kept as a manual, reviewed step
  rather than something a background agent applies unattended. Until it's applied to the hosted
  `tenexai` project, a real `beaconing` finding in production will 500 on insert. Apply it the
  same way `0001`-`0004` were applied this session (Supabase MCP `apply_migration`, project id
  `jjtmuqmzimpmkybojjdx`) before relying on this rule in the deployed app.
- ~~Cloud deployment~~ — done. See "It's committed, pushed, and deployed" at the top of this file.

Still genuinely deferred:
- Password-reset-style "forgot access" flow (moot now — auth is passwordless)
- Branded Resend sending domain (`tenexai.onziofutbol.com` per DECISIONS.md §14d) — production
  auth currently sends from Resend's shared `onboarding@resend.dev` sandbox address, which works
  but isn't a verified custom domain; SPF/DKIM setup is a "whenever the user wants it" follow-up.

## Take-home deliverables — status check

- [x] Working app, all must-haves + bonus anomaly detection (now 8 rules, not 7)
- [x] README.md with setup instructions, AI-usage docs, anomaly-detection approach
- [x] Example log files (`examples/`, plus the separate stress-test repo)
- [x] Live deploy link — https://tenex-soc-log-analyzer.vercel.app
- [ ] **GitHub repo shared with venkata@tenex.ai** — repo is pushed and public
  (`github.com/404christiann/tenex-soc-log-analyzer`), but the user has explicitly said not to
  send it yet. Just needs the user's go-ahead, then it's a one-line email/message with the link.
- [ ] **Screen recording walkthrough** — not done, this is the user's own task.

The two remaining items are both the user's to actually execute (send the link, record the
video) — nothing left here that a coding session can do unilaterally.
