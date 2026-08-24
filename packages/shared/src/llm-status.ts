import { z } from "zod";

/**
 * Three-state LLM feature status per DECISIONS.md §14a ("LLM graceful
 * degradation"). Judge and summary are tracked independently since one can
 * fail while the other works.
 *
 * - `not_configured` — no `ANTHROPIC_API_KEY` set.
 * - `failed` — key present, call errored (auth failure, rate limit, timeout,
 *   refusal, etc.) — `reason` should carry the actual cause, not a generic message.
 * - `ok` — the call succeeded.
 */
export const LlmStatusStateSchema = z.enum(["not_configured", "failed", "ok"]);
export type LlmStatusState = z.infer<typeof LlmStatusStateSchema>;

export const LlmStatusSchema = z.object({
  status: LlmStatusStateSchema,
  /** Present on `failed` to explain what went wrong; omitted for `ok`/`not_configured`. */
  reason: z.string().optional(),
});
export type LlmStatus = z.infer<typeof LlmStatusSchema>;

// ---------------------------------------------------------------------------
// Summary status — four states (DECISIONS.md §14c)
// ---------------------------------------------------------------------------

/**
 * §14c decouples summary generation from the upload request, which
 * introduces a fourth state the judge never has: `pending` — generation
 * hasn't been *attempted* yet (upload finished, nobody has opened the
 * Timeline tab / hit the SSE endpoint). The three §14a states all describe
 * the outcome of an attempt; `pending` describes its absence.
 *
 * The judge keeps the three-state `LlmStatusSchema` above — it still runs
 * synchronously inside the upload request (§14c point 2).
 */
export const SummaryLlmStatusStateSchema = z.enum(["pending", "not_configured", "failed", "ok"]);
export type SummaryLlmStatusState = z.infer<typeof SummaryLlmStatusStateSchema>;

export const SummaryLlmStatusSchema = z.object({
  status: SummaryLlmStatusStateSchema,
  /** Present on `failed` to explain what went wrong; omitted otherwise. */
  reason: z.string().optional(),
});
export type SummaryLlmStatus = z.infer<typeof SummaryLlmStatusSchema>;

// ---------------------------------------------------------------------------
// Summary SSE stream events (DECISIONS.md §14c)
// ---------------------------------------------------------------------------

/**
 * Wire contract for `GET /api/logs/:id/summary/stream` (SSE). Each SSE frame
 * is sent as `event: <type>` + `data: <JSON>` where the JSON parses against
 * exactly one member of this union (the `type` field always matches the SSE
 * event name, so consumers can dispatch on either).
 *
 * Event ordering guarantees:
 * - Every stream ends with exactly one `done` event, then closes. The client
 *   always ends up with *something* to render (`done.summary` is never empty).
 * - Cached replay (summary already persisted): `done` is the ONLY event.
 * - No key configured: `not_configured` then `done` — no fake `thinking`
 *   events ever appear for a call that never happened (§14c point 4).
 * - Live generation: zero or more `thinking` deltas, then zero or more
 *   `text` deltas, then `done`.
 * - Mid-stream failure: (any deltas already sent), `failed`, then `done`
 *   carrying the deterministic fallback summary.
 */
export const SummaryStreamEventSchema = z.discriminatedUnion("type", [
  /** A chunk of the model's summarized reasoning (adaptive thinking) — append to the "thinking" transcript. */
  z.object({ type: z.literal("thinking"), delta: z.string() }),
  /** A chunk of the final summary markdown — append to the summary body. */
  z.object({ type: z.literal("text"), delta: z.string() }),
  /**
   * No `ANTHROPIC_API_KEY` configured — no LLM call was made. Frontend shows
   * the locked §14a banner copy: "AI-enhanced analysis is disabled — no API
   * key configured. Showing rule-based detection only." A `done` event with
   * the deterministic fallback summary follows.
   */
  z.object({ type: z.literal("not_configured") }),
  /** The LLM call errored mid-generation; `reason` is the honest cause (§14a). A `done` event with the deterministic fallback summary follows. */
  z.object({ type: z.literal("failed"), reason: z.string() }),
  /**
   * Terminal event — always sent, exactly once, immediately before the
   * stream closes. `summary` is the complete final markdown (LLM output on
   * `ok`, deterministic fallback otherwise). `cached: true` means this is a
   * replay of a previously persisted summary (no LLM call happened on this
   * connection).
   */
  z.object({
    type: z.literal("done"),
    summary: z.string(),
    status: z.enum(["ok", "failed", "not_configured"]),
    reason: z.string().optional(),
    cached: z.boolean(),
  }),
]);
export type SummaryStreamEvent = z.infer<typeof SummaryStreamEventSchema>;
