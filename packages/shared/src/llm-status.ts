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
