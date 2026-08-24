"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, RotateCcw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatFileSize } from "@/components/upload-dropzone";

/**
 * Preline-style file-progress card driven by what's REAL in this app.
 *
 * The upload is one synchronous request (DECISIONS.md §10) — no server-sent
 * progress events, no chunking, no pause/resume. So instead of a smooth fake
 * percentage, the bar advances in honest discrete jumps as the staged
 * elapsed-time schedule below fires (the same schedule the previous
 * `upload-progress.tsx` step list used), with the current stage named under
 * the bar. The reference design's "pause" slot is repurposed as Cancel,
 * wired by the parent to an AbortController that genuinely aborts the
 * in-flight fetch. On failure the bar freezes wherever it got to and the
 * real error message renders below.
 *
 * Summary generation is no longer part of the upload request (DECISIONS.md
 * §14c — it streams on demand from the results page's Timeline tab), so the
 * staged schedule ends at the AI review (judge) stage.
 */
const STEPS: { label: string; atMs: number }[] = [
  { label: "Uploading file", atMs: 0 },
  { label: "Parsing log entries", atMs: 1200 },
  { label: "Running detection rules", atMs: 3000 },
  { label: "AI review of top findings", atMs: 5500 },
];

/**
 * Rotating "thinking" flavor text (DECISIONS.md §14c) — deliberately generic
 * decorative copy, NOT tied to real stage-specific facts (an explicit user
 * choice over stage-derived micro-copy). It renders as a secondary shimmer
 * line; the real stage label above it stays the source of truth.
 */
const FLAVOR_PHRASES = ["Analyzing…", "Working on it…", "Crunching the log…", "Almost there…", "Just a moment…"];
const FLAVOR_INTERVAL_MS = 1200;

function RotatingFlavorText() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setIndex((i) => (i + 1) % FLAVOR_PHRASES.length), FLAVOR_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
  // Decorative only — hidden from screen readers; the real stage label carries the information.
  return (
    <p className="text-xs" aria-hidden>
      <span key={index} className="upload-flavor-text inline-block">
        {FLAVOR_PHRASES[index]}
      </span>
    </p>
  );
}

const STILL_WORKING_AFTER_MS = 8000;
const TICK_MS = 200;

export type UploadCardStatus = "uploading" | "complete" | "failed";

export function UploadFileCard({
  filename,
  fileSize,
  status,
  error,
  retryable,
  onCancel,
  onDelete,
  onRetry,
}: {
  filename: string;
  fileSize: number;
  status: UploadCardStatus;
  /** Real error message (client-side validation or the API's response) — required when status is "failed". */
  error?: string;
  /** Whether a retry could plausibly succeed (false for client-side validation failures — the same file would fail again). */
  retryable?: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);

  // Runs only while uploading; on failure the effect tears down and `elapsed`
  // keeps its last value, freezing the bar at the stage where it stopped.
  useEffect(() => {
    if (status !== "uploading") return;
    setElapsed(0);
    const start = Date.now();
    const interval = setInterval(() => setElapsed(Date.now() - start), TICK_MS);
    return () => clearInterval(interval);
  }, [status]);

  const stageIndex = STEPS.reduce((acc, step, i) => (elapsed >= step.atMs ? i : acc), 0);
  const percent = status === "complete" ? 100 : Math.round((stageIndex / STEPS.length) * 100);
  const showStillWorking =
    status === "uploading" && stageIndex === STEPS.length - 1 && elapsed - STEPS[STEPS.length - 1].atMs > STILL_WORKING_AFTER_MS;

  const iconButtonClasses = "relative text-muted-foreground transition-colors hover:text-foreground";

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-x-3">
          <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-card text-foreground">
            <FileText className="size-4 shrink-0" aria-hidden />
          </span>
          <div>
            <p className="max-w-[36ch] truncate text-sm font-medium text-foreground">{filename}</p>
            <p className="text-xs text-muted-foreground">{formatFileSize(fileSize)}</p>
          </div>
        </div>
        <div className="inline-flex items-center gap-x-2">
          {status === "uploading" && (
            <button type="button" onClick={onCancel} aria-label="Cancel upload" className={iconButtonClasses}>
              <X className="size-4 shrink-0" aria-hidden />
            </button>
          )}
          {status === "complete" && (
            <span className="text-teal-500" aria-label="Upload complete">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            </span>
          )}
          {status === "failed" && (
            <span className="text-red-500" aria-label="Upload failed">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
            </span>
          )}
          {status === "failed" && retryable && (
            <button type="button" onClick={onRetry} aria-label="Retry upload" className={iconButtonClasses}>
              <RotateCcw className="size-4 shrink-0" aria-hidden />
            </button>
          )}
          {status !== "uploading" && (
            <button type="button" onClick={onDelete} aria-label="Remove file" className={iconButtonClasses}>
              <Trash2 className="size-4 shrink-0" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-x-3 whitespace-nowrap">
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn(
              "flex flex-col justify-center overflow-hidden rounded-full transition-all duration-500",
              status === "complete" && "bg-teal-500",
              status === "failed" && "bg-red-500",
              status === "uploading" && "bg-blue-600",
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="w-10 text-end">
          <span className="text-sm text-foreground">{percent}%</span>
        </div>
      </div>
      {status === "uploading" && (
        <div className="mt-2 flex flex-col gap-0.5">
          <p className="text-xs text-muted-foreground">
            {STEPS[stageIndex].label}…
            {showStillWorking && " Still working — larger files and AI review can take a little longer than usual."}
          </p>
          <RotatingFlavorText />
        </div>
      )}
      {status === "complete" && (
        <p className="mt-2 text-xs text-muted-foreground">Events and anomalies ready — opening results…</p>
      )}
      {status === "failed" && error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
