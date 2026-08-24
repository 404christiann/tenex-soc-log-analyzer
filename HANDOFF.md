# Handoff — Tenex SOC Log Analyzer

Written because the prior session's context window filled up. Read this first, then
`DECISIONS.md` for the full "why" behind every architecture/design choice — this file is just
"where things stand right now and what to do next," not a replacement for that record.

## ⚠️ Most urgent thing: nothing is committed except the very first commit

```
git log --oneline
4639b39 Scaffold monorepo foundation: apps/web, apps/api, packages/shared, Supabase schema+RLS
```

**77 files of real, working, tested code sit uncommitted** in the working tree — the entire
v1 build (parser, rule engine, LLM layer, API, frontend, passwordless auth, three rounds of UI
design polish) has never been committed past the original scaffold. Before anything else, either
commit this (in sensible chunks or as one commit — ask the user which they'd prefer) or at least
make sure nothing gets lost. This is the single biggest risk right now.

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
- Parser + 7-rule deterministic anomaly engine (statistically grounded confidence scores)
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

## Deferred stretch items (never started, all explicitly optional per DECISIONS.md §5/§14)

- Rate limiting on login/upload endpoints
- Security headers (helmet-equivalent) + CORS hardening beyond the current single-origin allow
- Cloud deployment (Vercel + Render + Supabase — DECISIONS.md §14 has the plan and flags a known
  Render cold-start risk)
- Beaconing detection (interval-regularity anomaly rule)
- Password-reset-style "forgot access" flow (moot now — auth is passwordless)

## Take-home deliverables — status check

- [x] Working app, all must-haves + bonus anomaly detection
- [x] README.md with setup instructions, AI-usage docs, anomaly-detection approach
- [x] Example log files (`examples/`, plus the separate stress-test repo)
- [ ] **GitHub repo created and shared with venkata@tenex.ai** — not done, nothing pushed anywhere
- [ ] **Screen recording walkthrough** — not done, this is the user's own task
- [ ] Live deploy link (optional bonus, not started)

The two unchecked items closest to done are committing + pushing to GitHub — worth raising with
the user early in the new session, since it's the actual submission mechanism and nothing is
backed up anywhere yet.
