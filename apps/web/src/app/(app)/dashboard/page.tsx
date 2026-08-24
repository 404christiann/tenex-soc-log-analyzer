"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Inbox } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UploadDropzone } from "@/components/upload-dropzone";
import { UploadFileCard } from "@/components/upload-file-card";
import { FileStatusBadge } from "@/components/file-status-badge";
import { ApiError, listLogFiles, uploadLogFile, type LogFileMetaWithStats } from "@/lib/api";
import { stashUploadResponse } from "@/lib/upload-cache";

/** How long the teal "complete" card stays visible before navigating to the results page. */
const COMPLETE_NAVIGATE_DELAY_MS = 1200;

type UploadState =
  | { status: "uploading"; file: File }
  | { status: "complete"; file: File; fileId: string }
  | { status: "failed"; file: File; error: string; retryable: boolean };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function DashboardPage() {
  const router = useRouter();
  const [files, setFiles] = useState<LogFileMetaWithStats[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [upload, setUpload] = useState<UploadState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const navigateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (navigateTimerRef.current) clearTimeout(navigateTimerRef.current);
    };
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      const { files } = await listLogFiles();
      setFiles(files);
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "Failed to load your files.");
    }
  }, []);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  async function handleFileSelected(file: File) {
    const controller = new AbortController();
    abortRef.current = controller;
    setUpload({ status: "uploading", file });
    try {
      const response = await uploadLogFile(file, controller.signal);
      // Parse-error/skip data (and, harmlessly, the rest of this response)
      // isn't persisted server-side (DECISIONS.md — no DB column for it), so
      // it's stashed here for the results page to pick up on first render.
      stashUploadResponse(response);
      setUpload({ status: "complete", file, fileId: response.file.id });
      refreshFiles();
      navigateTimerRef.current = setTimeout(() => {
        router.push(`/logs/${response.file.id}`);
      }, COMPLETE_NAVIGATE_DELAY_MS);
    } catch (err) {
      if (controller.signal.aborted) {
        // User hit Cancel — the request was genuinely aborted; back to the dropzone.
        setUpload(null);
        return;
      }
      setUpload({
        status: "failed",
        file,
        error: err instanceof ApiError ? err.message : "Upload failed. Please try again.",
        retryable: true,
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  /** Client-side validation rejected the file (wrong extension / oversized) — no request was sent, and retrying the same file would fail again. */
  function handleFileRejected(file: File, error: string) {
    setUpload({ status: "failed", file, error, retryable: false });
  }

  function handleCancelUpload() {
    abortRef.current?.abort();
  }

  function handleDismissUpload() {
    if (navigateTimerRef.current) {
      clearTimeout(navigateTimerRef.current);
      navigateTimerRef.current = null;
    }
    setUpload(null);
  }

  function handleRetryUpload() {
    if (upload) handleFileSelected(upload.file);
  }

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <CardHeader>
          <CardTitle>Upload a log file</CardTitle>
          <CardDescription>
            Upload a Zscaler-style web proxy log for parsing, anomaly detection, and AI review of top findings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <UploadDropzone
            onFileSelected={handleFileSelected}
            onFileRejected={handleFileRejected}
            disabled={upload?.status === "uploading"}
          />
          {upload && (
            <UploadFileCard
              filename={upload.file.name}
              fileSize={upload.file.size}
              status={upload.status}
              error={upload.status === "failed" ? upload.error : undefined}
              retryable={upload.status === "failed" ? upload.retryable : undefined}
              onCancel={handleCancelUpload}
              onDelete={handleDismissUpload}
              onRetry={handleRetryUpload}
            />
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-muted-foreground">Your files</h2>
        <Card className="p-0">
          {listError && (
            <div className="p-5">
              <Alert variant="destructive">
                <AlertDescription>{listError}</AlertDescription>
              </Alert>
            </div>
          )}
          {!listError && files === null && (
            <div className="flex flex-col gap-3 p-5">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {!listError && files !== null && files.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <Inbox className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
              <p className="text-sm text-muted-foreground">No files uploaded yet — upload one above to get started.</p>
            </div>
          )}
          {!listError && files !== null && files.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Anomalies</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((file) => (
                  <TableRow
                    key={file.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/logs/${file.id}`)}
                  >
                    <TableCell className="font-medium">
                      <Link
                        href={`/logs/${file.id}`}
                        className="flex items-center gap-2 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <span className="max-w-[28ch] truncate">{file.filename}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(file.uploadedAt)}</TableCell>
                    <TableCell>
                      <FileStatusBadge status={file.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {file.status === "complete" ? file.anomalyCount : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
