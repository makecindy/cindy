/** Portable representations of one clipboard item. No remote paths or private formats. */
export interface RemoteClipboardContent {
  text?: string;
  html?: string;
  rtf?: string;
  url?: string;
  png?: string;
}
export const CLIPBOARD_CHUNK_CHARS = 64 * 1024;
export const CLIPBOARD_MAX_CHARS = 32 * 1024 * 1024;
export type ClipboardContentRequest = {
  sync?: boolean;
  version?: string;
  inline?: boolean;
} & (
  | { op: "clipboardContent"; lease: string; action: "copy" }
  | { op: "clipboardContent"; lease: string; action: "paste"; data: string }
  | { op: "clipboardContent"; lease: string; action: "begin"; length: number }
  | {
      op: "clipboardContent";
      lease: string;
      action: "read";
      id: string;
      offset: number;
    }
  | {
      op: "clipboardContent";
      lease: string;
      action: "write";
      id: string;
      offset: number;
      data: string;
    }
  | {
      op: "clipboardContent";
      lease: string;
      action: "commit" | "cancel";
      id: string;
    }
);

export function parseClipboardContentRequest(
  v: Record<string, unknown>,
  lease: string,
): ClipboardContentRequest {
  if (v.sync !== undefined && typeof v.sync !== "boolean")
    throw new Error("INVALID_REQUEST");
  if (
    v.version !== undefined &&
    (typeof v.version !== "string" || v.version.length > 128 || !v.version)
  )
    throw new Error("INVALID_REQUEST");
  const request = parseTransferRequest(v, lease);
  if (v.inline !== undefined && typeof v.inline !== "boolean")
    throw new Error("INVALID_REQUEST");
  if (
    (v.inline === true || v.action === "paste") &&
    (v.sync !== true || typeof v.version !== "string" || !v.version)
  )
    throw new Error("INVALID_REQUEST");
  return {
    ...request,
    ...(v.sync === true ? { sync: true } : {}),
    ...(typeof v.version === "string" ? { version: v.version } : {}),
    ...(v.inline === true ? { inline: true } : {}),
  };
}
function parseTransferRequest(
  v: Record<string, unknown>,
  lease: string,
): ClipboardContentRequest {
  const op = "clipboardContent";
  if (v.action === "copy") return { op, lease, action: v.action };
  if (v.action === "paste") {
    if (
      typeof v.data !== "string" ||
      !v.data.length ||
      v.data.length > CLIPBOARD_CHUNK_CHARS
    )
      throw new Error("INVALID_REQUEST");
    parseClipboardContent(v.data);
    return { op, lease, action: "paste", data: v.data };
  }
  if (
    v.action === "begin" &&
    Number.isSafeInteger(v.length) &&
    Number(v.length) > 0 &&
    Number(v.length) <= CLIPBOARD_MAX_CHARS
  )
    return { op, lease, action: v.action, length: Number(v.length) };
  if (typeof v.id !== "string" || !/^[a-f0-9-]{36}$/.test(v.id))
    throw new Error("INVALID_REQUEST");
  if (v.action === "commit" || v.action === "cancel")
    return { op, lease, action: v.action, id: v.id };
  if (
    !Number.isSafeInteger(v.offset) ||
    Number(v.offset) < 0 ||
    Number(v.offset) >= CLIPBOARD_MAX_CHARS
  )
    throw new Error("INVALID_REQUEST");
  if (v.action === "read")
    return { op, lease, action: v.action, id: v.id, offset: Number(v.offset) };
  if (
    v.action === "write" &&
    typeof v.data === "string" &&
    v.data.length > 0 &&
    v.data.length <= CLIPBOARD_CHUNK_CHARS
  )
    return {
      op,
      lease,
      action: v.action,
      id: v.id,
      offset: Number(v.offset),
      data: v.data,
    };
  throw new Error("INVALID_REQUEST");
}
export function parseClipboardContent(json: string): RemoteClipboardContent {
  if (json.length > CLIPBOARD_MAX_CHARS) throw new Error("CLIPBOARD_TOO_LONG");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("CLIPBOARD_UNSUPPORTED");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLIPBOARD_UNSUPPORTED");
  const v = value as Record<string, unknown>;
  if (
    !Object.keys(v).length ||
    Object.entries(v).some(
      ([k, x]) =>
        !["text", "html", "rtf", "url", "png"].includes(k) ||
        typeof x !== "string" ||
        !x,
    )
  )
    throw new Error("CLIPBOARD_UNSUPPORTED");
  if (v.url && (typeof v.url !== "string" || !/^https?:\/\//i.test(v.url)))
    throw new Error("CLIPBOARD_UNSUPPORTED");
  if (
    v.png &&
    (typeof v.png !== "string" ||
      !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v.png) ||
      v.png.length % 4 !== 0)
  )
    throw new Error("CLIPBOARD_UNSUPPORTED");
  return v as RemoteClipboardContent;
}
