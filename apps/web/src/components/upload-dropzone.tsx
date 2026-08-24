"use client";

import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

/** Mirrors `apps/api/src/middleware/upload-validate.ts`'s `ALLOWED_EXTENSIONS`/`MAX_FILE_SIZE_BYTES` — a client-side hint only; the API re-validates for real. */
export const ALLOWED_EXTENSIONS = [".log", ".txt"];
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Client-side pre-check run before any network call; returns the error message, or null when the file is acceptable. */
export function validateLogFile(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return `Unsupported file type — expected ${ALLOWED_EXTENSIONS.join(" or ")}.`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File is ${formatFileSize(file.size)}, which exceeds the ${formatFileSize(MAX_FILE_SIZE_BYTES)} limit.`;
  }
  return null;
}

/**
 * Preline-style "Default" file-upload dropzone (restyle of the original):
 * dashed rounded-xl box, centered icon + "Drop your file here or browse" +
 * size-limit helper text. Validation still runs here before anything is
 * surfaced upward — valid files go to `onFileSelected`, invalid ones to
 * `onFileRejected` so the caller can render the failed-state file card with
 * the real error message.
 */
export function UploadDropzone({
  onFileSelected,
  onFileRejected,
  disabled,
}: {
  onFileSelected: (file: File) => void;
  onFileRejected: (file: File, error: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function handleFile(file: File) {
    const validationError = validateLogFile(file);
    if (validationError) {
      onFileRejected(file, validationError);
      return;
    }
    onFileSelected(file);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label="Upload a log file"
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={cn(
        "flex cursor-pointer justify-center rounded-xl border border-dashed border-border bg-card p-12 transition-colors",
        isDragging && "border-blue-600 bg-blue-600/5",
        disabled && "cursor-not-allowed opacity-50",
        !disabled && !isDragging && "hover:border-muted-foreground/40",
      )}
    >
      <div className="text-center">
        <span className="inline-flex size-16 items-center justify-center">
          <UploadCloud className="size-12 text-muted-foreground" strokeWidth={1.25} aria-hidden />
        </span>
        <div className="mt-4 flex flex-wrap justify-center text-sm/6 text-muted-foreground">
          <span className="pe-1 font-medium text-foreground">Drop your file here or</span>
          <span className="rounded-lg bg-card font-semibold text-blue-600 decoration-2 hover:text-blue-700 hover:underline">
            browse
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {ALLOWED_EXTENSIONS.join(" or ")} up to {formatFileSize(MAX_FILE_SIZE_BYTES)}.
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_EXTENSIONS.join(",")}
        className="hidden"
        onChange={handleInputChange}
        disabled={disabled}
      />
    </div>
  );
}
