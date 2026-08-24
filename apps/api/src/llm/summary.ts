import type Anthropic from "@anthropic-ai/sdk";
import type { Anomaly, LlmStatus, LogEvent } from "@tenex/shared";
import { describeAnthropicError, getAnthropicClient, isAnthropicConfigured, SUMMARY_MODEL } from "./client";
import { buildSummaryUserPrompt, SUMMARY_SYSTEM_PROMPT } from "./prompts";

/**
 * LLM timeline summary generator (DECISIONS.md §3, §14a, §14c). Takes the
 * full parsed `LogEvent[]` plus the (judge-refined) `Anomaly[]` and produces
 * a short markdown narrative for a SOC analyst skimming the file.
 *
 * §14c: generation is now STREAMING — Claude Sonnet 5 with adaptive
 * thinking (`display: "summarized"`), so the caller (the SSE route in
 * `routes/summary-stream.ts`) can forward genuine model reasoning and text
 * deltas to the client as they arrive. This module stays transport-agnostic:
 * it reports deltas through plain callbacks and resolves to the same
 * `SummaryResult` shape the old synchronous `summarize()` returned, so the
 * §14a graceful-degradation contract (never throws, always returns *some*
 * summary text) is unchanged.
 */

/** Same N-cap philosophy as the judge (DECISIONS.md §3) — bounds the prompt on a multi-thousand-row file while still grounding the narrative in the highest-signal real anomalies. */
export const SUMMARY_ANOMALY_CONTEXT_LIMIT = 20;

/**
 * Output ceiling for the summary call. The narrative itself is 3-6 bullet
 * points (~a few hundred tokens), but with adaptive thinking enabled the
 * thinking tokens count against `max_tokens` too — so this is sized for
 * reasoning + answer, not just the answer.
 */
export const SUMMARY_MAX_TOKENS = 8192;

export interface SummaryResult {
  markdown: string;
  status: LlmStatus;
}

/** Delta callbacks invoked as the model streams (DECISIONS.md §14c). Both are optional so non-streaming callers/tests can ignore them. */
export interface SummaryStreamHandlers {
  /** A chunk of the model's summarized adaptive-thinking reasoning. */
  onThinkingDelta?: (delta: string) => void;
  /** A chunk of the final summary markdown. */
  onTextDelta?: (delta: string) => void;
}

function formatHHMM(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/**
 * Deterministic templated fallback (DECISIONS.md §14a) — used whenever the
 * LLM summary isn't available (`not_configured` or `failed`). A real,
 * tested function, not an afterthought: exact shape is
 * "`{n} events analyzed, {m} anomalies flagged across {k} rule types, time
 * range {first}–{last}.`", matching the example in DECISIONS.md §14a.
 */
export function generateFallbackSummary(events: LogEvent[], anomalies: Anomaly[]): string {
  if (events.length === 0) {
    return "0 events analyzed, 0 anomalies flagged across 0 rule types, time range n/a.";
  }

  const ruleTypeCount = new Set(anomalies.map((a) => a.ruleType)).size;
  const times = events
    .map((e) => new Date(e.datetime).getTime())
    .filter((t) => !Number.isNaN(t));

  const timeRange =
    times.length === 0 ? "n/a" : `${formatHHMM(Math.min(...times))}–${formatHHMM(Math.max(...times))}`;

  return `${events.length} events analyzed, ${anomalies.length} anomalies flagged across ${ruleTypeCount} rule types, time range ${timeRange}.`;
}

/**
 * Generates the LLM timeline summary, streaming thinking/text deltas to
 * `handlers` as they arrive. Falls back to `generateFallbackSummary`
 * whenever the LLM isn't available or fails — never throws, never leaves
 * the caller without *some* summary text (DECISIONS.md §14a: "the app must
 * never 500 or hang because the LLM call failed").
 *
 * Streaming shape per the claude-api skill's TypeScript streaming guidance:
 * `client.messages.stream(...)`, iterating `content_block_delta` events and
 * branching on `thinking_delta` vs `text_delta`, then `stream.finalMessage()`
 * for the complete validated message.
 */
export async function streamSummary(
  events: LogEvent[],
  anomalies: Anomaly[],
  handlers: SummaryStreamHandlers = {},
): Promise<SummaryResult> {
  const fallback = generateFallbackSummary(events, anomalies);

  if (!isAnthropicConfigured()) {
    return { markdown: fallback, status: { status: "not_configured" } };
  }

  if (events.length === 0) {
    // Nothing to summarize — not a failure, just nothing to do; the
    // fallback text is already the honest answer here too.
    return { markdown: fallback, status: { status: "ok" } };
  }

  try {
    const client = getAnthropicClient();
    const stream = client.messages.stream({
      model: SUMMARY_MODEL,
      max_tokens: SUMMARY_MAX_TOKENS,
      // §14c: adaptive thinking with visible summarized reasoning — the
      // entire point of the model switch to Sonnet 5. `display` must be
      // explicit: the default on Sonnet 5 is "omitted" (empty thinking
      // text), which would stream a fake-looking long pause instead of the
      // real reasoning the UI is built around.
      thinking: { type: "adaptive", display: "summarized" },
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildSummaryUserPrompt(events, anomalies, SUMMARY_ANOMALY_CONTEXT_LIMIT) },
      ],
    });

    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "thinking_delta" && event.delta.thinking.length > 0) {
        handlers.onThinkingDelta?.(event.delta.thinking);
      } else if (event.delta.type === "text_delta" && event.delta.text.length > 0) {
        handlers.onTextDelta?.(event.delta.text);
      }
    }

    const finalMessage = await stream.finalMessage();
    const text = finalMessage.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (text.length === 0) {
      // Covers refusals/empty responses — same honest-failure handling as
      // any other error: the caller emits `failed` + the fallback.
      throw new Error("Summary response contained no text");
    }

    return { markdown: text, status: { status: "ok" } };
  } catch (err) {
    return { markdown: fallback, status: { status: "failed", reason: describeAnthropicError(err) } };
  }
}
