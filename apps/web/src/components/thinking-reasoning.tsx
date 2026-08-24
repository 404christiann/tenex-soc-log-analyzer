"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The streaming "Thinking…" reasoning block (DECISIONS.md §14c) — the
 * interaction mechanics are adapted from aicss.dev's `thinking-reasoning`
 * reference (shimmer label → line-by-line reveal in a capped, auto-scrolling,
 * fade-masked viewport → fold into a clickable "Thought for Ns" summary),
 * but the CONTENT is real: `text` is the accumulated summarized
 * adaptive-thinking deltas from `GET /api/logs/:id/summary/stream`, and the
 * duration is real wall-clock time measured by the parent. Nothing here is
 * ever rendered for a call that didn't happen (the parent skips this
 * component entirely on `not_configured`).
 *
 * The reference reveals pre-known sentences on a timer; real deltas arrive
 * as arbitrary text chunks, so this re-chunks the accumulated text on
 * sentence-ending punctuation / paragraph breaks as it grows — each chunk
 * is stable once complete (splitting is append-only over a growing string),
 * so earlier lines keep their identity and don't re-animate.
 */
export function ThinkingReasoning({
  phase,
  text,
  durationMs,
}: {
  /** `thinking` while deltas are still arriving; `done` once the answer/failure phase began. */
  phase: "thinking" | "done";
  /** The full accumulated reasoning text so far (real thinking deltas, concatenated). */
  text: string;
  /** Real elapsed thinking wall-clock ms — measured by the parent, only meaningful once `done`. */
  durationMs: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => splitIntoLines(text), [text]);

  // Auto-scroll the capped viewport to the newest line while thinking.
  useEffect(() => {
    if (phase !== "thinking") return;
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [phase, lines.length]);

  const thinking = phase === "thinking";
  const open = thinking || expanded;
  const seconds = durationMs === null ? null : Math.max(1, Math.round(durationMs / 1000));

  return (
    <div className="flex flex-col">
      {thinking ? (
        <span className="thinking-shimmer w-fit text-[13px] leading-[18px] font-medium">Thinking…</span>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-[13px] leading-[18px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {seconds === null ? "Thought about it" : `Thought for ${seconds}s`}
          <ChevronDown
            className={cn("size-3.5 transition-transform duration-[280ms]", expanded && "rotate-180")}
            aria-hidden
          />
        </button>
      )}

      <div className={cn("thinking-collapsible", !open && "is-collapsed")}>
        <div className="min-h-0 overflow-hidden">
          <div
            ref={viewportRef}
            className={cn(
              "thinking-fade-mask flex flex-col gap-1.5 py-2",
              // While streaming: capped height, no user scrolling — content
              // auto-scrolls. Once folded and re-expanded by the user: a
              // taller, natively scrollable viewport.
              thinking ? "max-h-[180px] overflow-hidden" : "max-h-[300px] overflow-y-auto",
            )}
          >
            {lines.map((line, index) => (
              <p key={index} className="thinking-sentence m-0 text-[13px] leading-5 text-muted-foreground">
                {line}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Chunks accumulated streamed text for the line-by-line reveal: paragraph
 * breaks first, then sentence-ending punctuation followed by whitespace.
 * Append-only input means previously produced chunks never change, so the
 * index keys above are stable and only the newest line animates in.
 */
function splitIntoLines(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
