"use client";

import { useEffect, useState } from "react";
import type { Anomaly, LlmStatus } from "@tenex/shared";
import { ChevronDown, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { LlmStatusBanner } from "@/components/llm-status-banner";
import { cn } from "@/lib/utils";
import { anomalySeverity, formatTimestampUtc } from "@/lib/digest";
import { SEVERITY_BADGE_CLASSES, SEVERITY_DOT_CLASSES, SEVERITY_LABEL, SEVERITY_ORDER, type Severity } from "@/lib/severity";

/**
 * The Anomalies tab (DECISIONS.md §14c): severity sub-tabs (High/Medium/Low,
 * each labeled with its live count) over a real table — aicss `data-table`
 * visual language (rounded-xl shell, hairline dividers, tight padding, 13px
 * text) recolored with this app's existing severity system (red/amber/slate,
 * `lib/severity.ts`) — with click-to-expand rows. Everything the old
 * always-expanded cards showed survives, just progressively disclosed:
 * collapsed = severity pill / rule type / one-line explanation / dual
 * confidence / timestamp; expanded = the full untruncated explanation, every
 * triggered reason, and (when the judge adjusted this anomaly) the LLM's
 * reasoning text alongside the labeled dual-confidence readout (§8: base and
 * LLM-adjusted are never collapsed into one number).
 */

const RULE_TYPE_LABELS: Record<Anomaly["ruleType"], string> = {
  burst_per_ip: "Burst per IP",
  bytes_out_exfil: "Exfil (bytes out)",
  threatname_hit: "Threat match",
  malware_category: "Malware category",
  repeated_blocked: "Repeated blocked",
  off_hours: "Off-hours access",
  rare_scripted_user_agent: "Rare/scripted UA",
  beaconing: "Beaconing (C2 interval)",
};

export function AnomaliesTab({
  anomalies,
  llmJudgeStatus,
  highlightedAnomalyId,
}: {
  anomalies: Anomaly[];
  llmJudgeStatus: LlmStatus;
  highlightedAnomalyId: string | null;
}) {
  const byTier: Record<Severity, Anomaly[]> = { high: [], medium: [], low: [] };
  for (const anomaly of anomalies) {
    byTier[anomalySeverity(anomaly)].push(anomaly);
  }

  const firstNonEmptyTier = SEVERITY_ORDER.find((tier) => byTier[tier].length > 0) ?? "high";
  const [tier, setTier] = useState<Severity>(firstNonEmptyTier);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Cross-tab anomaly linking (an anomalous row clicked on the Events tab):
  // jump to the right severity sub-tab and expand the target row. This is
  // React's render-adjust pattern for reacting to a prop change (not an
  // effect, which would cascade an extra render); the parent owns the
  // highlight's 2.5s lifetime.
  const [lastHighlightId, setLastHighlightId] = useState<string | null>(null);
  if (highlightedAnomalyId !== lastHighlightId) {
    setLastHighlightId(highlightedAnomalyId);
    const target = highlightedAnomalyId ? anomalies.find((a) => a.id === highlightedAnomalyId) : undefined;
    if (target) {
      setTier(anomalySeverity(target));
      setExpandedId(target.id);
    }
  }

  // The DOM side of the link: scroll the row into view once the sub-tab
  // switch above has rendered it.
  useEffect(() => {
    if (!highlightedAnomalyId) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`anomaly-${highlightedAnomalyId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightedAnomalyId]);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-x-2.5 gap-y-2 font-semibold">
          {/* Icon-tile motif shared with the app header logo and upload file card. */}
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
            <ShieldAlert className="size-4 text-muted-foreground" aria-hidden />
          </span>
          Anomalies
          <span className="inline-flex h-5 items-center rounded-full border border-border bg-muted px-2 text-xs font-medium text-muted-foreground tabular-nums">
            {anomalies.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <LlmStatusBanner status={llmJudgeStatus} />
        {anomalies.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ShieldCheck className="size-8 text-muted-foreground/50" strokeWidth={1.5} aria-hidden />
            <p className="text-sm text-muted-foreground">
              No anomalies detected in this file — nothing crossed the rule engine&apos;s thresholds.
            </p>
          </div>
        ) : (
          <Tabs value={tier} onValueChange={(value) => setTier(value as Severity)}>
            <TabsList>
              {SEVERITY_ORDER.map((severity) => (
                <TabsTrigger key={severity} value={severity} className="gap-1.5 px-2.5">
                  <span className={cn("size-1.5 rounded-full", SEVERITY_DOT_CLASSES[severity])} aria-hidden />
                  {SEVERITY_LABEL[severity]}
                  <span className="text-xs text-muted-foreground tabular-nums">{byTier[severity].length}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            {SEVERITY_ORDER.map((severity) => (
              <TabsContent key={severity} value={severity} keepMounted>
                {byTier[severity].length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No {SEVERITY_LABEL[severity].toLowerCase()}-severity anomalies in this file.
                  </p>
                ) : (
                  <AnomaliesTable
                    anomalies={byTier[severity]}
                    expandedId={expandedId}
                    onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
                    highlightedAnomalyId={highlightedAnomalyId}
                  />
                )}
              </TabsContent>
            ))}
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The data-table shell: rounded-xl bordered container, hairline row
 * dividers, tight 13px cells. Rows are buttons that expand in place.
 */
function AnomaliesTable({
  anomalies,
  expandedId,
  onToggle,
  highlightedAnomalyId,
}: {
  anomalies: Anomaly[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  highlightedAnomalyId: string | null;
}) {
  const gridCols = "grid grid-cols-[6.5rem_9rem_minmax(16rem,1fr)_8.5rem_9.5rem_2rem] items-center";

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
      <div className="min-w-[52rem]">
        {/* Header band */}
        <div className={cn(gridCols, "border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground")}>
          <span className="px-3 py-2">Severity</span>
          <span className="px-3 py-2">Rule type</span>
          <span className="px-3 py-2">Explanation</span>
          <span className="px-3 py-2">Confidence</span>
          <span className="px-3 py-2">Timestamp</span>
          <span />
        </div>

        {anomalies.map((anomaly, index) => {
          const severity = anomalySeverity(anomaly);
          const expanded = anomaly.id === expandedId;
          const highlighted = anomaly.id === highlightedAnomalyId;
          const displayExplanation = anomaly.llmExplanation ?? anomaly.explanation;

          return (
            <div
              key={anomaly.id}
              id={`anomaly-${anomaly.id}`}
              className={cn(
                "scroll-mt-24 transition-shadow",
                index < anomalies.length - 1 && "border-b border-border",
                highlighted && "ring-2 ring-blue-600/40 ring-inset",
              )}
            >
              <button
                type="button"
                onClick={() => onToggle(anomaly.id)}
                aria-expanded={expanded}
                className={cn(gridCols, "w-full cursor-pointer text-left text-[13px] transition-colors hover:bg-muted/30")}
              >
                <span className="px-3 py-2">
                  <Badge variant="outline" className={SEVERITY_BADGE_CLASSES[severity]}>
                    <span className={cn("size-1.5 rounded-full", SEVERITY_DOT_CLASSES[severity])} aria-hidden />
                    {SEVERITY_LABEL[severity]}
                  </Badge>
                </span>
                <span className="truncate px-3 py-2 text-foreground">{RULE_TYPE_LABELS[anomaly.ruleType]}</span>
                <span className="truncate px-3 py-2 text-muted-foreground" title={displayExplanation}>
                  {displayExplanation}
                </span>
                <span className="px-3 py-2 whitespace-nowrap tabular-nums">
                  <span className="font-semibold text-foreground">{anomaly.baseConfidence}</span>
                  {anomaly.llmAdjustedConfidence != null && (
                    <span className="text-blue-600"> → {anomaly.llmAdjustedConfidence}</span>
                  )}
                </span>
                <span className="px-3 py-2 font-mono text-xs whitespace-nowrap text-muted-foreground">
                  {anomaly.eventDatetime ? formatTimestampUtc(anomaly.eventDatetime) : "—"}
                </span>
                <span className="flex items-center justify-center py-2 pr-2">
                  <ChevronDown
                    className={cn("size-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")}
                    aria-hidden
                  />
                </span>
              </button>

              {expanded && <ExpandedAnomalyDetails anomaly={anomaly} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Everything the old always-expanded card showed, disclosed on demand: the
 * full explanation, the labeled dual-confidence readout (§8), every
 * triggered reason, and — when the judge adjusted this anomaly — the LLM's
 * reasoning text as its own labeled block.
 */
function ExpandedAnomalyDetails({ anomaly }: { anomaly: Anomaly }) {
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/20 px-4 py-3.5">
      {/* Dual confidence display — deliberate, locked design choice (DECISIONS.md §8): never collapse base + LLM-adjusted into one number. */}
      <div className="flex items-center divide-x divide-border tabular-nums">
        <div className="flex items-baseline gap-1.5 pr-3">
          <span className="text-xs text-muted-foreground">base</span>
          <span className="text-sm font-semibold text-foreground">{anomaly.baseConfidence}</span>
        </div>
        {anomaly.llmAdjustedConfidence != null && (
          <div className="flex items-baseline gap-1.5 pl-3">
            <span className="text-xs text-muted-foreground">LLM-adjusted</span>
            <span className="text-sm font-semibold text-blue-600">{anomaly.llmAdjustedConfidence}</span>
          </div>
        )}
      </div>

      {anomaly.llmExplanation !== null && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">LLM reasoning</span>
          <p className="text-sm leading-relaxed text-foreground">{anomaly.llmExplanation}</p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Rule explanation</span>
        <p className="text-sm leading-relaxed text-foreground">{anomaly.explanation}</p>
      </div>

      {anomaly.triggeredReasons.length > 1 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">All triggered reasons</span>
          <ul className="flex flex-col gap-0.5 border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
            {anomaly.triggeredReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
