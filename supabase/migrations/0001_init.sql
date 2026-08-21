-- =============================================================================
-- 0001_init.sql — core schema for the Tenex SOC Log Analyzer
--
-- Implements DECISIONS.md §8 (data model) as sharpened by §14a ("Open items
-- resolved after Fable's implementation plan"). Users come from Supabase
-- Auth's built-in `auth.users` — no bespoke users table is created here.
--
-- Run this before 0002_rls.sql. Both files are idempotent (safe to re-run).
-- =============================================================================

-- gen_random_uuid() — bundled with Postgres 13+ / always available on Supabase,
-- but `create extension if not exists pgcrypto` is included defensively in
-- case it's ever applied against a stripped-down Postgres instance.
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- log_files
-- -----------------------------------------------------------------------------
-- One row per uploaded log file. `status` is the honest processing state
-- (never silently "done") and `error_message` carries the reason on failure.
-- `llm_judge_status` / `llm_summary_status` track the two LLM features'
-- three-state status independently, per §14a "LLM graceful degradation"
-- (`not_configured` | `failed` | `ok`); the paired `_reason` columns store
-- the actual failure reason (auth error, rate limit, timeout, refusal, ...)
-- for the "failed" state, never a generic message.
create table if not exists public.log_files (
  id uuid primary key default gen_random_uuid(),
  -- Owner. Also denormalized onto log_events/anomalies/timeline_summaries
  -- below so every table's RLS policy is a plain `user_id = auth.uid()`
  -- check, not an EXISTS-subquery join — see §14a "RLS enforcement".
  user_id uuid not null references auth.users (id) on delete cascade,
  filename text not null,
  -- Path inside the private `log-uploads` Storage bucket, e.g.
  -- `uploads/{user_id}/{file_id}.log` — see §9 and 0002_rls.sql.
  storage_path text not null,
  uploaded_at timestamptz not null default now(),
  status text not null default 'processing'
    check (status in ('processing', 'complete', 'failed')),
  error_message text,
  llm_judge_status text not null default 'not_configured'
    check (llm_judge_status in ('not_configured', 'failed', 'ok')),
  llm_judge_status_reason text,
  llm_summary_status text not null default 'not_configured'
    check (llm_summary_status in ('not_configured', 'failed', 'ok')),
  llm_summary_status_reason text,
  created_at timestamptz not null default now()
);

create index if not exists log_files_user_id_idx
  on public.log_files (user_id);

comment on table public.log_files is
  'One row per uploaded log file. status/error_message/llm_*_status(+_reason) exist so failure is always surfaced, never silent — DECISIONS.md §14a.';

-- -----------------------------------------------------------------------------
-- log_events
-- -----------------------------------------------------------------------------
-- Parsed rows from a log file. Field names mirror the NSS-style wire format
-- locked in §14a (`datetime=`, `cip=`, `login=`, ...) and packages/shared's
-- LogEventSchema 1:1, EXCEPT `login` -> `log_user`: the wire/Zod field is
-- called `login`, but the DB column is `log_user` to avoid any ambiguity
-- with Postgres/Supabase Auth's own "user" semantics (per §8's explicit
-- naming note) while still reading clearly as "the log's user field".
create table if not exists public.log_events (
  id uuid primary key default gen_random_uuid(),
  log_file_id uuid not null references public.log_files (id) on delete cascade,
  -- Denormalized owner — see the comment on log_files.user_id above.
  user_id uuid not null references auth.users (id) on delete cascade,

  datetime timestamptz not null, -- wire field `datetime=`
  cip text not null, -- wire field `cip=` (client IP)
  log_user text not null, -- wire field `login=` (see naming note above)
  url text not null, -- wire field `url=`
  action text not null check (action in ('allowed', 'blocked')), -- wire field `action=`
  urlcat text not null check (urlcat in ( -- wire field `urlcat=`
    -- Benign (8) — locked taxonomy, DECISIONS.md §14a
    'Business', 'Social Networking', 'Streaming Media', 'News & Media',
    'Technology', 'Shopping', 'Webmail', 'File Sharing',
    -- High-risk (4) — drives the malware-category rule
    'Malware Sites', 'Phishing', 'Botnet Callback', 'Spyware or Adware',
    -- Fallback
    'Uncategorized'
  )),
  threatname text, -- wire field `threatname=`; nullable direct threat signal
  respcode integer not null, -- wire field `respcode=`
  bytes_out bigint not null check (bytes_out >= 0), -- wire field `bytes_out=`
  bytes_in bigint not null check (bytes_in >= 0), -- wire field `bytes_in=`
  useragent text not null, -- wire field `useragent=`
  reqmethod text not null check (reqmethod in ( -- wire field `reqmethod=`
    'GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE'
  )),

  created_at timestamptz not null default now()
);

-- The task's own required index: ordered lookups/scans of a file's events.
create index if not exists log_events_log_file_id_datetime_idx
  on public.log_events (log_file_id, datetime);

create index if not exists log_events_user_id_idx
  on public.log_events (user_id);

comment on table public.log_events is
  'Parsed log rows. log_user = wire field "login" (see column comment) to avoid clashing with Postgres/auth "user" semantics — DECISIONS.md §8.';

-- -----------------------------------------------------------------------------
-- anomalies
-- -----------------------------------------------------------------------------
-- Layer 1 (deterministic) + optionally Layer 2 (LLM judge) results for one
-- flagged log_event. base_confidence and llm_adjusted_confidence are kept as
-- separate columns and NEITHER IS EVER OVERWRITTEN BY THE OTHER, so the UI
-- can always show "deterministic score vs. what the judge nudged it to and
-- why" — DECISIONS.md §3/§8. base_confidence is always populated (Layer 1 is
-- what created this row in the first place); llm_adjusted_confidence is
-- nullable — null whenever the judge didn't run, failed, or this event fell
-- outside the batched top-N candidates (§3).
create table if not exists public.anomalies (
  id uuid primary key default gen_random_uuid(),
  log_event_id uuid not null references public.log_events (id) on delete cascade,
  -- Denormalized for convenient "anomalies for this file" queries without a
  -- join through log_events; same rationale as user_id below.
  log_file_id uuid not null references public.log_files (id) on delete cascade,
  -- Denormalized owner — see the comment on log_files.user_id above.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- v1 rule set, DECISIONS.md §3/§14a. The rule that produced this row's
  -- base_confidence (the max-confidence rule, if several fired on the event).
  rule_type text not null check (rule_type in (
    'burst_per_ip', 'bytes_out_exfil', 'threatname_hit', 'malware_category',
    'repeated_blocked', 'off_hours', 'rare_scripted_user_agent'
  )),
  -- Every rule reason that fired on this event, not just the winning one
  -- (§3: "take the max confidence, list all triggered reasons").
  triggered_reasons text[] not null default '{}',
  base_confidence numeric(5, 2) not null
    check (base_confidence >= 0 and base_confidence <= 100),
  llm_adjusted_confidence numeric(5, 2)
    check (llm_adjusted_confidence is null
      or (llm_adjusted_confidence >= 0 and llm_adjusted_confidence <= 100)),
  explanation text not null, -- Layer 1 templated explanation; always present
  llm_explanation text, -- Layer 2 reworded/contextualized explanation; nullable
  rank integer not null default 0, -- display/severity ordering

  created_at timestamptz not null default now()
);

create index if not exists anomalies_log_file_id_idx
  on public.anomalies (log_file_id);
create index if not exists anomalies_log_event_id_idx
  on public.anomalies (log_event_id);
create index if not exists anomalies_user_id_idx
  on public.anomalies (user_id);

comment on table public.anomalies is
  'base_confidence (Layer 1, always set) and llm_adjusted_confidence (Layer 2, nullable) are separate columns, never merged — DECISIONS.md §3/§8.';

-- -----------------------------------------------------------------------------
-- timeline_summaries
-- -----------------------------------------------------------------------------
-- The LLM-generated (or deterministic-fallback, per §14a) narrative for one
-- file. One synchronous processing pass per file (§10) => at most one
-- summary per file, enforced by the unique index below.
create table if not exists public.timeline_summaries (
  id uuid primary key default gen_random_uuid(),
  log_file_id uuid not null references public.log_files (id) on delete cascade,
  -- Denormalized owner — see the comment on log_files.user_id above.
  user_id uuid not null references auth.users (id) on delete cascade,
  summary text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists timeline_summaries_log_file_id_key
  on public.timeline_summaries (log_file_id);
create index if not exists timeline_summaries_user_id_idx
  on public.timeline_summaries (user_id);
