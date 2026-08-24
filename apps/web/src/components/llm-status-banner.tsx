import type { LlmStatus, SummaryLlmStatus } from "@tenex/shared";
import { Sparkles } from "lucide-react";

/**
 * Renders DECISIONS.md §14a's exact locked copy for a degraded LLM feature.
 * Returns `null` on `status === "ok"` — callers render nothing (not an
 * empty banner) when the feature worked — and on the summary's §14c
 * `"pending"` state (not yet attempted is not a degradation; the streaming
 * Timeline tab owns that state's presentation).
 *
 * Visual treatment intentionally matches `parse-errors-notice.tsx`'s soft
 * amber band (amber-200 border / amber-50 fill / amber-800 text) so the two
 * "degraded but fine" notices on the results page read as one family.
 */
export function LlmStatusBanner({ status }: { status: LlmStatus | SummaryLlmStatus }) {
  if (status.status === "ok" || status.status === "pending") return null;

  const message =
    status.status === "not_configured"
      ? "AI-enhanced analysis is disabled — no API key configured. Showing rule-based detection only."
      : `AI-enhanced analysis failed (${status.reason ?? "unknown reason"}) — showing rule-based detection only.`;

  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
      <p className="text-sm text-amber-800">{message}</p>
    </div>
  );
}
