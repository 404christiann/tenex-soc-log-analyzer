-- =============================================================================
-- 0007_tighten_storage_grants.sql — drop unused write policies on log-uploads
--
-- Follow-up to 0006_tighten_data_api_grants.sql, same vulnerability class,
-- applied to Storage instead of the four `public` tables: 0002_rls.sql gave
-- `authenticated` insert/update/delete policies on `storage.objects` for the
-- `log-uploads` bucket's own-path objects (`uploads/{auth.uid()}/...`). But
-- the only Storage write anywhere in the codebase is the service-role
-- upload in apps/api/src/routes/logs.ts (line ~140) — there is no
-- user-facing download, re-upload, or delete-my-file route, and the
-- frontend never touches Storage directly (apps/web/src only calls
-- `supabase.auth.*`).
--
-- Leaving those policies in place lets any signed-in user hit the Storage
-- REST API directly (anon key + their own session JWT) and, within their
-- own `uploads/{uid}/` prefix: overwrite the raw log file the parse/rule
-- engine/LLM pipeline already ran against (tampering with the evidence
-- artifact after the fact, with no record the file changed), upload
-- arbitrary unrelated objects (storage abuse — no size/type checks apply
-- outside the real upload route's multer validation), or delete the
-- original file. All outside the trusted pipeline, same as 0006.
--
-- Fix: drop the three write policies, keep `log_uploads_select_own_path` —
-- a future download feature would need select `to authenticated already
-- has it via that policy.
--
-- Wrapped in a DO block with the same insufficient_privilege swallow
-- 0002_rls.sql uses for `alter table storage.objects enable row level
-- security`: the role that runs migrations doesn't always own
-- storage.objects (e.g. the Supabase CLI's local-dev migration runner), in
-- which case dropping its policies isn't possible from a migration at all —
-- that's expected and safe to no-op rather than aborting the migration; on
-- a hosted project where the migration role does own the table, this runs
-- for real. If it silently no-ops on a project, verify manually afterward
-- (Dashboard -> Storage -> log-uploads -> Policies) and drop the three
-- write policies by hand, same as 0002's own bucket-creation fallback note.
--
-- Run this after 0006_tighten_data_api_grants.sql. Idempotent (safe to re-run).
-- =============================================================================

do $$
begin
  drop policy if exists "log_uploads_insert_own_path" on storage.objects;
  drop policy if exists "log_uploads_update_own_path" on storage.objects;
  drop policy if exists "log_uploads_delete_own_path" on storage.objects;
exception
  when insufficient_privilege then
    null;
end;
$$;
