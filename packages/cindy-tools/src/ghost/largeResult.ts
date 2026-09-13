import type { CindyGhostsMcpDeps } from "../types.js";

// Count the serialized MCP envelope, including escaping, rather than JS chars.
export const GHOST_RESULT_MAX_BYTES = 64 * 1024;
const PREVIEW_MAX_BYTES = 1024;
type TextResult = { content: [{ type: "text"; text: string }]; isError?: true };
function envelope(text: string, isError: boolean): TextResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true as const } : {}) };
}
function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Spill before the SDK receives the result. The Host owns storage and identity. */
export async function boundGhostResult(
  deps: Pick<CindyGhostsMcpDeps, "saveLargeGhostResult">,
  payload: Record<string, unknown>,
  isError = false,
): Promise<TextResult> {
  const text = JSON.stringify(payload);
  const original = envelope(text, isError);
  if (size(original) <= GHOST_RESULT_MAX_BYTES) return original;

  const bytes = Buffer.byteLength(text, "utf8");
  // Iterate code points so the preview never ends with a broken surrogate pair.
  let preview = "";
  for (const point of text) {
    if (size(preview + point) > PREVIEW_MAX_BYTES) break;
    preview += point;
  }
  let savedTo: string | undefined;
  try {
    savedTo = await deps.saveLargeGhostResult?.(text);
  } catch {
    // Never echo storage errors (which can contain private paths), or retry the
    // plugin: a successful write operation may already have had side effects.
  }
  const pointer = {
    ...(savedTo ? { saved_to: savedTo } : {}),
    bytes,
    truncated: true,
    complete_result_saved: !!savedTo,
    preview,
    hint: savedTo
      ? "The complete JSON result is saved at saved_to. Read selected portions with file tools; do not load the whole file into context. Do not repeat the original tool action."
      : "The tool already ran, but its oversized result could not be saved. Only this preview is available. Do not repeat a side-effecting action; use a narrower read query to recover data.",
  };
  // Preserve card/media routing, setup advice, and original success/error status.
  // All fields, including ones too large to keep inline, also live in the file.
  const { result: _result, ...metadata } = payload;
  const projected = envelope(JSON.stringify({
    ...metadata,
    ...pointer,
    ...(typeof metadata.hint === "string" ? { hint: `${metadata.hint}\n${pointer.hint}` } : {}),
    result: pointer,
  }), isError);
  if (size(projected) <= GHOST_RESULT_MAX_BYTES) return projected;
  return envelope(JSON.stringify({
    ok: payload.ok,
    ...(typeof payload.errorCode === "string" ? { errorCode: payload.errorCode.slice(0, 256) } : {}),
    ...pointer,
    metadata_externalized: true,
  }), isError);
}
