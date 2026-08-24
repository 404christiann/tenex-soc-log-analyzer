"use client";

import { useState } from "react";
import type { ParseErrorsSummary } from "@tenex/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { AlertOctagon, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Section 4 of the results page — surfaces the parser's per-line error
 * count/samples so a reviewer can see the malformed-file handling
 * (DECISIONS.md §13/§14a) without reading code. Only ever populated on the
 * response from the upload call itself (not persisted server-side), so this
 * only appears right after an upload, not on a later revisit.
 */
export function ParseErrorsNotice({ parseErrors }: { parseErrors: ParseErrorsSummary }) {
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);

  if (dismissed) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-amber-200 bg-amber-50 text-sm">
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <AlertOctagon className="size-4 shrink-0 text-amber-600" />
          <p className="flex-1 text-amber-800">
            {parseErrors.count} line{parseErrors.count === 1 ? "" : "s"} couldn&apos;t be parsed
            {parseErrors.skippedCount > 0 && ` (plus ${parseErrors.skippedCount} blank lines skipped)`} — the rest
            of the file was processed normally.
          </p>
          {parseErrors.sampleReasons.length > 0 && (
            <CollapsibleTrigger
              render={
                <Button variant="ghost" size="sm" className="shrink-0 text-amber-700">
                  Details
                  <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
                </Button>
              }
            />
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-amber-700"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
            <span className="sr-only">Dismiss</span>
          </Button>
        </div>
        <CollapsibleContent>
          <ul className="flex flex-col gap-1 border-t border-amber-200 px-3.5 py-2.5 font-mono text-xs text-amber-800/90">
            {parseErrors.sampleReasons.map((reason) => (
              <li key={reason} className="truncate">
                {reason}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
