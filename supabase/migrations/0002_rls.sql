-- =============================================================================
-- 0002_rls.sql — Row Level Security + private Storage bucket
--
-- Implements DECISIONS.md §7 and §14a's "RLS enforcement — Option A":
-- Express builds a Supabase client scoped to the caller's own JWT for all
-- reads, and Postgres RLS itself decides what rows come back — the API
-- never manually filters by user_id on reads. This is what makes the RLS
-- story real rather than decorative, so review these policies carefully;
-- they are the actual enforcement point, not a backstop.
--
-- The service-role key (used only for the Storage upload write and the
-- initial row inserts during processing, before there's a "read" to scope —
-- §14a) bypasses RLS entirely by design; nothing below restricts it.
--
-- Run this after 0001_init.sql. Both files are idempotent (safe to re-run).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Table RLS: every policy is a one-line `user_id = (select auth.uid())`
-- check, made possible by denormalizing user_id onto all four tables in
-- 0001_init.sql. `(select auth.uid())` (not bare `auth.uid()`) so Postgres
-- can cache the value once per query instead of calling it per row.
-- -----------------------------------------------------------------------------

alter table public.log_files enable row level security;
alter table public.log_events enable row level security;
alter table public.anomalies enable row level security;
alter table public.timeline_summaries enable row level security;

-- log_files
create policy "log_files_select_own" on public.log_files
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "log_files_insert_own" on public.log_files
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "log_files_update_own" on public.log_files
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "log_files_delete_own" on public.log_files
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- log_events
create policy "log_events_select_own" on public.log_events
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "log_events_insert_own" on public.log_events
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "log_events_update_own" on public.log_events
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "log_events_delete_own" on public.log_events
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- anomalies
create policy "anomalies_select_own" on public.anomalies
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "anomalies_insert_own" on public.anomalies
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "anomalies_update_own" on public.anomalies
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "anomalies_delete_own" on public.anomalies
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- timeline_summaries
create policy "timeline_summaries_select_own" on public.timeline_summaries
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "timeline_summaries_insert_own" on public.timeline_summaries
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "timeline_summaries_update_own" on public.timeline_summaries
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "timeline_summaries_delete_own" on public.timeline_summaries
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- Storage: private `log-uploads` bucket + path-scoped RLS
-- -----------------------------------------------------------------------------
-- Created here via SQL (insert into storage.buckets) so bucket creation is
-- captured in version control alongside its policies, instead of being an
-- undocumented manual step. If this insert is ever rejected by a Supabase
-- project's SQL editor permissions (some hosted setups restrict direct
-- writes to storage.buckets), create it manually instead: Dashboard ->
-- Storage -> New bucket -> name "log-uploads", Public = OFF — then still
-- apply the policies below, which target `storage.objects` and don't depend
-- on how the bucket row was created.
insert into storage.buckets (id, name, public)
values ('log-uploads', 'log-uploads', false)
on conflict (id) do nothing;

-- RLS is enabled on storage.objects by default on every Supabase project;
-- this statement is included defensively and is a no-op if already enabled.
-- Wrapped in a DO block because the role that runs migrations doesn't always
-- own storage.objects (e.g. the Supabase CLI's local-dev migration runner) —
-- in that case RLS is already on (Supabase's own storage bootstrap enables
-- it), so an insufficient_privilege error here is expected and safe to
-- swallow rather than letting it abort the whole migration.
do $$
begin
  alter table storage.objects enable row level security;
exception
  when insufficient_privilege then
    null;
end;
$$;

-- Objects are expected at `uploads/{auth.uid()}/{file_id}.log` (§9). The
-- Storage upload write itself goes through the service-role key (bypasses
-- RLS by design, per the file header) — these policies matter for any
-- read/download path that uses a JWT-scoped client instead, and guarantee a
-- user's own key can never resolve into another user's file path even if
-- application code had a bug.
create policy "log_uploads_select_own_path" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'log-uploads'
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "log_uploads_insert_own_path" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'log-uploads'
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "log_uploads_update_own_path" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'log-uploads'
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'log-uploads'
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "log_uploads_delete_own_path" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'log-uploads'
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );
