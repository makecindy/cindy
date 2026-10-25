import { isSharedTaskAttachment } from "@cindy/device-link";
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function deny(): never {
  throw new Error("[PERMISSION_DENIED] SharedTask task access denied");
}
export function assertSharedTaskReferences(
  value: unknown,
  sessionId: string,
  depth = 0,
  sharedTaskId?: string,
  existing: ReadonlySet<string> = new Set(),
): void {
  if (depth > 32) deny();
  if (Array.isArray(value)) {
    for (const child of value)
      assertSharedTaskReferences(
        child,
        sessionId,
        depth + 1,
        sharedTaskId,
        existing,
      );
    return;
  }
  const row = record(value);
  if (!row) return;
  for (const [key, child] of Object.entries(row)) {
    if (
      [
        "sessionId",
        "parentSessionId",
        "sourceSessionId",
        "targetSessionId",
      ].includes(key) &&
      child !== sessionId
    )
      deny();
    if (key === "botId" || key === "hostSnapshot") deny();
    // Native Agent tools retain normal task permissions; client references are
    // direct host reads and must come from this task's authorized upload area.
    if (
      (key === "path" || key === "url") &&
      child !== undefined &&
      child !== null &&
      child !== "" &&
      !(
        typeof child === "string" &&
        (existing.has(child) ||
          (sharedTaskId && isSharedTaskAttachment(child, sharedTaskId)))
      )
    )
      deny();
    // Persisted reference chips are another input to host-side hydration.
    if (key === "persistedContent" && typeof child === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(child);
      } catch {
        continue;
      }
      assertSharedTaskReferences(
        parsed,
        sessionId,
        depth + 1,
        sharedTaskId,
        existing,
      );
    } else if (child && typeof child === "object")
      assertSharedTaskReferences(
        child,
        sessionId,
        depth + 1,
        sharedTaskId,
        existing,
      );
  }
}
