import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const WINDOWS_RESERVED_FILENAME_STEMS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function isPathWithin(base: string, target: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(normalize(base), normalize(target));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Resolve a model-authored attachment only when both its lexical path and
 * canonical target stay under a host-approved root. Returning the canonical
 * path keeps the later stat/read on the same symlink-resolved target.
 */
export async function resolveAllowedWecomOutboundFile(
  absPath: string,
  allowedRoots: readonly string[],
  realpath: (target: string) => Promise<string> = fs.realpath,
): Promise<string | null> {
  const targetAbs = path.resolve(absPath);
  for (const root of allowedRoots) {
    if (!root.trim()) continue;
    const rootAbs = path.resolve(root);
    if (!isPathWithin(rootAbs, targetAbs)) continue;
    try {
      const [rootReal, targetReal] = await Promise.all([
        realpath(rootAbs),
        realpath(targetAbs),
      ]);
      if (isPathWithin(rootReal, targetReal)) return targetReal;
    } catch {
      // Missing, unreadable, or cyclic paths fail closed.
    }
  }
  return null;
}

export function mimeTypeForFilename(filename: string | undefined): string {
  const extension = path.extname(filename ?? "").toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function safeWecomFilename(
  filename: string | undefined,
  fallbackExtension = "",
): string {
  const sanitized = path
    .basename(filename?.trim() || `attachment${fallbackExtension}`)
    // eslint-disable-next-line no-control-regex -- filenames must strip ASCII control characters
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .slice(0, 160);
  let end = sanitized.length;
  while (
    end > 0 &&
    (sanitized.charCodeAt(end - 1) === 0x2e ||
      sanitized.charCodeAt(end - 1) === 0x20)
  ) {
    end -= 1;
  }
  const base = sanitized.slice(0, end);
  if (!base) return `attachment${fallbackExtension}`;

  const stemEnd = base.indexOf(".");
  const stem = (stemEnd === -1 ? base : base.slice(0, stemEnd)).toUpperCase();
  return WINDOWS_RESERVED_FILENAME_STEMS.has(stem)
    ? `_${base}`.slice(0, 160)
    : base;
}

export async function persistWecomDownload(args: {
  mediaDir: string;
  buffer: Buffer;
  filename?: string;
  fallbackExtension?: string;
  shouldKeep?: () => boolean;
}): Promise<{ absPath: string; originalName: string; mimeType: string }> {
  if (args.buffer.length === 0) throw new Error("WECOM_MEDIA_EMPTY");
  if (args.buffer.length > MAX_MEDIA_BYTES)
    throw new Error("WECOM_MEDIA_TOO_LARGE");

  const originalName = safeWecomFilename(args.filename, args.fallbackExtension);
  const storageName = `${randomUUID()}-${originalName}`;
  if (args.shouldKeep?.() === false) throw new Error("WECOM_MEDIA_STALE");
  await fs.mkdir(args.mediaDir, { recursive: true });
  const absPath = path.join(args.mediaDir, storageName);
  await fs.writeFile(absPath, args.buffer, { flag: "wx" });
  if (args.shouldKeep?.() === false) {
    await fs.rm(absPath, { force: true });
    throw new Error("WECOM_MEDIA_STALE");
  }
  return {
    absPath,
    originalName,
    mimeType: mimeTypeForFilename(originalName),
  };
}

export async function readWecomOutboundFile(
  absPath: string,
  displayName?: string,
): Promise<{
  buffer: Buffer;
  filename: string;
  mediaType: "file" | "image" | "voice" | "video";
}> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) throw new Error("WECOM_FILE_NOT_FOUND");
  if (stat.size === 0) throw new Error("WECOM_FILE_EMPTY");
  if (stat.size > MAX_MEDIA_BYTES) throw new Error("WECOM_FILE_TOO_LARGE");

  const filename = safeWecomFilename(displayName || path.basename(absPath));
  const mimeType = mimeTypeForFilename(filename);
  const mediaType =
    mimeType.startsWith("image/") && stat.size <= MAX_IMAGE_BYTES
      ? "image"
      : mimeType.startsWith("video/")
        ? "video"
        : mimeType.startsWith("audio/")
          ? "voice"
          : "file";
  return {
    buffer: await fs.readFile(absPath),
    filename,
    mediaType,
  };
}
