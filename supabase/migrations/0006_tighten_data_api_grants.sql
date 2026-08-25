-- =============================================================================
-- 0006_tighten_data_api_grants.sql — drop unused write grants for `authenticated`
--
-- 0003_data_api_grants.sql granted `select, insert, update, delete` to
-- `authenticated` on all four application tables, matching the four RLS
-- verbs 0002_rls.sql defined "own row" policies for. In practice, every
-- write in the codebase (apps/api/src/routes/logs.ts, summary-stream.ts)
-- goes through the service-role client, scoped to server-generated ids and
-- a pre-verified user_id — the user-scoped (JWT) client is read-only, used
-- only for `select`. There is no delete-my-upload or similar feature that
-- needs `authenticated` to write directly.
--
-- Leaving insert/update/delete grants + policies in place let any signed-in
-- user hit PostgREST directly (with just the public anon key + their own
-- session JWT — both available to any browser client) and write to these
-- tables outside the trusted parse -> rule-engine -> LLM-judge pipeline:
-- delete their own anomalies/log_events/timeline_summaries rows (erasing
-- detected-threat evidence), insert fabricated anomaly rows that never went
-- through detection, or insert rows referencing another user's log_files.id
-- (the FK check runs as table owner and bypasses RLS, so this succeeds even
-- though the referenced file isn't theirs). Found in a post-build security
-- review; RLS's "own row" scoping meant this was never a cross-tenant read,
-- but it's still real API surface no legitimate flow uses.
--
-- Fix: `authenticated` only ever needs `select` on these four tables. Revoke
-- the unused write grants and drop the write policies that existed only to
-- match them. `service_role`'s grants (0003) are untouched — it still needs
-- full read/write and bypasses RLS by design.
--
-- Deliberately scoped to the four `public` tables only. `storage.objects`'s
-- `log_uploads_insert/update/delete_own_path` policies (0002_rls.sql) are
-- the same vulnerability class — the only Storage write in the codebase is
-- the service-role upload in apps/api/src/routes/logs.ts, so `authenticated`
-- doesn't need write access there either — but that's a separate bucket
-- with its own privilege-check quirks on hosted projects (see 0002's
-- insufficient_privilege swallow for `alter table storage.objects`), so it's
-- handled as its own follow-up: 0007_tighten_storage_grants.sql.
--
-- Run this after 0005_beaconing_rule_type.sql. Idempotent (safe to re-run).
-- =============================================================================

revoke insert, update, delete on public.log_files from authenticated;
revoke insert, update, delete on public.log_events from authenticated;
revoke insert, update, delete on public.anomalies from authenticated;
revoke insert, update, delete on public.timeline_summaries from authenticated;

drop policy if exists "log_files_insert_own" on public.log_files;
drop policy if exists "log_files_update_own" on public.log_files;
drop policy if exists "log_files_delete_own" on public.log_files;

drop policy if exists "log_events_insert_own" on public.log_events;
drop policy if exists "log_events_update_own" on public.log_events;
drop policy if exists "log_events_delete_own" on public.log_events;

drop policy if exists "anomalies_insert_own" on public.anomalies;
drop policy if exists "anomalies_update_own" on public.anomalies;
drop policy if exists "anomalies_delete_own" on public.anomalies;

drop policy if exists "timeline_summaries_insert_own" on public.timeline_summaries;
drop policy if exists "timeline_summaries_update_own" on public.timeline_summaries;
drop policy if exists "timeline_summaries_delete_own" on public.timeline_summaries;
