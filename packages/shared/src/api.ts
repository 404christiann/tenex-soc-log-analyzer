import { z } from "zod";
import { LogEventSchema } from "./log-event";
import { AnomalySchema } from "./anomaly";
import { LlmStatusSchema } from "./llm-status";

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
  llmSummaryStatus: LlmStatusSchema,
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
 * `POST /api/logs/upload` response. One synchronous call returns everything
 * (DECISIONS.md §10): file metadata, per-feature LLM status, the first page
 * of parsed events, all anomalies, and the timeline summary (or its
 * deterministic fallback text on LLM failure).
 */
export const UploadResponseSchema = z.object({
  file: LogFileMetaSchema,
  llmJudgeStatus: LlmStatusSchema,
  llmSummaryStatus: LlmStatusSchema,
  events: PaginatedEventsSchema,
  anomalies: z.array(AnomalySchema),
  /** LLM-generated narrative, or the deterministic templated fallback on `llmSummaryStatus !== "ok"`. */
  summary: z.string(),
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
  /** `null` if a summary was never generated for this file (e.g. still processing). */
  summary: z.string().nullable(),
});
export type GetFileDetailResponse = z.infer<typeof GetFileDetailResponseSchema>;

/** `GET /api/logs/:id/events?page=&pageSize=` response — paginated event listing beyond the first page. */
export const PaginatedEventsResponseSchema = PaginatedEventsSchema;
export type PaginatedEventsResponse = PaginatedEvents;
