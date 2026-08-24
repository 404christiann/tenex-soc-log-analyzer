import type { GetFileDetailResponse, LogFileMeta, PaginatedEventsResponse, SummaryStreamEvent, UploadResponse } from "@tenex/shared";
import { SummaryStreamEventSchema } from "@tenex/shared";
import { createClient } from "@/lib/supabase/client";

/**
 * Typed fetch wrapper for `apps/api`'s Express routes (`apps/api/src/routes/logs.ts`).
 * Every request attaches the caller's current Supabase access token as
 * `Authorization: Bearer <token>` — the API's `requireAuth` middleware
 * verifies it and RLS scopes every read to that user (DECISIONS.md §14a).
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Multipart field name the API's `uploadMulter.single(...)` expects (`apps/api/src/middleware/upload-validate.ts`). */
const UPLOAD_FIELD_NAME = "file";

export class ApiError extends Error {
  readonly status: number;
  /** Populated on 400s from Zod validation errors (`{ error, details }`), when present. */
  readonly details?: string[];

  constructor(status: number, message: string, details?: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function parseErrorBody(res: Response): Promise<{ message: string; details?: string[] }> {
  try {
    const body = (await res.json()) as { error?: string; details?: string[] };
    if (body?.error) {
      return { message: body.error, details: body.details };
    }
  } catch {
    // Response wasn't JSON — fall through to the status-text fallback below.
  }
  return { message: res.statusText || `Request failed with status ${res.status}` };
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });

  if (!res.ok) {
    const { message, details } = await parseErrorBody(res);
    throw new ApiError(res.status, message, details);
  }

  return (await res.json()) as T;
}

/**
 * `POST /api/logs/upload` — DECISIONS.md §9/§10: one synchronous call, ~20-25s worst case.
 * `signal` lets the caller's Cancel control genuinely abort the in-flight request.
 */
export async function uploadLogFile(file: File, signal?: AbortSignal): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append(UPLOAD_FIELD_NAME, file);
  return apiRequest<UploadResponse>("/api/logs/upload", { method: "POST", body: formData, signal });
}

/**
 * `GET /api/logs`'s per-file rows carry two extra convenience fields
 * (`eventCount`/`anomalyCount`) beyond `packages/shared`'s `LogFileMeta` —
 * `apps/api/src/routes/logs.ts`'s `LogFileMetaWithStats` documents this as a
 * deliberate additive superset kept local rather than widening the shared
 * schema; mirrored here for the same reason.
 */
export interface LogFileMetaWithStats extends LogFileMeta {
  eventCount: number;
  anomalyCount: number;
}

/** `GET /api/logs` — the caller's own uploaded files (RLS-scoped). */
export async function listLogFiles(): Promise<{ files: LogFileMetaWithStats[] }> {
  return apiRequest<{ files: LogFileMetaWithStats[] }>("/api/logs");
}

/** `GET /api/logs/:id` — full detail for one file, including its first page of events. */
export async function getLogFile(id: string): Promise<GetFileDetailResponse> {
  return apiRequest<GetFileDetailResponse>(`/api/logs/${encodeURIComponent(id)}`);
}

/**
 * `GET /api/logs/:id/summary/stream` — the on-demand streaming timeline
 * summary (DECISIONS.md §14c). SSE over plain `fetch`, NOT `EventSource`:
 * the endpoint requires the same `Authorization: Bearer <token>` header as
 * every other route here, and native `EventSource` cannot send headers — so
 * this reads `response.body` directly and parses the standard
 * `event: <name>\ndata: <json>\n\n` framing itself.
 *
 * Every parsed frame is validated against the shared Zod contract
 * (`SummaryStreamEventSchema` in `packages/shared/src/llm-status.ts`) and
 * handed to `onEvent` in arrival order. Resolves once the server closes the
 * stream (which the contract guarantees happens right after the single
 * terminal `done` event). Rejects on connection/HTTP/contract errors —
 * callers own turning that into their honest failed-state UI.
 */
export async function streamLogFileSummary(
  id: string,
  onEvent: (event: SummaryStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = await getAccessToken();
  const headers = new Headers({ Accept: "text/event-stream" });
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE_URL}/api/logs/${encodeURIComponent(id)}/summary/stream`, {
    headers,
    signal,
  });
  if (!res.ok) {
    const { message, details } = await parseErrorBody(res);
    throw new ApiError(res.status, message, details);
  }
  if (!res.body) {
    throw new ApiError(res.status, "Summary stream response had no body.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchFrame = (frame: string) => {
    // An SSE frame is newline-separated fields; this endpoint always sends
    // one `event:` line and one `data:` line per frame. The JSON payload's
    // `type` field always matches the event name (see the schema's doc
    // comment), so the data line alone is sufficient to dispatch.
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) return;
    onEvent(SummaryStreamEventSchema.parse(JSON.parse(dataLines.join("\n"))));
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line; keep the trailing partial frame
    // in the buffer until its terminator arrives.
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      dispatchFrame(frame);
    }
  }
  if (buffer.trim().length > 0) {
    dispatchFrame(buffer);
  }
}

/** `GET /api/logs/:id/events?page=&pageSize=` — paginated event listing beyond the first page. */
export async function getLogFileEvents(id: string, page: number, pageSize = 100): Promise<PaginatedEventsResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return apiRequest<PaginatedEventsResponse>(`/api/logs/${encodeURIComponent(id)}/events?${params.toString()}`);
}
