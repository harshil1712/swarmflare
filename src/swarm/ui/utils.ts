import type { SwarmRunState, WorkUnitStatus } from "../types";

export function getStatusVariant(
  status: WorkUnitStatus | SwarmRunState["status"]
) {
  if (status === "complete") return "primary";
  if (status === "failed" || status === "cancelled") return "destructive";
  return "secondary";
}

export function formatDateTime(value?: string) {
  if (!value) return "Not started";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
