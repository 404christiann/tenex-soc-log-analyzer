import type { Anomaly, LlmStatus, LogFileMeta, LogFileStatus, StoredLogEvent, SummaryLlmStatus } from "@tenex/shared";

/**
 * Row -> API shape mappers for the four tables in `supabase/migrations/0001_init.sql`.
 * Column names are snake_case (Postgres convention); the shared Zod schemas
 * (`packages/shared`) are camelCase — these functions are the single place
 * that translation happens, kept separate from route orchestration.
 */

export interface LogFileRow {
  id: string;
  filename: string;
  uploaded_at: string;
  status: LogFileStatus;
  error_message: string | null;
  llm_judge_status: LlmStatus["status"];
  llm_judge_status_reason: string | null;
  /** Four-state (§14c): 'pending' until the summary SSE endpoint has run for this file. */
  llm_summary_status: SummaryLlmStatus["status"];
  llm_summary_status_reason: string | null;
}

function toLlmStatus(status: LlmStatus["status"], reason: string | null): LlmStatus {
  return reason ? { status, reason } : { status };
}

function toSummaryLlmStatus(status: SummaryLlmStatus["status"], reason: string | null): SummaryLlmStatus {
  return reason ? { status, reason } : { status };
}

export function toLogFileMeta(row: LogFileRow): LogFileMeta {
  return {
    id: row.id,
    filename: row.filename,
    uploadedAt: row.uploaded_at,
    status: row.status,
    errorMessage: row.error_message,
    llmJudgeStatus: toLlmStatus(row.llm_judge_status, row.llm_judge_status_reason),
    llmSummaryStatus: toSummaryLlmStatus(row.llm_summary_status, row.llm_summary_status_reason),
  };
}

export interface LogEventRow {
  id: string;
  log_file_id: string;
  datetime: string;
  cip: string;
  log_user: string;
  url: string;
  action: "allowed" | "blocked";
  urlcat: string;
  threatname: string | null;
  respcode: number;
  bytes_out: number;
  bytes_in: number;
  useragent: string;
  reqmethod: string;
}

export function toStoredLogEvent(row: LogEventRow): StoredLogEvent {
  return {
    id: row.id,
    logFileId: row.log_file_id,
    datetime: row.datetime,
    cip: row.cip,
    login: row.log_user,
    url: row.url,
    action: row.action,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    urlcat: row.urlcat as any,
    threatname: row.threatname,
    respcode: row.respcode,
    bytes_out: row.bytes_out,
    bytes_in: row.bytes_in,
    useragent: row.useragent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reqmethod: row.reqmethod as any,
  };
}

export interface AnomalyRow {
  id: string;
  log_event_id: string;
  rule_type: string;
  triggered_reasons: string[];
  base_confidence: number | string;
  llm_adjusted_confidence: number | string | null;
  explanation: string;
  llm_explanation: string | null;
  rank: number;
  /**
   * Present when the query embedded the parent event via PostgREST's
   * relational select (`select("*, log_events(datetime)")`) — or when a
   * caller that already holds the event rows in memory attaches it before
   * mapping (the upload route does this). Optional because a plain
   * `select("*")` on `anomalies` doesn't produce it.
   */
  log_events?: { datetime: string } | null;
}

export function toAnomaly(row: AnomalyRow): Anomaly {
  return {
    id: row.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ruleType: row.rule_type as any,
    triggeredReasons: row.triggered_reasons,
    // Postgres `numeric` columns come back over PostgREST as strings to
    // avoid float precision loss — coerce explicitly.
    baseConfidence: Number(row.base_confidence),
    llmAdjustedConfidence: row.llm_adjusted_confidence === null ? null : Number(row.llm_adjusted_confidence),
    explanation: row.explanation,
    llmExplanation: row.llm_explanation,
    rank: row.rank,
    eventRef: row.log_event_id,
    eventDatetime: row.log_events?.datetime ?? null,
  };
}
