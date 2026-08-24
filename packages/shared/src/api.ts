import { z } from "zod";
import { LogEventSchema } from "./log-event";
import { AnomalySchema } from "./anomaly";
import { LlmStatusSchema, SummaryLlmStatusSchema } from "./llm-status";

/** `log_files.status` per DECISIONS.md §8 / the SQL schema — an honest failure state, not just a boolean. */
export const LogFileStatusSchema = z.enum(["processing", "complete", "failed"]);
export type LogFileStatus = z.infer<typeof LogFileStatusSchema>;

export const LogFileMetaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  /** ISO 8601 timestamp. */
  uploadedAt: z.string(),
  status: LogFileStatusSchema,
  /** Populated when `status === "failed"`; honest reason, never a silent failure. */
  errorMessage: z.string().nullable(),
  llmJudgeStatus: LlmStatusSchema,
  /** Four-state (§14c): `pending` until the summary SSE endpoint has generated (or failed to generate) a summary for this file. */
  llmSummaryStatus: SummaryLlmStatusSchema,
});
export type LogFileMeta = z.infer<typeof LogFileMetaSchema>;

/** A parsed `LogEvent` as returned by the API: the 12 raw fields plus row/file identity. */
export const StoredLogEventSchema = LogEventSchema.extend({
  id: z.string(),
  logFileId: z.string(),
});
export type StoredLogEvent = z.infer<typeof StoredLogEventSchema>;

export const PaginationSchema = z.object({
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  totalCount: z.number().int().nonnegative(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const PaginatedEventsSchema = z.object({
  items: z.array(StoredLogEventSchema),
  pagination: PaginationSchema,
});
export type PaginatedEvents = z.infer<typeof PaginatedEventsSchema>;

/**
 * Non-fatal parse-time issues (DECISIONS.md §14a malformed-input handling /
 * §13's `malformed-edge-cases.log`) — present on `POST /api/logs/upload`'s
 * response only (computed in-memory during that request, not persisted), so
 * this surfaces once, at upload time. `sampleReasons` is capped by the
 * server, never the full per-line list.
 */
export const ParseErrorsSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  sampleReasons: z.array(z.string()),
});
export type ParseErrorsSummary = z.infer<typeof ParseErrorsSummarySchema>;

/**
 * `POST /api/logs/upload` response. One synchronous call runs parse ->
 * rules -> judge -> persist (DECISIONS.md §10 as amended by §14c): file
 * metadata, judge status, the first page of parsed events, and all
 * anomalies. The timeline summary is NOT generated at upload time anymore
 * (§14c point 3) — `llmSummaryStatus` is always `{ status: "pending" }`
 * here, and the summary itself arrives later via the on-demand SSE endpoint
 * `GET /api/logs/:id/summary/stream` (see `SummaryStreamEventSchema`).
 */
export const UploadResponseSchema = z.object({
  file: LogFileMetaSchema,
  llmJudgeStatus: LlmStatusSchema,
  /** Always `{ status: "pending" }` — the summary hasn't been attempted yet at upload time (§14c). */
  llmSummaryStatus: SummaryLlmStatusSchema,
  events: PaginatedEventsSchema,
  anomalies: z.array(AnomalySchema),
  /** `null` when the file had zero parse errors AND zero skipped blank lines. */
  parseErrors: ParseErrorsSummarySchema.nullable(),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

/** `GET /api/logs` response — the caller's uploaded files (RLS-scoped, so implicitly "mine"). */
export const ListFilesResponseSchema = z.object({
  files: z.array(LogFileMetaSchema),
});
export type ListFilesResponse = z.infer<typeof ListFilesResponseSchema>;

/** `GET /api/logs/:id` response — full detail for one file, including its first page of events. */
export const GetFileDetailResponseSchema = z.object({
  file: LogFileMetaSchema,
  events: PaginatedEventsSchema,
  anomalies: z.array(AnomalySchema),
  /** `null` if a summary hasn't been generated for this file yet (§14c: `llmSummaryStatus` is `pending` until the SSE endpoint runs). */
  summary: z.string().nullable(),
});
export type GetFileDetailResponse = z.infer<typeof GetFileDetailResponseSchema>;

/** `GET /api/logs/:id/events?page=&pageSize=` response — paginated event listing beyond the first page. */
export const PaginatedEventsResponseSchema = PaginatedEventsSchema;
export type PaginatedEventsResponse = PaginatedEvents;
