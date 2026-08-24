import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LogFileMeta, PaginatedEvents, UploadResponse } from "@tenex/shared";
import { getServiceRoleClient, getUserScopedClient } from "../db/supabase";
import {
  toAnomaly,
  toLogFileMeta,
  toStoredLogEvent,
  type AnomalyRow,
  type LogEventRow,
  type LogFileRow,
} from "../db/mappers";
import { HttpError } from "../errors";
import { requireAuth } from "../middleware/auth";
import { summaryStreamRateLimiter, uploadRateLimiter } from "../middleware/rate-limit";
import { MAX_PARSED_EVENTS, UPLOAD_FIELD_NAME, uploadMulter, validateUpload } from "../middleware/upload-validate";
import { parseLogFile } from "../parser/parse-log";
import { runRuleEngine } from "../rules/engine";
import { judge } from "../llm/judge";
import { EventsQuerySchema, FileIdParamsSchema } from "./schemas";
import { handleSummaryStream } from "./summary-stream";

/**
 * `apps/api/src/routes/logs.ts` — DECISIONS.md §9/§10/§14a/§14c: the log
 * routes, all behind `requireAuth`. `POST /upload` touches the service-role
 * client (Storage write + initial/finalizing row writes), as does the
 * summary SSE route's post-generation persistence (`summary-stream.ts`);
 * every read goes through a client scoped to the caller's own JWT so
 * Postgres RLS is the real authorization layer.
 *
 * §14c: upload is parse -> rules -> judge -> persist -> respond. The
 * timeline summary is no longer generated here — it streams on demand from
 * `GET /:id/summary/stream` (see `summary-stream.ts`), leaving
 * `log_files.llm_summary_status` at its `'pending'` default until then.
 *
 * §5/§15: `/upload` and `/:id/summary/stream` also sit behind their own
 * per-IP rate limiter (`middleware/rate-limit.ts`) — the two genuinely
 * expensive/abusable routes in this API (real Anthropic calls, DB/Storage
 * writes), see that file's doc comment for the full reasoning.
 */

export const LOG_UPLOADS_BUCKET = "log-uploads";

/** DECISIONS.md §10 (as amended by §14c): bumped timeout for the synchronous parse -> rules -> judge chain (the summary no longer runs here). */
const UPLOAD_TIMEOUT_MS = 60_000;

/** How many events the synchronous upload response embeds directly (DECISIONS.md §10 — "not the entire potentially-thousands-of-rows array"). */
const UPLOAD_RESPONSE_EVENT_PAGE_SIZE = 100;

/** Cap on how many sample parse-error reasons the upload response embeds — never the full per-line list. */
const PARSE_ERROR_SAMPLE_LIMIT = 5;

/**
 * `GET /api/logs` convenience fields beyond `packages/shared`'s
 * `LogFileMetaSchema` (which intentionally doesn't carry per-file stats).
 * Kept local rather than extending the shared package in this phase — an
 * additive superset, so any consumer reading only the documented
 * `LogFileMeta` fields is unaffected.
 */
export interface LogFileMetaWithStats extends LogFileMeta {
  eventCount: number;
  anomalyCount: number;
}

export const logsRouter = Router();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function markFileFailed(client: SupabaseClient, fileId: string, message: string): Promise<void> {
  await client
    .from("log_files")
    .update({ status: "failed", error_message: message.slice(0, 2000) })
    .eq("id", fileId);
}

async function fetchEventsPage(
  client: SupabaseClient,
  logFileId: string,
  page: number,
  pageSize: number,
): Promise<PaginatedEvents> {
  const from = page * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await client
    .from("log_events")
    .select("*", { count: "exact" })
    .eq("log_file_id", logFileId)
    .order("datetime", { ascending: true })
    .range(from, to);

  if (error) {
    throw new HttpError(500, `Failed to fetch events: ${error.message}`);
  }

  return {
    items: ((data ?? []) as LogEventRow[]).map(toStoredLogEvent),
    pagination: { page, pageSize, totalCount: count ?? 0 },
  };
}

/**
 * Looks up one file by id through the user-scoped client. Returns `null`
 * both when the file genuinely doesn't exist AND when RLS hides it because
 * it belongs to a different user — the two cases are indistinguishable by
 * design (a 404, not a 403, so the API never confirms another user's file
 * id exists).
 */
export async function fetchOwnedFile(client: SupabaseClient, fileId: string): Promise<LogFileRow | null> {
  const { data, error } = await client.from("log_files").select("*").eq("id", fileId).maybeSingle();
  if (error) {
    throw new HttpError(500, `Failed to fetch log file: ${error.message}`);
  }
  return (data as LogFileRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/logs/upload
// ---------------------------------------------------------------------------

async function handleUpload(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) {
    throw new HttpError(400, `No file uploaded — expected multipart field "${UPLOAD_FIELD_NAME}".`);
  }

  const validation = validateUpload(file.originalname, file.buffer);
  if (!validation.ok) {
    throw new HttpError(validation.rejection.status, validation.rejection.message);
  }

  const userId = req.user!.id;
  const fileId = randomUUID();
  const storagePath = `uploads/${userId}/${fileId}.log`;
  const serviceClient = getServiceRoleClient();

  // --- Storage write (service-role, narrowly — DECISIONS.md §14a) ---
  const { error: storageError } = await serviceClient.storage
    .from(LOG_UPLOADS_BUCKET)
    .upload(storagePath, file.buffer, { contentType: "text/plain; charset=utf-8", upsert: false });
  if (storageError) {
    throw new HttpError(502, `Failed to store uploaded file: ${storageError.message}`);
  }

  // --- Initial log_files row (service-role; status='processing') ---
  const { data: insertedFile, error: insertFileError } = await serviceClient
    .from("log_files")
    .insert({
      id: fileId,
      user_id: userId,
      filename: validation.result.filename,
      storage_path: storagePath,
      status: "processing",
    })
    .select("*")
    .single();
  if (insertFileError || !insertedFile) {
    throw new HttpError(500, `Failed to create log file record: ${insertFileError?.message ?? "unknown error"}`);
  }

  try {
    // --- Parse (existing Phase 4 parser) ---
    const parseResult = parseLogFile(file.buffer);
    if (parseResult.fileLevelError) {
      await markFileFailed(serviceClient, fileId, parseResult.fileLevelError);
      throw new HttpError(400, parseResult.fileLevelError);
    }
    if (parseResult.events.length > MAX_PARSED_EVENTS) {
      const message = `File parsed to ${parseResult.events.length} events, exceeding the ${MAX_PARSED_EVENTS}-event processing cap for a single synchronous upload.`;
      await markFileFailed(serviceClient, fileId, message);
      throw new HttpError(413, message);
    }

    // --- Layer 1: deterministic rules (existing Phase 5 engine) ---
    const ruleAnomalies = runRuleEngine(parseResult.events);

    // --- Layer 2: LLM judge — self-degrading, never throws (Phase 6) ---
    // §14c: the timeline summary deliberately does NOT run here anymore —
    // it streams on demand from GET /:id/summary/stream (summary-stream.ts).
    const judgeResult = await judge(ruleAnomalies, parseResult.events);

    // --- Batch insert log_events (service-role) ---
    const eventInsertRows = parseResult.events.map((event) => ({
      log_file_id: fileId,
      user_id: userId,
      datetime: event.datetime,
      cip: event.cip,
      log_user: event.login,
      url: event.url,
      action: event.action,
      urlcat: event.urlcat,
      threatname: event.threatname,
      respcode: event.respcode,
      bytes_out: event.bytes_out,
      bytes_in: event.bytes_in,
      useragent: event.useragent,
      reqmethod: event.reqmethod,
    }));

    let insertedEventRows: LogEventRow[] = [];
    if (eventInsertRows.length > 0) {
      const { data, error } = await serviceClient.from("log_events").insert(eventInsertRows).select("*");
      if (error || !data) {
        throw new Error(`Failed to insert log events: ${error?.message ?? "unknown error"}`);
      }
      insertedEventRows = data as LogEventRow[];
    }

    // Postgres preserves row order for a single multi-row INSERT ...
    // RETURNING (matching the VALUES list order, which is what PostgREST
    // generates from this array) — this is what remaps each in-memory
    // anomaly's `eventRef` (an array index into `parseResult.events`, per
    // `rules/engine.ts`'s own doc comment) to the event's real DB row id.
    const eventIdByOriginalIndex = insertedEventRows.map((row) => row.id);

    const anomalyInsertRows = judgeResult.anomalies
      .map((anomaly) => ({
        log_event_id: eventIdByOriginalIndex[Number(anomaly.eventRef)],
        log_file_id: fileId,
        user_id: userId,
        rule_type: anomaly.ruleType,
        triggered_reasons: anomaly.triggeredReasons,
        base_confidence: anomaly.baseConfidence,
        llm_adjusted_confidence: anomaly.llmAdjustedConfidence,
        explanation: anomaly.explanation,
        llm_explanation: anomaly.llmExplanation,
        rank: anomaly.rank,
      }))
      // Defensive: skip any anomaly whose event index somehow didn't resolve
      // to an inserted row, rather than inserting a row with a null FK.
      .filter((row) => Boolean(row.log_event_id));

    let insertedAnomalyRows: AnomalyRow[] = [];
    if (anomalyInsertRows.length > 0) {
      const { data, error } = await serviceClient.from("anomalies").insert(anomalyInsertRows).select("*");
      if (error || !data) {
        throw new Error(`Failed to insert anomalies: ${error?.message ?? "unknown error"}`);
      }
      insertedAnomalyRows = data as AnomalyRow[];
    }

    // --- Finalize log_files row ---
    // §14c: no timeline_summaries insert and no llm_summary_status update
    // here — the column stays at its 'pending' default until the summary
    // SSE endpoint generates (and persists) the summary on demand.
    const { data: updatedFile, error: updateError } = await serviceClient
      .from("log_files")
      .update({
        status: "complete",
        llm_judge_status: judgeResult.status.status,
        llm_judge_status_reason: judgeResult.status.reason ?? null,
      })
      .eq("id", fileId)
      .select("*")
      .single();
    if (updateError || !updatedFile) {
      throw new Error(`Failed to finalize log file record: ${updateError?.message ?? "unknown error"}`);
    }

    // Attach each anomaly's event datetime from the rows already in memory
    // (same data a DB-side `log_events(datetime)` embed would produce for
    // the GET route) so the response's anomalies carry `eventDatetime`.
    const datetimeByEventId = new Map(insertedEventRows.map((row) => [row.id, row.datetime]));

    const firstPageRows = [...insertedEventRows]
      .sort((a, b) => a.datetime.localeCompare(b.datetime))
      .slice(0, UPLOAD_RESPONSE_EVENT_PAGE_SIZE);

    const response: UploadResponse = {
      file: toLogFileMeta(updatedFile as LogFileRow),
      llmJudgeStatus: judgeResult.status,
      // §14c: the summary hasn't been attempted yet — honest pending state,
      // not a fabricated ok/not_configured for a call that never happened.
      llmSummaryStatus: { status: "pending" },
      events: {
        items: firstPageRows.map(toStoredLogEvent),
        pagination: {
          page: 0,
          pageSize: UPLOAD_RESPONSE_EVENT_PAGE_SIZE,
          totalCount: insertedEventRows.length,
        },
      },
      anomalies: insertedAnomalyRows
        .map((row) => {
          const datetime = datetimeByEventId.get(row.log_event_id);
          return toAnomaly(datetime ? { ...row, log_events: { datetime } } : row);
        })
        .sort((a, b) => a.rank - b.rank),
      // Computed above by the existing Phase 4 parser but never plumbed
      // through to the response until now — a Phase 8 gap-fill so the
      // frontend's required "parse-errors notice" (DECISIONS.md §13's
      // malformed-file handling demo) has something to render. Not
      // persisted (no DB column for it), so this is only ever populated on
      // the upload response itself, never on a later GET.
      parseErrors:
        parseResult.errors.length > 0 || parseResult.skippedCount > 0
          ? {
              count: parseResult.errors.length,
              skippedCount: parseResult.skippedCount,
              sampleReasons: parseResult.errors
                .slice(0, PARSE_ERROR_SAMPLE_LIMIT)
                .map((e) => `line ${e.lineNumber}: ${e.reason}`),
            }
          : null,
    };
    res.status(201).json(response);
  } catch (err) {
    if (err instanceof HttpError) {
      // Already marked failed above (parse-error / row-cap paths).
      throw err;
    }
    const message = err instanceof Error ? err.message : "Unknown processing error.";
    await markFileFailed(serviceClient, fileId, message).catch(() => {
      /* best-effort — the original error is what actually surfaces to the caller/logs */
    });
    throw new HttpError(500, "Failed to process uploaded log file.");
  }
}

logsRouter.post(
  "/upload",
  // DECISIONS.md §5/§15: rate-limited before auth even runs — an
  // unauthenticated flood shouldn't get a free pass on JWT verification
  // cost just because it'll 401 anyway.
  uploadRateLimiter,
  requireAuth,
  (req, res, next) => {
    req.setTimeout(UPLOAD_TIMEOUT_MS);
    res.setTimeout(UPLOAD_TIMEOUT_MS);
    uploadMulter.single(UPLOAD_FIELD_NAME)(req, res, (err: unknown) => {
      if (err) {
        next(err);
        return;
      }
      handleUpload(req, res).catch(next);
    });
  },
);

// ---------------------------------------------------------------------------
// GET /api/logs
// ---------------------------------------------------------------------------

logsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const client = getUserScopedClient(req.accessToken!);
    // No `.eq('user_id', ...)` here on purpose — RLS scopes this to the
    // caller's own rows (DECISIONS.md §14a).
    const { data, error } = await client
      .from("log_files")
      .select("*, log_events(count), anomalies(count)")
      .order("uploaded_at", { ascending: false });

    if (error) {
      throw new HttpError(500, `Failed to list log files: ${error.message}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files: LogFileMetaWithStats[] = ((data ?? []) as any[]).map((row) => ({
      ...toLogFileMeta(row as LogFileRow),
      eventCount: row.log_events?.[0]?.count ?? 0,
      anomalyCount: row.anomalies?.[0]?.count ?? 0,
    }));

    res.json({ files });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/logs/:id
// ---------------------------------------------------------------------------

logsRouter.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const { id } = FileIdParamsSchema.parse(req.params);
    const client = getUserScopedClient(req.accessToken!);

    const fileRow = await fetchOwnedFile(client, id);
    if (!fileRow) {
      throw new HttpError(404, "Log file not found.");
    }

    const [events, anomaliesResult, summaryResult] = await Promise.all([
      fetchEventsPage(client, id, 0, UPLOAD_RESPONSE_EVENT_PAGE_SIZE),
      // `log_events(datetime)` embeds the parent event's timestamp so each
      // anomaly maps with `eventDatetime` populated (the results page's
      // anomalies-table timestamp column, DECISIONS.md §14c).
      client.from("anomalies").select("*, log_events(datetime)").eq("log_file_id", id).order("rank", { ascending: true }),
      client.from("timeline_summaries").select("summary").eq("log_file_id", id).maybeSingle(),
    ]);

    if (anomaliesResult.error) {
      throw new HttpError(500, `Failed to fetch anomalies: ${anomaliesResult.error.message}`);
    }
    if (summaryResult.error) {
      throw new HttpError(500, `Failed to fetch summary: ${summaryResult.error.message}`);
    }

    res.json({
      file: toLogFileMeta(fileRow),
      events,
      anomalies: ((anomaliesResult.data ?? []) as AnomalyRow[]).map(toAnomaly),
      summary: summaryResult.data?.summary ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/logs/:id/summary/stream  (SSE — DECISIONS.md §14c)
// ---------------------------------------------------------------------------

logsRouter.get("/:id/summary/stream", summaryStreamRateLimiter, requireAuth, (req, res, next) => {
  handleSummaryStream(req, res).catch(next);
});

// ---------------------------------------------------------------------------
// GET /api/logs/:id/events
// ---------------------------------------------------------------------------

logsRouter.get("/:id/events", requireAuth, async (req, res, next) => {
  try {
    const { id } = FileIdParamsSchema.parse(req.params);
    const { page, pageSize } = EventsQuerySchema.parse(req.query);
    const client = getUserScopedClient(req.accessToken!);

    const fileRow = await fetchOwnedFile(client, id);
    if (!fileRow) {
      throw new HttpError(404, "Log file not found.");
    }

    const paginated = await fetchEventsPage(client, id, page, pageSize);
    res.json(paginated);
  } catch (err) {
    next(err);
  }
});
