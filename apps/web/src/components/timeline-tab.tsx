"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import type { Anomaly, SummaryLlmStatus, SummaryStreamEvent } from "@tenex/shared";
import { AlertTriangle, ArrowRight, ScrollText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LlmStatusBanner } from "@/components/llm-status-banner";
import { ThinkingReasoning } from "@/components/thinking-reasoning";
import { streamLogFileSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  buildComputedDigest,
  countBySeverity,
  formatWindowLabel,
  getAnomalyWindow,
  splitTldr,
} from "@/lib/digest";
import {
  SEVERITY_BADGE_CLASSES,
  SEVERITY_DOT_CLASSES,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  type Severity,
} from "@/lib/severity";

/**
 * The Timeline tab (DECISIONS.md §14c): real streaming summary generation.
 * Opening this tab for a file with no persisted summary opens the SSE
 * stream (`GET /api/logs/:id/summary/stream`) and drives the reveal off the
 * REAL events:
 *
 * - `thinking` deltas → shimmer "Thinking…" + line-by-line reasoning reveal
 *   (`ThinkingReasoning`).
 * - first `text` delta → the reasoning folds into "Thought for Ns" (N is
 *   measured wall-clock time, not a constant) and the summary markdown
 *   streams in below.
 * - `not_configured` → the locked §14a banner immediately; no thinking
 *   animation ever plays for a call that never happened.
 * - `failed` → reasoning-so-far stays (folded), the locked failed-banner
 *   copy with the real reason, then the deterministic fallback summary.
 * - cached `done` (replay, nothing streamed on this connection) → the final
 *   summary renders directly; there is nothing honest to animate.
 *
 * When the page's GET response already carried a persisted summary, no
 * stream is opened at all — that's the same cached case, one hop earlier.
 */

type Phase = "idle" | "connecting" | "thinking" | "answering" | "done";

interface StreamState {
  phase: Phase;
  thinkingText: string;
  summaryText: string;
  /** Real elapsed thinking wall-clock ms; set when the thinking phase ends. */
  thinkingDurationMs: number | null;
  /** Terminal outcome once known (from `failed`/`not_configured`/`done`). */
  finalStatus: SummaryLlmStatus | null;
  /** Transport-level failure (connection dropped, HTTP error) — outside the SSE contract's own failure states. */
  connectionError: string | null;
}

const INITIAL_STREAM_STATE: StreamState = {
  phase: "idle",
  thinkingText: "",
  summaryText: "",
  thinkingDurationMs: null,
  finalStatus: null,
  connectionError: null,
};

export function TimelineTab({
  fileId,
  initialSummary,
  initialStatus,
  active,
  anomalies,
  eventsTotal,
  onSelectAnomaly,
}: {
  fileId: string;
  /** Persisted summary from `GET /api/logs/:id`, when one already exists — renders directly, no stream. */
  initialSummary: string | null;
  /** The file's recorded summary status — meaningful alongside `initialSummary`. */
  initialStatus: SummaryLlmStatus;
  /** Whether the Timeline tab is currently the visible tab — the stream only starts once it is. */
  active: boolean;
  /** Total parsed events in the file (`events.pagination.totalCount`) — real data the page already has, feeding the stat strip with zero LLM involvement. */
  eventsTotal: number;
  /**
   * The page's loaded anomalies — the ground truth for `event:<id>` citation
   * links in the summary markdown (DECISIONS.md §14d): a citation whose id
   * isn't in this list is silently de-linked to plain text, never rendered
   * as a dead or misleading link.
   */
  anomalies: Anomaly[];
  /** Same tab-switch + scroll + highlight jump the Events tab uses for its anomalous rows — reused verbatim for summary citations. */
  onSelectAnomaly: (anomalyId: string) => void;
}) {
  const [state, setState] = useState<StreamState>(INITIAL_STREAM_STATE);
  const anomalyIds = useMemo(() => new Set(anomalies.map((a) => a.id)), [anomalies]);
  const [attempt, setAttempt] = useState(0);
  const startedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const thinkingStartedAtRef = useRef<number | null>(null);
  const sawThinkingEndRef = useRef(false);

  const hasInitialSummary = initialSummary !== null;

  // Abort any live stream only when the whole component unmounts (leaving
  // the results page). Tab switches deliberately do NOT abort: the panels
  // are kept mounted and an in-flight generation keeps streaming in the
  // background, exactly like a real chat client.
  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (hasInitialSummary || !active || startedRef.current) return;

    const controller = new AbortController();

    const endThinkingPhase = () => {
      if (sawThinkingEndRef.current || thinkingStartedAtRef.current === null) return;
      sawThinkingEndRef.current = true;
      const elapsed = Date.now() - thinkingStartedAtRef.current;
      setState((s) => ({ ...s, thinkingDurationMs: elapsed }));
    };

    const handleEvent = (event: SummaryStreamEvent) => {
      switch (event.type) {
        case "thinking":
          if (thinkingStartedAtRef.current === null) {
            thinkingStartedAtRef.current = Date.now();
          }
          setState((s) => ({ ...s, phase: "thinking", thinkingText: s.thinkingText + event.delta }));
          break;
        case "text":
          endThinkingPhase();
          setState((s) => ({ ...s, phase: "answering", summaryText: s.summaryText + event.delta }));
          break;
        case "not_configured":
          setState((s) => ({ ...s, finalStatus: { status: "not_configured" } }));
          break;
        case "failed":
          endThinkingPhase();
          setState((s) => ({ ...s, finalStatus: { status: "failed", reason: event.reason } }));
          break;
        case "done":
          endThinkingPhase();
          setState((s) => ({
            ...s,
            phase: "done",
            // `done.summary` is the authoritative complete text in every
            // terminal state (streamed deltas equal it on `ok`; on `failed`
            // it's the deterministic fallback replacing any partial text).
            summaryText: event.summary,
            finalStatus: {
              status: event.status,
              ...(event.reason ? { reason: event.reason } : {}),
            },
          }));
          break;
      }
    };

    // Deliberate short delay before connecting: React dev StrictMode
    // mounts, cleans up, and remounts effects synchronously — the timer is
    // cleared before it fires on the throwaway first mount, so exactly one
    // real SSE connection (and one real LLM call) is ever opened.
    const timer = setTimeout(() => {
      startedRef.current = true;
      controllerRef.current = controller;
      setState({ ...INITIAL_STREAM_STATE, phase: "connecting" });
      streamLogFileSummary(fileId, handleEvent, controller.signal).catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({
          ...s,
          phase: "done",
          connectionError: err instanceof Error ? err.message : "Connection to the summary stream was lost.",
        }));
      });
    }, 150);

    // Cleanup only clears the not-yet-fired timer (StrictMode's throwaway
    // first mount, or the tab going inactive before the debounce elapsed).
    // A stream that already started is never aborted here — only by the
    // unmount effect above.
    return () => clearTimeout(timer);
  }, [fileId, hasInitialSummary, active, attempt]);

  function retry() {
    startedRef.current = false;
    thinkingStartedAtRef.current = null;
    sawThinkingEndRef.current = false;
    setState(INITIAL_STREAM_STATE);
    setAttempt((n) => n + 1);
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2.5 font-semibold">
          {/* Icon-tile motif shared with the app header logo and upload file card. */}
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
            <ScrollText className="size-4 text-muted-foreground" aria-hidden />
          </span>
          Timeline summary
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Executive digest, part 1 — the stat strip. Pure header rendering
            of data the page already loaded (event count, anomaly counts,
            severity split, anomaly time window): no LLM involvement, so it
            renders instantly in EVERY state — before the stream connects,
            during thinking, and in all degraded states alike. */}
        <SummaryStatStrip anomalies={anomalies} eventsTotal={eventsTotal} />
        {hasInitialSummary ? (
          <CachedBody
            summary={initialSummary}
            status={initialStatus}
            anomalies={anomalies}
            eventsTotal={eventsTotal}
            anomalyIds={anomalyIds}
            onSelectAnomaly={onSelectAnomaly}
          />
        ) : (
          <StreamingBody
            state={state}
            onRetry={retry}
            anomalies={anomalies}
            eventsTotal={eventsTotal}
            anomalyIds={anomalyIds}
            onSelectAnomaly={onSelectAnomaly}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The persisted-summary path (no stream). The digest hero comes from the
 * summary's own `**TL;DR:**` lead when it has one; summaries persisted
 * before the TL;DR prompt instruction existed — and the deterministic
 * fallback summaries persisted for `failed` — get the client-computed
 * digest instead, so the hero is never a blank gap and never an invented
 * claim (it's derived from the same real anomalies the page loaded). The
 * body (with or without severity-section headings — older cached summaries
 * may predate those too) flows through the same SummaryProse renderer,
 * which treats headings as optional.
 */
function CachedBody({
  summary,
  status,
  anomalies,
  eventsTotal,
  anomalyIds,
  onSelectAnomaly,
}: {
  summary: string;
  status: SummaryLlmStatus;
  anomalies: Anomaly[];
  eventsTotal: number;
  anomalyIds: Set<string>;
  onSelectAnomaly: (anomalyId: string) => void;
}) {
  const split = splitTldr(summary, true);
  const hero = split.tldr ?? buildComputedDigest(anomalies, eventsTotal);
  return (
    <>
      <LlmStatusBanner status={status} />
      <DigestHero markdown={hero} anomalyIds={anomalyIds} onSelectAnomaly={onSelectAnomaly} />
      {split.body.length > 0 && (
        <SummaryProse markdown={split.body} anomalyIds={anomalyIds} onSelectAnomaly={onSelectAnomaly} />
      )}
    </>
  );
}

function StreamingBody({
  state,
  onRetry,
  anomalies,
  eventsTotal,
  anomalyIds,
  onSelectAnomaly,
}: {
  state: StreamState;
  onRetry: () => void;
  anomalies: Anomaly[];
  eventsTotal: number;
  anomalyIds: Set<string>;
  onSelectAnomaly: (anomalyId: string) => void;
}) {
  const { phase, thinkingText, summaryText, thinkingDurationMs, finalStatus, connectionError } = state;

  if (connectionError) {
    return (
      <div className="flex flex-col gap-3">
        {thinkingText.length > 0 && (
          <ThinkingReasoning phase="done" text={thinkingText} durationMs={thinkingDurationMs} />
        )}
        <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <p className="text-sm text-amber-800">
            Couldn&apos;t stream the AI summary ({connectionError}).
          </p>
        </div>
        <Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (phase === "idle" || phase === "connecting") {
    // Honest pre-stream state: the request is (about to be) in flight but no
    // model output exists yet — a neutral label, NOT the "Thinking…" reveal,
    // which is reserved for real thinking deltas.
    return <span className="thinking-shimmer w-fit text-[13px] leading-[18px] font-medium">Preparing summary…</span>;
  }

  // Digest sequencing (composed with the severity-grouped body):
  // - `splitTldr` runs on the RAW stream first and peels off the model's
  //   `**TL;DR:**` lead line — so during `answering` the highest-value
  //   sentence streams straight into the hero slot, and only the REMAINDER
  //   (which starts at the first `### High severity`-style heading) ever
  //   reaches SummaryProse's section-heading renderer. The two parsers
  //   compose by ordering, never by fighting over the same text.
  // - While `hold` is true (first few streamed characters, can't yet tell
  //   whether they're the TL;DR marker), nothing renders — a sub-second
  //   window, never a flash of raw `**TL;DR:**` syntax.
  // - The client-COMPUTED digest only ever appears in terminal states with
  //   no model TL;DR (failed / not_configured / non-compliant output). It is
  //   deliberately NOT shown during thinking and then swapped out — the hero
  //   never changes provenance mid-stream, and never claims a model wrote a
  //   sentence no model call produced.
  const complete = phase === "done";
  const split = splitTldr(summaryText, complete);
  const hero = split.tldr ?? (complete ? buildComputedDigest(anomalies, eventsTotal) : null);

  return (
    <div className="flex flex-col gap-4">
      {thinkingText.length > 0 && (
        <ThinkingReasoning
          phase={phase === "thinking" ? "thinking" : "done"}
          text={thinkingText}
          durationMs={thinkingDurationMs}
        />
      )}
      {finalStatus && finalStatus.status !== "ok" && <LlmStatusBanner status={finalStatus} />}
      {hero !== null && (
        <DigestHero
          markdown={hero}
          streaming={split.tldrStreaming}
          anomalyIds={anomalyIds}
          onSelectAnomaly={onSelectAnomaly}
        />
      )}
      {split.body.length > 0 && (
        <SummaryProse markdown={split.body} anomalyIds={anomalyIds} onSelectAnomaly={onSelectAnomaly} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Executive digest — stat strip + TL;DR hero
// ---------------------------------------------------------------------------

/**
 * Compact strip of real, already-loaded numbers (events analyzed, anomalies
 * flagged, severity split, anomaly time window). Hairline-divided cells via
 * `gap-px` over a border-colored background — same visual family as the
 * app's bordered tables. Everything here is computed client-side; the strip
 * is identical whether the LLM is configured, streaming, or failed.
 */
function SummaryStatStrip({ anomalies, eventsTotal }: { anomalies: Anomaly[]; eventsTotal: number }) {
  const counts = countBySeverity(anomalies);
  const window = getAnomalyWindow(anomalies);

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
      <StatCell label="Events analyzed" value={eventsTotal.toLocaleString("en-US")} />
      <StatCell label="Anomalies flagged" value={String(anomalies.length)} />
      <div className="flex flex-col gap-1 bg-card px-4 py-2.5">
        <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Severity</dt>
        <dd className="m-0 flex items-center gap-3">
          {SEVERITY_ORDER.map((severity) => (
            <span
              key={severity}
              title={`${counts[severity]} ${SEVERITY_LABEL[severity].toLowerCase()}`}
              className={cn(
                "flex items-center gap-1.5 text-sm font-semibold tabular-nums",
                counts[severity] === 0 && "opacity-40",
              )}
            >
              <span className={cn("size-2 shrink-0 rounded-full", SEVERITY_DOT_CLASSES[severity])} aria-hidden />
              {counts[severity]}
              <span className="sr-only">{SEVERITY_LABEL[severity].toLowerCase()}</span>
            </span>
          ))}
        </dd>
      </div>
      <StatCell label="Anomaly window" value={window ? formatWindowLabel(window) : "—"} />
    </dl>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 bg-card px-4 py-2.5">
      <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="m-0 truncate text-sm font-semibold tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Executive digest, part 2 — the TL;DR hero: the single most important
 * sentence, visually set apart above the severity-grouped bullets (blue
 * left accent — the app's action/accent color, NOT a severity color, since
 * the hero is a summary statement, not itself an alert). The markdown
 * passes through the same renderer pipeline as the bullets, so backticked
 * IPs/users/domains become the identical badge pills. While the sentence is
 * still streaming a blinking caret marks it as in-flight.
 */
function DigestHero({
  markdown,
  streaming = false,
  anomalyIds,
  onSelectAnomaly,
}: {
  markdown: string;
  streaming?: boolean;
  anomalyIds: Set<string>;
  onSelectAnomaly: (anomalyId: string) => void;
}) {
  const components = buildSummaryComponents(anomalyIds, onSelectAnomaly);
  return (
    <div className="rounded-lg border border-border border-l-2 border-l-blue-500 bg-muted/40 px-4 py-3">
      <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Key takeaway</p>
      <div className="text-[15px] leading-relaxed font-medium text-pretty text-foreground [&_p]:m-0 [&_p]:inline">
        <ReactMarkdown
          components={components}
          urlTransform={(url) => (EVENT_LINK_PATTERN.test(url) ? url : defaultUrlTransform(url))}
        >
          {markdown}
        </ReactMarkdown>
        {streaming && (
          <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse rounded-full bg-blue-500" aria-hidden />
        )}
      </div>
    </div>
  );
}

/** Matches the DECISIONS.md §14d citation scheme: `event:<anomaly-id>`. */
const EVENT_LINK_PATTERN = /^event:(.+)$/;

// ---------------------------------------------------------------------------
// Severity section headings
// ---------------------------------------------------------------------------

/**
 * The summary is severity-grouped, not flat chronological: the prompt
 * instructs the model to emit its bullets under exact `### High severity` /
 * `### Medium severity` / `### Low severity` headings (in that fixed order,
 * each anomaly's tier stated explicitly in its prompt line using the same
 * shared `getSeverity` banding the Anomalies tab badges use), plus an
 * optional trailing `### Observations` for uncited general commentary.
 *
 * Streaming interacts with this cleanly BECAUSE the order is fixed
 * severity-descending rather than chronological: text streams in linearly,
 * and "most important findings first" is exactly what a triaging analyst
 * wants to see arrive first — no client-side buffering or reordering is
 * needed (and none is done: reshuffling already-rendered text mid-stream
 * would be worse than any ordering it could fix). The prompt additionally
 * forbids returning to an earlier section, which real generations respect
 * (verified across multiple live runs); if a model ever did emit a stray
 * duplicate heading, rendering degrades to a second labeled divider — still
 * honest, still readable, never silently re-attributed.
 */
type SummarySection = Severity | "observations";

function parseSectionHeading(text: string): SummarySection | null {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith("high severity")) return "high";
  if (normalized.startsWith("medium severity")) return "medium";
  if (normalized.startsWith("low severity")) return "low";
  if (normalized.startsWith("observation")) return "observations";
  return null;
}

/**
 * A severity section divider: the Anomalies tab's exact severity-badge
 * language (same `SEVERITY_BADGE_CLASSES` pill, same `SEVERITY_DOT_CLASSES`
 * dot — one system, not a fourth severity style) followed by a hairline
 * rule filling the row. `Observations` gets the app's muted section-label
 * treatment (as in the expanded anomaly details) instead of a severity pill,
 * because it is explicitly NOT a severity tier.
 */
function SectionDivider({ section }: { section: SummarySection }) {
  return (
    // Still a real <h3> (the markdown heading it renders) so the document
    // outline / screen-reader navigation keeps its section structure —
    // `not-prose` opts it out of the typography plugin's heading styles so
    // the explicit divider layout below is the only styling that applies
    // (margins tighter above the first section than between sections).
    <h3 className="not-prose mt-5 mb-2.5 flex items-center gap-3 first:mt-0">
      {section === "observations" ? (
        <span className="text-xs font-medium text-muted-foreground">Observations</span>
      ) : (
        <Badge variant="outline" className={SEVERITY_BADGE_CLASSES[section]}>
          <span className={cn("size-1.5 rounded-full", SEVERITY_DOT_CLASSES[section])} aria-hidden />
          {SEVERITY_LABEL[section]} severity
        </Badge>
      )}
      <span className="h-px flex-1 bg-border" aria-hidden />
    </h3>
  );
}

// ---------------------------------------------------------------------------
// Bold-timestamp reformatting
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Patterns observed in REAL summary generations (fresh ones under the
 * current prompt plus every cached summary in the local DB — not guessed):
 *
 *   **2026-01-05T08:27 UTC**                          ← the common case
 *   **2026-02-02 09:51 UTC**                          ← space instead of T
 *   **2026-01-05T08:27:22Z** / **2026-02-02 09:51Z**  ← Z suffix, optional secs
 *   **2026-01-12T13:42–14:35 UTC**                    ← datetime–time range
 *   **2026-01-09T14:21 UTC – 2026-01-12T13:42 UTC**   ← two full datetimes
 *   **2026-01-15T08:41–17:14 UTC / 2026-01-16T17:38 UTC**  ← slash-joined
 *   **2026-01-12T13:42:27Z & 14:35:27Z**              ← ampersand-joined
 *   **2026-02-02 ~10:55 UTC**                         ← approx marker
 *   **2026-01-12 to 2026-01-16** / **2026-01-10–01-11** ← date-only ranges
 *   **09:51 UTC (Feb 2)** / **09:00–09:13 UTC:**      ← time-only leads
 *   **Bottom line:** / **"Emotet.C2"**                ← NOT timestamps
 *
 * Rather than one brittle regex per shape, ISO date/datetime TOKENS are
 * reformatted wherever they appear inside the bold text and every joiner
 * (–, /, &, "to", "~", parentheticals, trailing words) is left untouched —
 * so ranges and multi-datetime bullets fall out for free, and a bold string
 * containing no recognizable token is left completely unchanged (never a
 * partial/garbled transform).
 */

/** `YYYY-MM-DD` + `T`/space + optional `~` + `HH:MM[:SS]` + optional glued `Z`. */
const BOLD_DATETIME_TOKEN = /(\d{4})-(\d{2})-(\d{2})[T ](~?)(\d{1,2}:\d{2}(?::\d{2})?)(Z\b)?/g;
/** A bare `YYYY-MM-DD` (whatever the datetime pass didn't consume). */
const BOLD_DATE_TOKEN = /(\d{4})-(\d{2})-(\d{2})/g;
/** `MM-DD` shorthand for a range's second endpoint (`…–01-11`, `… to 03-06`) — only ever applied after a full date matched, and only right after a dash/"to" joiner. */
const BOLD_PARTIAL_DATE_TOKEN = /(?<=\bto |[–—-])(\d{2})-(\d{2})\b/g;
/** `HH:MM[:SS]Z` → `HH:MM[:SS] UTC` (a range's second endpoint keeps the pair's only Z: `…24–10:56:03Z`). */
const BOLD_TIME_Z_TOKEN = /\b(\d{1,2}:\d{2}(?::\d{2})?)Z\b/g;
/** Leftover truncated-range remainder like the observed `…16:39:01–34Z`. */
const BOLD_BARE_Z_TOKEN = /\b(\d{1,2})Z\b/g;

/** A lead that is already reader-friendly but still a time marker (`09:51 UTC (Feb 2)`, `12:34:56Z`, `~10:55…`). */
const TIME_LEAD_PATTERN = /^~?\d{1,2}:\d{2}/;
/** An already-formatted lead (`Feb 3, 10:06–12:34 UTC`) — includes what our own transform produces. */
const MONTH_LEAD_PATTERN = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.? \d{1,2}\b/;

function toMonthDay(monthStr: string, dayStr: string): string | null {
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

/**
 * Reformats the ISO-ish timestamp tokens inside one bold string into the
 * Anomalies tab's friendlier style (`2026-01-05T08:27 UTC` → `Jan 5, 08:27
 * UTC`) — same month-short/day/24h shape as that tab's `formatTimestamp`,
 * but computed from the string itself rather than a `Date` because these
 * times are semantically UTC (the "UTC"/"Z" suffix stays; converting to the
 * viewer's local zone would silently contradict the label).
 *
 * Returns `null` when the text is not a time marker at all (e.g. `**Bottom
 * line:**`) — the caller renders it as ordinary bold, untouched.
 */
function formatBoldTimestamp(text: string): string | null {
  let matchedDate = false;

  let out = text.replace(BOLD_DATETIME_TOKEN, (whole, y: string, m: string, d: string, approx: string, time: string, z?: string) => {
    void y;
    const monthDay = toMonthDay(m, d);
    if (!monthDay) return whole;
    matchedDate = true;
    return `${monthDay}, ${approx}${time}${z ? " UTC" : ""}`;
  });

  out = out.replace(BOLD_DATE_TOKEN, (whole, y: string, m: string, d: string) => {
    void y;
    const monthDay = toMonthDay(m, d);
    if (!monthDay) return whole;
    matchedDate = true;
    return monthDay;
  });

  const isTimeLead = TIME_LEAD_PATTERN.test(out);

  if (matchedDate) {
    // `MM-DD` second endpoints only make sense once we know this bold is
    // date-shaped — applying it unconditionally could mangle non-date text.
    out = out.replace(BOLD_PARTIAL_DATE_TOKEN, (whole, m: string, d: string) => toMonthDay(m, d) ?? whole);
  }
  if (matchedDate || isTimeLead) {
    out = out.replace(BOLD_TIME_Z_TOKEN, "$1 UTC").replace(BOLD_BARE_Z_TOKEN, "$1 UTC");
  }

  if (matchedDate || isTimeLead || MONTH_LEAD_PATTERN.test(out)) return out;
  return null;
}

/** Flattens a `strong` node's children to plain text, or `null` when anything non-string is nested inside (leave those bolds alone). */
function childrenToPlainText(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((child): child is string => typeof child === "string")) {
    return children.join("");
  }
  return null;
}

/**
 * The final summary's prose (DECISIONS.md §14d): compact bullet rows — bold
 * timestamp lead-in (plain `**…**` markdown), log-derived tokens rendered as
 * the app's existing pill style (`Badge variant="outline"`, same as the
 * Events tab's action pills) instead of raw inline-code spans, and
 * `event:<id>` citation links intercepted into a "View event →" affordance
 * that reuses the exact Anomalies↔Events cross-link jump. A citation whose
 * id isn't among the page's real loaded anomalies degrades to plain text —
 * never a dead or misleading link.
 *
 * `text-pretty` (text-wrap: pretty) discourages a lone last-line orphan, so
 * a trailing "View event →" chip wraps with some sentence text for company
 * instead of sitting alone on its own line. Progressive enhancement —
 * unsupported browsers keep plain greedy wrapping.
 */
function SummaryProse({
  markdown,
  anomalyIds,
  onSelectAnomaly,
}: {
  markdown: string;
  anomalyIds: Set<string>;
  onSelectAnomaly: (anomalyId: string) => void;
}) {
  const components = buildSummaryComponents(anomalyIds, onSelectAnomaly);

  return (
    <div className="prose prose-sm max-w-none text-sm leading-relaxed text-pretty prose-headings:text-sm prose-headings:font-semibold prose-p:text-foreground prose-strong:text-foreground prose-ul:my-2 prose-ul:pl-5 prose-li:my-2 prose-li:leading-7 prose-li:text-foreground prose-li:marker:text-muted-foreground/50">
      <ReactMarkdown
        components={components}
        // react-markdown's default URL sanitizer only keeps http/https/
        // mailto/tel — it would strip the custom `event:` citation scheme
        // to an empty href before the `a` component ever saw it. Let
        // `event:<id>` through untouched (it's never rendered as a real
        // anchor — the component above turns it into a button or plain
        // text); everything else stays sanitized exactly as before.
        urlTransform={(url) => (EVENT_LINK_PATTERN.test(url) ? url : defaultUrlTransform(url))}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/**
 * The shared markdown renderer overrides — used identically by the bullet
 * prose (`SummaryProse`) and the TL;DR hero (`DigestHero`), so log-derived
 * tokens, citations, and timestamp lead-ins look the same everywhere. (The
 * hero never contains an h3 — `splitTldr` ends the TL;DR at the first line
 * break — so the section-divider override is simply inert there.)
 */
function buildSummaryComponents(anomalyIds: Set<string>, onSelectAnomaly: (anomalyId: string) => void): Components {
  return {
    h3: ({ children }) => {
      // Severity-grouped sections (see the SectionDivider comment block): the
      // model's exact `### High/Medium/Low severity` + `### Observations`
      // headings become labeled dividers reusing the Anomalies tab's severity
      // badges. Any other h3 (the model isn't prompted to emit one, but
      // markdown is markdown) renders as an ordinary prose heading.
      const plainText = childrenToPlainText(children);
      const section = plainText !== null ? parseSectionHeading(plainText) : null;
      if (section === null) return <h3>{children}</h3>;
      return <SectionDivider section={section} />;
    },
    a: ({ href, children }) => {
      const citation = href?.match(EVENT_LINK_PATTERN);
      if (!citation) {
        // A normal hyperlink (the model isn't prompted to emit any, but
        // markdown is markdown) — default anchor behavior.
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      }
      if (!anomalyIds.has(citation[1])) {
        // Hallucinated or stale id — silently de-link to plain text.
        return <>{children}</>;
      }
      return <ViewEventButton anomalyId={citation[1]} onSelectAnomaly={onSelectAnomaly} />;
    },
    strong: ({ children }) => {
      // Deterministic display-side reformat of the model's bold timestamp
      // lead-ins (see formatBoldTimestamp) — same philosophy as the `a` and
      // `code` renderers below: never trust the model's literal formatting
      // for presentation. A muted tabular-nums treatment (NOT the badge
      // pill used for IPs/users/domains) makes the time marker scannable
      // down the bullet list while staying visually distinct from data
      // chips; a bold that isn't a time marker renders as plain bold,
      // completely unchanged.
      const plainText = childrenToPlainText(children);
      const formatted = plainText !== null ? formatBoldTimestamp(plainText) : null;
      if (formatted === null) return <strong>{children}</strong>;
      // `text-muted-foreground!` (important): the wrapper's `prose-strong:
      // text-foreground` compiles to `.… :is(strong)` (specificity 0,1,1),
      // which outranks a plain class on the element itself — verified in the
      // browser before adding the `!`.
      return <strong className="font-semibold text-muted-foreground! tabular-nums">{formatted}</strong>;
    },
    code: ({ children }) => (
      // Same pill language as the rest of the app (Events tab action
      // badges, severity pills) — not a fourth bespoke chip style.
      // `align-[1px]` measured, not guessed: the badge box (22px tall —
      // min-h-5 plus py-0.5 and its border) is taller than the surrounding
      // 14px text's ~18px inline box, so plain baseline alignment leaves the
      // badge's vertical center ~4px below the text's. Raising it 1px above
      // the baseline centers it exactly (getBoundingClientRect center delta
      // = 0px against adjacent words at every checked badge).
      <Badge variant="outline" className="mx-px h-auto min-h-5 max-w-full align-[1px] font-mono text-xs font-normal">
        {children}
      </Badge>
    ),
  };
}

/**
 * The §14d citation affordance — a small blue action chip, visually
 * distinct from prose hyperlinks, sitting inline at the end of its bullet
 * sentence. Clicking (or Enter/Space) runs the SAME `onSelectAnomaly` jump
 * the Events tab's anomalous rows use (tab switch → severity sub-tab →
 * expand → scroll → highlight ring).
 *
 * Why a `span[role=button]` with `display: inline`, not a real `<button>`:
 * browsers force form controls into atomic inline layout no matter what
 * `display` says, and Chrome inserts soft-wrap opportunities on BOTH sides
 * of an atomic inline even with no whitespace around it — so the bullet's
 * trailing punctuation ("…exfiltration [pill].") could line-break away from
 * the pill and strand a lone "." on the next line (verified empirically;
 * a U+2060 WORD JOINER next to an atomic inline is ignored by Blink too).
 * A non-atomic inline span participates in the paragraph's normal text
 * wrapping exactly like a word: it only breaks at real spaces, its own
 * `whitespace-nowrap` keeps the chip in one piece, and the trailing
 * WORD JOINER glues adjacent punctuation to it across engines.
 */
function ViewEventButton({
  anomalyId,
  onSelectAnomaly,
}: {
  anomalyId: string;
  onSelectAnomaly: (anomalyId: string) => void;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => onSelectAnomaly(anomalyId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectAnomaly(anomalyId);
        }
      }}
      className="mx-0.5 inline cursor-pointer rounded-full border border-blue-200 bg-blue-50 px-2 py-px text-xs font-medium whitespace-nowrap text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-100 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none"
    >
      View event
      <ArrowRight className="ml-1 inline size-3 align-[-2px]" aria-hidden />
      {"\u2060" /* WORD JOINER — glues trailing punctuation to the chip */}
    </span>
  );
}
