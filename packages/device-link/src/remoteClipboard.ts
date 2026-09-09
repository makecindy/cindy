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
export type ClipboardContentRequest =
  | { op: "clipboardContent"; lease: string; action: "copy" }
  | { op: "clipboardContent"; lease: string; action: "begin"; length: number }
  | { op: "clipboardContent"; lease: string; action: "read"; id: string; offset: number }
  | { op: "clipboardContent"; lease: string; action: "write"; id: string; offset: number; data: string }
  | { op: "clipboardContent"; lease: string; action: "commit" | "cancel"; id: string };

export function parseClipboardContentRequest(v: Record<string, unknown>, lease: string): ClipboardContentRequest {
  const op = "clipboardContent";
  if (v.action === "copy") return { op, lease, action: v.action };
  if (v.action === "begin" && Number.isSafeInteger(v.length) && Number(v.length) > 0 && Number(v.length) <= CLIPBOARD_MAX_CHARS)
    return { op, lease, action: v.action, length: Number(v.length) };
  if (typeof v.id !== "string" || !/^[a-f0-9-]{36}$/.test(v.id)) throw new Error("INVALID_REQUEST");
  if (v.action === "commit" || v.action === "cancel") return { op, lease, action: v.action, id: v.id };
  if (!Number.isSafeInteger(v.offset) || Number(v.offset) < 0 || Number(v.offset) >= CLIPBOARD_MAX_CHARS) throw new Error("INVALID_REQUEST");
  if (v.action === "read") return { op, lease, action: v.action, id: v.id, offset: Number(v.offset) };
  if (v.action === "write" && typeof v.data === "string" && v.data.length > 0 && v.data.length <= CLIPBOARD_CHUNK_CHARS)
    return { op, lease, action: v.action, id: v.id, offset: Number(v.offset), data: v.data };
  throw new Error("INVALID_REQUEST");
}
export function parseClipboardContent(json: string): RemoteClipboardContent {
  if (json.length > CLIPBOARD_MAX_CHARS) throw new Error("CLIPBOARD_TOO_LONG");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("CLIPBOARD_UNSUPPORTED"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CLIPBOARD_UNSUPPORTED");
  const v = value as Record<string, unknown>;
  if (!Object.keys(v).length || Object.entries(v).some(([k, x]) =>
    !["text", "html", "rtf", "url", "png"].includes(k) || typeof x !== "string" || !x))
    throw new Error("CLIPBOARD_UNSUPPORTED");
  if (v.url && (typeof v.url !== "string" || !/^https?:\/\//i.test(v.url))) throw new Error("CLIPBOARD_UNSUPPORTED");
  if (v.png && (typeof v.png !== "string" || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v.png) || v.png.length % 4 !== 0))
    throw new Error("CLIPBOARD_UNSUPPORTED");
  return v as RemoteClipboardContent;
}
