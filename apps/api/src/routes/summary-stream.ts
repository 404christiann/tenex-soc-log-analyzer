import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Anomaly, LogEvent, SummaryStreamEvent } from "@tenex/shared";
import { getServiceRoleClient, getUserScopedClient } from "../db/supabase";
import { toAnomaly, toStoredLogEvent, type AnomalyRow, type LogEventRow, type LogFileRow } from "../db/mappers";
import { HttpError } from "../errors";
import { isAnthropicConfigured } from "../llm/client";
import { generateFallbackSummary, streamSummary } from "../llm/summary";
import { fetchOwnedFile } from "./logs";
import { FileIdParamsSchema } from "./schemas";

/**
 * `GET /api/logs/:id/summary/stream` — on-demand, cached-after-first-
 * generation timeline-summary streaming over SSE (DECISIONS.md §14c).
 *
 * Auth/RLS: identical pattern to every other read route (§14a Option A) —
 * the file lookup and the "does a summary already exist" probe both go
 * through the caller's own JWT-scoped client, so Postgres RLS is the real
 * enforcement layer (a file belonging to another user 404s before any SSE
 * output, indistinguishable from a nonexistent id). The service-role client
 * appears only for the post-generation persistence write, consistent with
 * how the upload route persists rows (§14a's narrow-service-role rule).
 *
 * Wire contract: `packages/shared/src/llm-status.ts`'s
 * `SummaryStreamEventSchema` — each frame is `event: <type>` +
 * `data: <JSON matching the union member>`. Every connection ends with
 * exactly one `done` event; see the schema's doc comment for the full
 * ordering guarantees.
 */

/** SSE connections outlive the default socket timeout; a real generation is ~10-30s, so cap generously rather than disabling timeouts entirely. */
const SUMMARY_STREAM_TIMEOUT_MS = 120_000;

/** PostgREST caps a single select at 1000 rows — page through log_events in chunks of this size to rebuild the full event list for prompt grounding. */
const EVENT_FETCH_PAGE_SIZE = 1000;

function writeSseEvent(res: Response, event: SummaryStreamEvent): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** Starts the SSE response. After this point failures can no longer become JSON error responses — they must surface as `failed`/`done` events on the stream itself. */
function openSseStream(req: Request, res: Response): void {
  req.setTimeout(SUMMARY_STREAM_TIMEOUT_MS);
  res.setTimeout(SUMMARY_STREAM_TIMEOUT_MS);
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

/**
 * Fetches ALL events for a file (datetime ascending), plus its anomalies,
 * through the user-scoped client. Anomalies come back with `eventRef` set
 * to the event's DB row id (see `db/mappers.ts`); this remaps each to the
 * event's index in the returned array, which is the in-memory `eventRef`
 * convention `buildSummaryUserPrompt`/`generateFallbackSummary` expect —
 * the same grounding-in-real-aggregates inputs the upload-time summary used
 * to get (§14c: reuse the prompt-building logic, don't reinvent it).
 */
async function fetchSummaryInputs(
  client: SupabaseClient,
  fileId: string,
): Promise<{ events: LogEvent[]; anomalies: Anomaly[] }> {
  const eventRows: LogEventRow[] = [];
  for (let page = 0; ; page++) {
    const from = page * EVENT_FETCH_PAGE_SIZE;
    const { data, error } = await client
      .from("log_events")
      .select("*")
      .eq("log_file_id", fileId)
      .order("datetime", { ascending: true })
      // Deterministic tiebreak so paging never duplicates/drops rows that
      // share a timestamp.
      .order("id", { ascending: true })
      .range(from, from + EVENT_FETCH_PAGE_SIZE - 1);
    if (error) {
      throw new HttpError(500, `Failed to fetch events for summary: ${error.message}`);
    }
    const rows = (data ?? []) as LogEventRow[];
    eventRows.push(...rows);
    if (rows.length < EVENT_FETCH_PAGE_SIZE) break;
  }

  const { data: anomalyData, error: anomalyError } = await client
    .from("anomalies")
    .select("*")
    .eq("log_file_id", fileId)
    .order("rank", { ascending: true });
  if (anomalyError) {
    throw new HttpError(500, `Failed to fetch anomalies for summary: ${anomalyError.message}`);
  }

  const indexByEventId = new Map<string, number>(eventRows.map((row, i) => [row.id, i]));
  const events: LogEvent[] = eventRows.map((row) => {
    // StoredLogEvent is a strict superset of LogEvent — drop the identity
    // fields so the prompt builder sees exactly the in-memory shape.
    const { id: _id, logFileId: _logFileId, ...event } = toStoredLogEvent(row);
    return event;
  });
  const anomalies: Anomaly[] = ((anomalyData ?? []) as AnomalyRow[]).map((row) => {
    const mapped = toAnomaly(row);
    const index = indexByEventId.get(row.log_event_id);
    return { ...mapped, eventRef: index === undefined ? mapped.eventRef : String(index) };
  });

  return { events, anomalies };
}

/**
 * Persists a completed generation: upserts the `timeline_summaries` row
 * (upsert rather than insert so two racing connections for the same file
 * can't crash on the unique `log_file_id` index — last writer wins, both
 * wrote a real result) and records the outcome on `log_files`. Service-role
 * client, per §14a Option A: this is a processing write with no prior
 * "read" to scope, exactly like the upload route's inserts.
 */
async function persistSummary(
  fileId: string,
  userId: string,
  summary: string,
  status: "ok" | "failed",
  reason: string | null,
): Promise<void> {
  const serviceClient = getServiceRoleClient();

  const { error: upsertError } = await serviceClient
    .from("timeline_summaries")
    .upsert({ log_file_id: fileId, user_id: userId, summary }, { onConflict: "log_file_id" });
  if (upsertError) {
    throw new Error(`Failed to persist timeline summary: ${upsertError.message}`);
  }

  const { error: statusError } = await serviceClient
    .from("log_files")
    .update({ llm_summary_status: status, llm_summary_status_reason: reason })
    .eq("id", fileId);
  if (statusError) {
    throw new Error(`Failed to record summary status: ${statusError.message}`);
  }
}

/**
 * Persistence runs after the SSE stream is already open, so a DB failure
 * here can't become a JSON error response — it's logged and the stream
 * still ends with an honest `done` (worst case: nothing was cached, and the
 * next connection simply regenerates).
 */
async function persistSummaryBestEffort(
  fileId: string,
  userId: string,
  summary: string,
  status: "ok" | "failed",
  reason: string | null,
): Promise<void> {
  try {
    await persistSummary(fileId, userId, summary, status, reason);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[summary-stream] ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleSummaryStream(req: Request, res: Response): Promise<void> {
  const { id } = FileIdParamsSchema.parse(req.params);
  const userClient = getUserScopedClient(req.accessToken!);

  // Everything up to here (param validation, auth, RLS-scoped ownership
  // check) fails as a normal JSON error response — SSE framing only starts
  // once we know we have a real, visible file to stream about.
  const fileRow = await fetchOwnedFile(userClient, id);
  if (!fileRow) {
    throw new HttpError(404, "Log file not found.");
  }

  // "Does a summary already exist" probe — §14c: a row in
  // timeline_summaries exists if and only if a generation (or its fallback)
  // completed for this file, so this is a plain RLS-scoped existence check.
  const { data: existing, error: existingError } = await userClient
    .from("timeline_summaries")
    .select("summary")
    .eq("log_file_id", id)
    .maybeSingle();
  if (existingError) {
    throw new HttpError(500, `Failed to check for existing summary: ${existingError.message}`);
  }

  // --- Cached replay: no LLM call, ever, for an already-generated summary ---
  if (existing) {
    openSseStream(req, res);
    const replayStatus = fileRow.llm_summary_status === "failed" ? "failed" : "ok";
    writeSseEvent(res, {
      type: "done",
      summary: (existing as { summary: string }).summary,
      status: replayStatus,
      ...(replayStatus === "failed" && fileRow.llm_summary_status_reason
        ? { reason: fileRow.llm_summary_status_reason }
        : {}),
      cached: true,
    });
    res.end();
    return;
  }

  // Still a plain JSON error (via the normal error handler) if this read
  // fails — the SSE handshake below only happens once every DB read that
  // can fail with an HTTP status has succeeded.
  const { events, anomalies } = await fetchSummaryInputs(userClient, id);

  openSseStream(req, res);

  // --- No key configured: honest immediate signal, no fake thinking (§14c) ---
  // Deliberately NOT persisted: if a key is configured later, the next
  // connection should run a real generation instead of replaying a
  // "nothing was configured" fallback forever.
  if (!isAnthropicConfigured()) {
    writeSseEvent(res, { type: "not_configured" });
    writeSseEvent(res, {
      type: "done",
      summary: generateFallbackSummary(events, anomalies),
      status: "not_configured",
      cached: false,
    });
    res.end();
    return;
  }

  // --- Live generation ---
  // If the client disconnects mid-generation, further SSE writes become
  // no-ops (writeSseEvent guards on writableEnded/destroyed via the closed
  // response) but generation is allowed to finish and persist — so the
  // result is cached for the reconnect rather than re-billed.
  const result = await streamSummary(events, anomalies, {
    onThinkingDelta: (delta) => writeSseEvent(res, { type: "thinking", delta }),
    onTextDelta: (delta) => writeSseEvent(res, { type: "text", delta }),
  });

  if (result.status.status === "failed") {
    writeSseEvent(res, { type: "failed", reason: result.status.reason ?? "Unknown error" });
    await persistSummaryBestEffort(id, req.user!.id, result.markdown, "failed", result.status.reason ?? null);
    writeSseEvent(res, {
      type: "done",
      summary: result.markdown,
      status: "failed",
      ...(result.status.reason ? { reason: result.status.reason } : {}),
      cached: false,
    });
    res.end();
    return;
  }

  // streamSummary only returns not_configured before any call happens, and
  // that branch was handled above — so this is the success path.
  await persistSummaryBestEffort(id, req.user!.id, result.markdown, "ok", null);
  writeSseEvent(res, { type: "done", summary: result.markdown, status: "ok", cached: false });
  res.end();
}
