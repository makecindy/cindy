/** Error metadata only: never include clipboard contents in diagnostics. */
export function clipboardSyncErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return (
    (code + " " + value).match(
      /\b(?:CLIPBOARD|DESKTOP|INVOKE|PASTE|ERR|E)_[A-Z_]+\b/,
    )?.[0] ?? "UNKNOWN"
  );
}
export function clipboardSyncFailure(error: unknown, failures: number) {
  const code = clipboardSyncErrorCode(error);
  if (/PERMISSION|DENIED|NOT_ALLOWED/.test(code))
    return { code, notice: "clipboardSyncPermission", delay: null };
  if (code === "CLIPBOARD_CONFLICT" || code.endsWith("_CHANGED"))
    return { code, notice: "clipboardSyncConflict", delay: 1500 };
  return {
    code,
    notice: "clipboardSyncFailed",
    delay: Math.min(30000, 1500 * 2 ** Math.min(failures, 5)),
  };
}
