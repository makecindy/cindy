import {
  basenameRemotePath,
  extractRemoteFileExt,
  isHtmlFilePreviewCandidate,
  remoteFilePreviewKind,
} from "./filePreview.js";

/** Presentation only. A source is an opaque reference resolved by its existing host. */
export type PreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "markdown"
  | "html"
  | "diagram"
  | "model"
  | "file";
export interface PreviewItem {
  id: string;
  name: string;
  source: string;
  kind: PreviewKind;
  mimeType?: string;
  size?: number;
}
/** No wrapping: the final item remains final for keyboard, swipe and buttons alike. */
export function previewAdjacentIndex(
  index: number,
  delta: number,
  count: number,
): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), index + delta));
}

/** Takes a real filename, not a signed URL. Transport URLs cannot select executable HTML. */
export function attachmentPreviewKind(
  name: string,
  mimeType?: string,
): PreviewKind {
  const ext = extractRemoteFileExt(basenameRemotePath(name));
  if (
    remoteFilePreviewKind(name) === "drawio" ||
    ext === ".mmd" ||
    ext === ".mermaid"
  )
    return "diagram";
  if (
    [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".webp",
      ".svg",
      ".avif",
      ".bmp",
      ".ico",
      ".heic",
      ".heif",
    ].includes(ext)
  )
    return "image";
  if ([".mp4", ".m4v", ".mov", ".webm", ".ogv", ".mkv"].includes(ext))
    return "video";
  if (
    [".mp3", ".m4a", ".wav", ".ogg", ".oga", ".aac", ".flac", ".opus"].includes(
      ext,
    )
  )
    return "audio";
  if (ext === ".pdf") return "pdf";
  if (ext === ".glb" || ext === ".gltf") return "model";
  if (isHtmlFilePreviewCandidate(name)) return "html";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (remoteFilePreviewKind(name) === "text") return "text";
  // MIME supplements extensionless managed media; it never enables active documents.
  if (!ext && mimeType?.startsWith("image/")) return "image";
  if (!ext && mimeType?.startsWith("video/")) return "video";
  if (!ext && mimeType?.startsWith("audio/")) return "audio";
  return "file";
}

/** Safe chrome label: do not display credentials, query strings, or inline data. */
export function previewSourceName(source: string, fallback: string): string {
  if (/^(data|blob):/i.test(source)) return fallback;
  try {
    const url = new URL(source);
    const path = ["xdt-file:", "xdt-audio:"].includes(url.protocol)
      ? url.searchParams.get("path")
      : url.pathname;
    const name = path ? basenameRemotePath(path) : "";
    return name ? decodeURIComponent(name) : fallback;
  } catch {
    return basenameRemotePath(source) || fallback;
  }
}
