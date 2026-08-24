import type { UploadResponse } from "@tenex/shared";

/**
 * A same-tab-only handoff from the dashboard's upload flow to the results
 * page, for data the API never persists: `parseErrors` (computed in-memory
 * during `POST /api/logs/upload`, no DB column for it — see
 * `packages/shared/src/api.ts`'s `ParseErrorsSummarySchema` comment). A
 * plain in-memory variable would also work for a same-navigation handoff,
 * but `sessionStorage` survives the dashboard->results client navigation
 * (and a manual refresh right after) without adding global state.
 */
const KEY_PREFIX = "tenex:upload:";

export function stashUploadResponse(response: UploadResponse): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${KEY_PREFIX}${response.file.id}`, JSON.stringify(response));
  } catch {
    // sessionStorage can throw in private-browsing/quota-exceeded edge cases — non-critical, just skip the handoff.
  }
}

export function takeStashedUploadResponse(fileId: string): UploadResponse | null {
  if (typeof window === "undefined") return null;
  const key = `${KEY_PREFIX}${fileId}`;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    window.sessionStorage.removeItem(key);
    return JSON.parse(raw) as UploadResponse;
  } catch {
    return null;
  }
}
