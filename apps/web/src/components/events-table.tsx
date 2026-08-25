"use client";

import { useMemo, useRef, useState } from "react";
import type { Anomaly, PaginatedEvents, StoredLogEvent } from "@tenex/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpDown, ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { SEVERITY_ROW_CLASSES } from "@/lib/severity";
import { ApiError, getLogFileEvents } from "@/lib/api";
import { anomalySeverity, formatTimestampUtc } from "@/lib/digest";

export function EventsTable({
  fileId,
  initialEvents,
  anomaliesByEventId,
  onSelectAnomaly,
}: {
  fileId: string;
  initialEvents: PaginatedEvents;
  anomaliesByEventId: Map<string, Anomaly[]>;
  onSelectAnomaly: (anomalyId: string) => void;
}) {
  const pageSize = initialEvents.pagination.pageSize;
  const totalCount = initialEvents.pagination.totalCount;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const [pageCache, setPageCache] = useState<Map<number, StoredLogEvent[]>>(
    () => new Map([[initialEvents.pagination.page, initialEvents.items]]),
  );
  const [page, setPage] = useState(initialEvents.pagination.page);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const [sortDesc, setSortDesc] = useState(false);

  // Request-token/generation-counter pattern: guards against a stale
  // in-flight fetch (e.g. for page B) clobbering `loading`/`error`/cache
  // state after the user has since navigated to a different page (e.g.
  // cached page C, which returns early below without ever touching
  // `loading`). Only the most recent `goToPage` call's continuation is
  // allowed to apply its result.
  const requestTokenRef = useRef(0);

  async function goToPage(nextPage: number) {
    if (nextPage < 0 || nextPage >= totalPages) return;
    setPage(nextPage);
    const token = ++requestTokenRef.current;
    if (pageCache.has(nextPage)) {
      // Already-available data — never leave a stale spinner from an
      // older in-flight request showing over it.
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await getLogFileEvents(fileId, nextPage, pageSize);
      if (requestTokenRef.current !== token) return;
      setPageCache((prev) => new Map(prev).set(nextPage, result.items));
    } catch (err) {
      if (requestTokenRef.current !== token) return;
      setError(err instanceof ApiError ? err.message : "Failed to load this page of events.");
    } finally {
      if (requestTokenRef.current === token) setLoading(false);
    }
  }

  const rows = useMemo(() => {
    const items = pageCache.get(page) ?? [];
    const filtered = anomaliesOnly ? items.filter((event) => anomaliesByEventId.has(event.id)) : items;
    const sorted = [...filtered].sort((a, b) =>
      sortDesc ? b.datetime.localeCompare(a.datetime) : a.datetime.localeCompare(b.datetime),
    );
    return sorted;
  }, [pageCache, page, anomaliesOnly, anomaliesByEventId, sortDesc]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id="anomalies-only"
            checked={anomaliesOnly}
            onCheckedChange={setAnomaliesOnly}
            className="data-checked:bg-blue-600"
          />
          <Label htmlFor="anomalies-only" className="text-sm font-normal text-muted-foreground">
            Anomalies only <span className="text-xs">(current page)</span>
          </Label>
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">{totalCount.toLocaleString()} events total</p>
      </div>

      {/* Data-table shell (DECISIONS.md §14c): rounded-xl bordered container,
          hairline dividers, tight 13px cells — matching the Anomalies tab's
          table so the two tabs read as one visual system. */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <Table className="text-[13px] [&_td]:px-3 [&_td]:py-2">
          <TableHeader className="bg-muted/40 [&_th]:h-9 [&_th]:px-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8" />
              <TableHead>
                <button
                  type="button"
                  onClick={() => setSortDesc((v) => !v)}
                  className="flex items-center gap-1 hover:text-foreground"
                >
                  Timestamp
                  <ArrowUpDown className="size-3" />
                </button>
              </TableHead>
              <TableHead>Client IP</TableHead>
              <TableHead>User</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!loading && error && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-destructive">
                  {error}
                </TableCell>
              </TableRow>
            )}
            {!loading && !error && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  {anomaliesOnly ? "No anomalous events on this page." : "No events on this page."}
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              !error &&
              rows.map((event) => {
                const eventAnomalies = anomaliesByEventId.get(event.id);
                const topAnomaly = eventAnomalies?.[0];
                const severity = topAnomaly ? anomalySeverity(topAnomaly) : null;
                return (
                  <TableRow
                    key={event.id}
                    className={cn(
                      severity && SEVERITY_ROW_CLASSES[severity],
                      topAnomaly && "cursor-pointer",
                    )}
                    onClick={() => topAnomaly && onSelectAnomaly(topAnomaly.id)}
                  >
                    <TableCell>
                      {topAnomaly && <ShieldAlert className="size-3.5 text-current opacity-80" />}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {formatTimestampUtc(event.datetime)}
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{event.cip}</TableCell>
                    <TableCell className="max-w-[14ch] truncate text-xs">{event.login}</TableCell>
                    <TableCell className="max-w-[26ch] truncate text-xs" title={event.url}>
                      {event.url}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          event.action === "blocked"
                            ? "border-red-200 bg-red-50 text-red-700"
                            : "text-muted-foreground"
                        }
                      >
                        {event.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[16ch] truncate text-xs text-muted-foreground">
                      {event.urlcat}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{event.respcode}</TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Page {page + 1} of {totalPages}
        </p>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={page === 0 || loading} onClick={() => goToPage(page - 1)}>
            <ChevronLeft className="size-4" />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1 || loading}
            onClick={() => goToPage(page + 1)}
          >
            Next
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
