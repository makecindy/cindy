import { DownloadError } from "@cindy/plugin-runtime/download/index";

const systemCodes = new Set([
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EBUSY",
  "ENOENT",
  "EIO",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_STREAM_PREMATURE_CLOSE",
]);
/** Error payloads carry actionable codes, never native paths, URLs or headers. */
export function localModelErrorCode(error: unknown): string {
  if (error instanceof DownloadError) return `DOWNLOAD_${error.code}`;
  if (error instanceof Error && /^[A-Z_]+$/.test(error.message))
    return error.message;
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string" && systemCodes.has(value.code))
      return value.code;
    current = value.cause;
  }
  return "LOCAL_MODEL_OPERATION_FAILED";
}
