-- =============================================================================
-- 0004_summary_pending.sql — decoupled streaming summary (DECISIONS.md §14c)
--
-- §14c moves timeline-summary generation out of the synchronous upload
-- request and onto its own on-demand SSE endpoint. At upload time the
-- summary hasn't been attempted at all yet — which is a genuinely new state,
-- distinct from all three of §14a's statuses (`not_configured` / `failed` /
-- `ok` all describe the outcome of an attempt). This migration adds that
-- fourth state, `pending`, to `log_files.llm_summary_status` and makes it
-- the default for new uploads.
--
-- The judge's `llm_judge_status` is deliberately untouched — the judge stays
-- synchronous inside the upload request (§14c point 2), so its three-state
-- model still holds.
--
-- `timeline_summaries` itself needs no change: under §14c a row is only
-- inserted once generation actually completes (successfully or via the
-- deterministic fallback on failure), so "no row yet" IS the pending state
-- at the summary-table level, and the SSE endpoint's "does a summary already
-- exist" check is a simple row-existence probe against the same unique
-- (log_file_id) index 0001 already created.
-- =============================================================================

alter table public.log_files
  drop constraint if exists log_files_llm_summary_status_check;

alter table public.log_files
  add constraint log_files_llm_summary_status_check
  check (llm_summary_status in ('pending', 'not_configured', 'failed', 'ok'));

alter table public.log_files
  alter column llm_summary_status set default 'pending';

comment on column public.log_files.llm_summary_status is
  'Summary generation state (DECISIONS.md §14c): ''pending'' until the SSE endpoint generates it, then ''ok''/''failed''. ''not_configured'' is legacy data from pre-§14c uploads (the SSE endpoint reports not_configured live per-connection instead of persisting it, so a key added later still triggers real generation).';
