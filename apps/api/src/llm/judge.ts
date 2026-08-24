import type Anthropic from "@anthropic-ai/sdk";
import type { Anomaly, LlmStatus, LogEvent } from "@tenex/shared";
import { describeAnthropicError, getAnthropicClient, isAnthropicConfigured, JUDGE_MODEL } from "./client";
import {
  buildJudgeToolInputSchema,
  buildJudgeUserPrompt,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_TOOL_NAME,
  JudgeToolResponseSchema,
  type JudgeCandidate,
} from "./prompts";

/**
 * LLM judge (Layer 2 — DECISIONS.md §3, §14a). Refines only what the
 * deterministic rule engine (`apps/api/src/rules/engine.ts`) already
 * flagged; never invents or removes anomalies.
 */

/** Top-N candidates by `baseConfidence` sent to the judge in one batched call — anything beyond this keeps Layer 1's explanation untouched (DECISIONS.md §3). */
export const JUDGE_CANDIDATE_LIMIT = 20;

/** Server-side clamp applied to the model's `confidenceDelta` regardless of what it returns (DECISIONS.md §3). */
export const JUDGE_CONFIDENCE_DELTA_MIN = -15;
export const JUDGE_CONFIDENCE_DELTA_MAX = 15;

export function clampConfidenceDelta(delta: number): number {
  return Math.min(JUDGE_CONFIDENCE_DELTA_MAX, Math.max(JUDGE_CONFIDENCE_DELTA_MIN, delta));
}

export function clampConfidence(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export interface JudgeResult {
  /** Same length/order as the input `anomalies`; only the top-N candidates (by baseConfidence) may have `llmAdjustedConfidence`/`llmExplanation` populated. */
  anomalies: Anomaly[];
  status: LlmStatus;
  /** How many anomalies were actually sent to the LLM (<= JUDGE_CANDIDATE_LIMIT, and never more than `anomalies.length`) — reported explicitly per DECISIONS.md §3 ("this cap must be explicit and reported, never silent"). */
  candidateCount: number;
}

/** One malformed-response retry, per the phase brief ("even after retry" before giving up). Not for auth/network errors — those fail the same way on a second try, so don't burn a second call on them. */
const MAX_MALFORMED_RESPONSE_ATTEMPTS = 2;

async function callJudge(
  candidates: JudgeCandidate[],
): Promise<Map<number, { explanation: string; confidenceDelta: number }>> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 4096,
    system: JUDGE_SYSTEM_PROMPT,
    tools: [
      {
        name: JUDGE_TOOL_NAME,
        description:
          "Record one refined judgment per candidate anomaly index: a reworded/contextualized explanation and a bounded confidence delta.",
        input_schema: buildJudgeToolInputSchema(),
        strict: true,
      },
    ],
    tool_choice: { type: "tool", name: JUDGE_TOOL_NAME },
    messages: [{ role: "user", content: buildJudgeUserPrompt(candidates) }],
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Judge response contained no tool_use block");
  }

  const parsed = JudgeToolResponseSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(`Judge response failed schema validation: ${parsed.error.message}`);
  }

  const byIndex = new Map<number, { explanation: string; confidenceDelta: number }>();
  for (const result of parsed.data.results) {
    byIndex.set(result.index, { explanation: result.explanation, confidenceDelta: result.confidenceDelta });
  }
  return byIndex;
}

function isMalformedResponseError(err: unknown): boolean {
  return err instanceof Error && (err.message.startsWith("Judge response contained no tool_use") ||
    err.message.startsWith("Judge response failed schema validation"));
}

/**
 * Runs the LLM judge over `anomalies`, sorted by `baseConfidence` descending
 * and capped to the top `JUDGE_CANDIDATE_LIMIT` (DECISIONS.md §3). `events`
 * supplies the single flagged row's own fields for each candidate — never
 * neighboring rows (see `JudgeCandidate` in prompts.ts).
 *
 * Graceful degradation (DECISIONS.md §14a): if `ANTHROPIC_API_KEY` is unset,
 * returns `not_configured` immediately with no network call. If the key is
 * present but the call errors (or the response never validates, even after
 * one retry), returns `failed` with a short reason and the original
 * deterministic anomalies untouched. Never throws.
 */
export async function judge(anomalies: Anomaly[], events: LogEvent[]): Promise<JudgeResult> {
  if (!isAnthropicConfigured()) {
    return { anomalies, status: { status: "not_configured" }, candidateCount: 0 };
  }

  const sorted = [...anomalies].sort((a, b) => b.baseConfidence - a.baseConfidence);
  const topAnomalies = sorted.slice(0, JUDGE_CANDIDATE_LIMIT);

  if (topAnomalies.length === 0) {
    // Nothing to judge — not a failure, just nothing to do.
    return { anomalies, status: { status: "ok" }, candidateCount: 0 };
  }

  const candidates: JudgeCandidate[] = topAnomalies.map((anomaly) => ({
    anomaly,
    event: events[Number(anomaly.eventRef)],
  }));

  let byIndex: Map<number, { explanation: string; confidenceDelta: number }> | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_MALFORMED_RESPONSE_ATTEMPTS; attempt++) {
    try {
      byIndex = await callJudge(candidates);
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      // Only worth retrying a malformed/missing tool-call response — an
      // auth/network/rate-limit error will fail the same way again.
      if (!isMalformedResponseError(err)) break;
    }
  }

  if (lastError !== undefined || !byIndex) {
    return {
      anomalies,
      status: { status: "failed", reason: describeAnthropicError(lastError) },
      candidateCount: candidates.length,
    };
  }

  const resolvedByIndex = byIndex;
  const updated: Anomaly[] = anomalies.map((anomaly) => {
    const candidateIndex = topAnomalies.indexOf(anomaly);
    if (candidateIndex === -1) return anomaly; // not among the top-N candidates — Layer 1 explanation stands.

    const result = resolvedByIndex.get(candidateIndex);
    if (!result) return anomaly; // model omitted this index — keep the deterministic fallback rather than guessing.

    const clampedDelta = clampConfidenceDelta(result.confidenceDelta);
    return {
      ...anomaly,
      llmAdjustedConfidence: clampConfidence(anomaly.baseConfidence + clampedDelta),
      llmExplanation: result.explanation,
    };
  });

  return { anomalies: updated, status: { status: "ok" }, candidateCount: candidates.length };
}
