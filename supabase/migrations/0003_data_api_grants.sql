-- =============================================================================
-- 0003_data_api_grants.sql — explicit Data API role grants for Phase 7
--
-- Discovered while building Phase 7's disposable-local-Postgres integration
-- tests against a real local Supabase stack (Supabase CLI `supabase start`):
-- newly created Supabase projects (both local CLI and, per Supabase's own
-- `config.toml` comment on `api.auto_expose_new_tables`, freshly created
-- HOSTED projects too) no longer auto-grant table access to the Data API
-- roles (`anon`, `authenticated`, `service_role`) just because `postgres`
-- created the table — that legacy auto-expose behaviour is off by default
-- ("matching the new cloud default"). Without an explicit GRANT here, EVERY
-- query through PostgREST — including the service-role client, which
-- bypasses ROW level security but still needs the base table-level
-- privilege — fails with "permission denied for table ...", regardless of
-- how correct the RLS policies in 0002_rls.sql are.
--
-- This is a real, previously-latent gap: it would have surfaced the moment
-- anyone pointed this app at a freshly created real Supabase project, not
-- just this local stack. Scoped narrowly to the four application tables
-- (not a schema-wide `ALL TABLES`) so it's easy to audit alongside
-- 0001_init.sql's table list.
--
-- Run this after 0001_init.sql and 0002_rls.sql. Idempotent (safe to re-run)
-- — `grant` is a no-op if the privilege is already held.
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

-- `service_role` bypasses RLS (0002_rls.sql's file header) but Postgres
-- still checks base table privileges before RLS is ever evaluated — this is
-- what actually lets the upload route's service-role client insert/update
-- these rows during processing (DECISIONS.md §9/§14a).
grant select, insert, update, delete on public.log_files to service_role;
grant select, insert, update, delete on public.log_events to service_role;
grant select, insert, update, delete on public.anomalies to service_role;
grant select, insert, update, delete on public.timeline_summaries to service_role;

-- `authenticated` needs the same base grant for the RLS policies in
-- 0002_rls.sql to have anything to narrow — a `for select to authenticated
-- using (...)` policy is never reached if `authenticated` has no SELECT
-- privilege on the table at all. RLS is still what actually restricts which
-- ROWS come back (DECISIONS.md §14a "RLS enforcement — Option A") — this
-- grant only establishes that the role may query the table in principle.
grant select, insert, update, delete on public.log_files to authenticated;
grant select, insert, update, delete on public.log_events to authenticated;
grant select, insert, update, delete on public.anomalies to authenticated;
grant select, insert, update, delete on public.timeline_summaries to authenticated;
