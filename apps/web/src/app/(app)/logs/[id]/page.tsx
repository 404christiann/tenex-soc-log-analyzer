"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Anomaly, GetFileDetailResponse, ParseErrorsSummary } from "@tenex/shared";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileStatusBadge } from "@/components/file-status-badge";
import { TimelineTab } from "@/components/timeline-tab";
import { AnomaliesTab } from "@/components/anomalies-tab";
import { EventsTable } from "@/components/events-table";
import { ParseErrorsNotice } from "@/components/parse-errors-notice";
import { ApiError, getLogFile } from "@/lib/api";
import { takeStashedUploadResponse } from "@/lib/upload-cache";

type ResultsData = GetFileDetailResponse & { parseErrors: ParseErrorsSummary | null };

/** The results page's top-level tabs (DECISIONS.md §14c). */
type ResultsTab = "timeline" | "anomalies" | "events";

/**
 * Minimum time the loading skeleton stays visible (DECISIONS.md §14c) — a
 * floor, not a fixed duration: a fetch that resolves faster than this still
 * holds the skeleton until the floor elapses (prevents a flash-of-skeleton
 * flicker on fast responses), while a slower fetch keeps the skeleton up for
 * however long it really takes. Real data is never delayed beyond the floor.
 */
const SKELETON_FLOOR_MS = 700;

export default function LogDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [data, setData] = useState<ResultsData | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [floorElapsed, setFloorElapsed] = useState(false);
  const [activeTab, setActiveTab] = useState<ResultsTab>("timeline");
  const [highlightedAnomalyId, setHighlightedAnomalyId] = useState<string | null>(null);

  useEffect(() => {
    setFloorElapsed(false);
    const timer = setTimeout(() => setFloorElapsed(true), SKELETON_FLOOR_MS);
    return () => clearTimeout(timer);
  }, [id]);

  // `takeStashedUploadResponse` deletes-on-read, which isn't safe to call
  // twice for the same `id` — but React's dev StrictMode intentionally
  // double-invokes effects (mount -> cleanup -> mount again) to surface
  // exactly this kind of non-idempotent side effect. Without this guard,
  // the second invocation finds the sessionStorage entry already consumed
  // by the first, falls through to the plain `getLogFile` fetch, and that
  // result (with `parseErrors: null`, since it's never persisted) wins the
  // state-update race — silently hiding the parse-errors notice right after
  // an upload. The ref survives StrictMode's synthetic remount (same fiber,
  // only effects re-run), so the second invocation reuses the first result
  // instead of re-reading.
  const stashCacheRef = useRef<{ id: string; value: ResultsData | "not-found" } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);

    async function load() {
      if (stashCacheRef.current?.id !== id) {
        const taken = takeStashedUploadResponse(id);
        stashCacheRef.current = {
          id,
          value: taken
            ? {
                file: taken.file,
                events: taken.events,
                anomalies: taken.anomalies,
                // §14c: the upload response no longer carries a summary —
                // it streams on demand via GET /api/logs/:id/summary/stream
                // (the Timeline tab opens the stream when first viewed).
                summary: null,
                parseErrors: taken.parseErrors,
              }
            : "not-found",
        };
      }
      const stashed = stashCacheRef.current.value;
      if (stashed !== "not-found") {
        if (!cancelled) {
          setData(stashed);
        }
        return;
      }
      try {
        const response = await getLogFile(id);
        if (!cancelled) {
          setData({ ...response, parseErrors: null });
        }
      } catch (err) {
        if (!cancelled) {
          setError({
            status: err instanceof ApiError ? err.status : 500,
            message: err instanceof ApiError ? err.message : "Failed to load this file.",
          });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const anomaliesByEventId = useMemo(() => {
    const map = new Map<string, Anomaly[]>();
    if (!data) return map;
    for (const anomaly of data.anomalies) {
      const list = map.get(anomaly.eventRef) ?? [];
      list.push(anomaly);
      map.set(anomaly.eventRef, list);
    }
    return map;
  }, [data]);

  // An anomalous row clicked on the Events tab, or a "View event →" summary
  // citation clicked on the Timeline tab (§14d): switch to the Anomalies tab
  // and hand it the id — AnomaliesTab selects the right severity sub-tab,
  // expands the row, and scrolls it into view; the highlight ring clears
  // itself after a beat.
  function handleSelectAnomaly(anomalyId: string) {
    setActiveTab("anomalies");
    setHighlightedAnomalyId(anomalyId);
    window.setTimeout(() => setHighlightedAnomalyId((current) => (current === anomalyId ? null : current)), 2500);
  }

  // The floor gates the error state too — a near-instant error swapping the
  // skeleton out after a few frames flickers just as badly as fast data.
  if (!floorElapsed || (!data && !error)) {
    return <ResultsSkeleton />;
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{error.status === 404 ? "File not found" : "Couldn't load this file"}</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!data) {
    return <ResultsSkeleton />;
  }

  const { file } = data;

  return (
    <div className="flex flex-col gap-6">
      {/* File header — stays fixed above the tab bar (DECISIONS.md §14c). */}
      <div className="flex flex-col gap-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="truncate text-xl font-semibold tracking-tight">{file.filename}</h1>
          <FileStatusBadge status={file.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          Uploaded{" "}
          {new Date(file.uploadedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </p>
      </div>

      {file.status === "failed" && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Processing failed</AlertTitle>
          <AlertDescription>{file.errorMessage ?? "This file failed to process."}</AlertDescription>
        </Alert>
      )}

      {data.parseErrors && <ParseErrorsNotice parseErrors={data.parseErrors} />}

      {file.status === "complete" && (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ResultsTab)} className="gap-4">
          <TabsList>
            <TabsTrigger value="timeline" className="px-3">
              Timeline
            </TabsTrigger>
            <TabsTrigger value="anomalies" className="gap-1.5 px-3">
              Anomalies
              <span className="text-xs text-muted-foreground tabular-nums">{data.anomalies.length}</span>
            </TabsTrigger>
            <TabsTrigger value="events" className="px-3">
              Events
            </TabsTrigger>
          </TabsList>

          {/* All three panels stay mounted: the Timeline tab's in-flight SSE
              stream keeps streaming while another tab is viewed, and the
              Anomalies/Events tabs keep their expansion/pagination state
              across switches. */}
          <TabsContent value="timeline" keepMounted>
            <TimelineTab
              fileId={file.id}
              initialSummary={data.summary}
              initialStatus={file.llmSummaryStatus}
              active={activeTab === "timeline"}
              anomalies={data.anomalies}
              eventsTotal={data.events.pagination.totalCount}
              onSelectAnomaly={handleSelectAnomaly}
            />
          </TabsContent>

          <TabsContent value="anomalies" keepMounted>
            <AnomaliesTab
              anomalies={data.anomalies}
              llmJudgeStatus={file.llmJudgeStatus}
              highlightedAnomalyId={highlightedAnomalyId}
            />
          </TabsContent>

          <TabsContent value="events" keepMounted>
            <EventsTable
              fileId={file.id}
              initialEvents={data.events}
              anomaliesByEventId={anomaliesByEventId}
              onSelectAnomaly={handleSelectAnomaly}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

/**
 * Loading skeleton shaped like the real results page — header (title +
 * status badge + upload date), the three-tab bar, and the default Timeline
 * tab's card shell — not a generic spinner. Held for at least
 * SKELETON_FLOOR_MS.
 */
function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <Skeleton className="h-3.5 w-48" />
      </div>

      {/* Tab bar */}
      <div className="flex flex-col gap-4">
        <div className="flex h-8 w-fit items-center gap-1 rounded-lg bg-muted p-[3px]">
          <Skeleton className="h-full w-20 rounded-md bg-background" />
          <Skeleton className="h-full w-24 rounded-md bg-transparent" />
          <Skeleton className="h-full w-18 rounded-md bg-transparent" />
        </div>

        {/* Timeline tab card (the default tab) */}
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex items-center gap-2.5 border-b border-border px-6 py-4">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="flex flex-col gap-2.5 px-6 py-5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/dashboard"
      className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-blue-600"
    >
      <ArrowLeft className="size-3.5" />
      Back to dashboard
    </Link>
  );
}
