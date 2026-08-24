import Anthropic from "@anthropic-ai/sdk";

/**
 * Model IDs (DECISIONS.md §4 as amended by §14c point 1). Verified against
 * the current Anthropic model table, not recalled from training data.
 *
 * - Judge (`judge.ts`): Claude Sonnet 5 — needs actual contextual judgment.
 * - Timeline summary (`summary.ts`): also Claude Sonnet 5 — §14c reversed
 *   §4's original Haiku 4.5 choice because the streaming summary now shows
 *   real model reasoning via adaptive thinking with `display: "summarized"`,
 *   which Haiku 4.5 doesn't reliably expose; the absolute cost delta is
 *   trivial at this app's scale (~4¢/file across the whole pipeline, §4).
 */
export const JUDGE_MODEL = "claude-sonnet-5";
export const SUMMARY_MODEL = "claude-sonnet-5";

/**
 * Whether the LLM layer is configured at all.
 *
 * DECISIONS.md §14a's graceful-degradation gate is specifically "no
 * `ANTHROPIC_API_KEY` set" (see `packages/shared/src/llm-status.ts`'s
 * `not_configured` doc comment and `.env.example`) — narrower than the SDK's
 * full credential-resolution chain (`ANTHROPIC_AUTH_TOKEN`, `ant auth login`
 * profiles, Workload Identity Federation, etc.). `judge.ts`/`summary.ts`
 * short-circuit on this exact env var so the app's documented behavior
 * ("clone the repo, run with no key, still works") matches what's actually
 * checked, rather than silently also picking up a developer's local `ant`
 * CLI session.
 */
export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim().length > 0);
}

let cachedClient: Anthropic | null = null;

/**
 * Lazily constructs a singleton Anthropic client. Resolves the API key from
 * `ANTHROPIC_API_KEY` in the environment — never hardcoded (claude-api skill,
 * Client Initialization guidance). Callers MUST check `isAnthropicConfigured()`
 * first and short-circuit into the `not_configured` status themselves; this
 * throws rather than silently falling back, so a caller that skips the check
 * fails loudly in development instead of masking a missed graceful-degradation
 * path.
 */
export function getAnthropicClient(): Anthropic {
  if (!isAnthropicConfigured()) {
    throw new Error(
      "getAnthropicClient() called without ANTHROPIC_API_KEY configured — callers must check isAnthropicConfigured() first.",
    );
  }
  if (!cachedClient) {
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

/** Test-only hook to reset the cached client between test files/mocks. */
export function _resetAnthropicClientForTests(): void {
  cachedClient = null;
}

/**
 * Turns a caught error from an Anthropic SDK call into a short, honest
 * human-readable reason string for `LlmStatus.reason` (DECISIONS.md §14a).
 * Uses the SDK's typed exception classes (claude-api skill, Error Handling
 * guidance) — never string-matches `error.message` — so the classification
 * is robust to wording changes in the API's own error text.
 */
export function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Anthropic API authentication error — check ANTHROPIC_API_KEY";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "Anthropic API permission denied for this API key/model";
  }
  if (err instanceof Anthropic.NotFoundError) {
    return "Anthropic API returned not found (invalid model ID or endpoint)";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Anthropic API rate limit exceeded";
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return "Anthropic API request timed out";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Anthropic API connection error (network failure)";
  }
  if (err instanceof Anthropic.InternalServerError) {
    return "Anthropic API server error";
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? "unknown";
    return `Anthropic API error (status ${status})`;
  }
  if (err instanceof Anthropic.AnthropicError) {
    return `Anthropic SDK error: ${err.message.slice(0, 200)}`;
  }
  if (err instanceof Error) {
    return err.message.slice(0, 200) || "Unknown error calling the Anthropic API";
  }
  return "Unknown error calling the Anthropic API";
}
