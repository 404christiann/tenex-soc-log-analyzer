import type { LogFileStatus } from "@tenex/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<LogFileStatus, string> = {
  complete: "border-emerald-200 bg-emerald-50 text-emerald-700",
  processing: "border-blue-200 bg-blue-50 text-blue-700",
  failed: "border-red-200 bg-red-50 text-red-700",
};

const STATUS_LABELS: Record<LogFileStatus, string> = {
  complete: "Complete",
  processing: "Processing",
  failed: "Failed",
};

export function FileStatusBadge({ status, className }: { status: LogFileStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn(STATUS_STYLES[status], className)}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
