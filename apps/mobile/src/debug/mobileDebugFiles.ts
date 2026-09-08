import { Directory, File, Paths } from "expo-file-system";

export const DEBUG_FILE_BYTES = 1024 * 1024;
export const DEBUG_FILE_COUNT = 8;
const RETENTION_MS = 7 * 86400_000;
const FILE_NAME = /^mobile-debug-(\d{13})-(\d+)\.ndjson$/;
let sequence = 0;

function directory(): Directory {
  return new Directory(Paths.document, "cindy-debug");
}

function retainedFiles(now = Date.now()): File[] {
  const dir = directory();
  if (!dir.exists) return [];
  const files = dir
    .list()
    .filter(
      (file): file is File => file instanceof File && FILE_NAME.test(file.name),
    )
    .sort((a, b) => {
      const aa = FILE_NAME.exec(a.name)!;
      const bb = FILE_NAME.exec(b.name)!;
      return Number(aa[1]) - Number(bb[1]) || Number(aa[2]) - Number(bb[2]);
    });
  return files.filter((file, index) => {
    const created = Number(FILE_NAME.exec(file.name)![1]);
    if (
      created < now - RETENTION_MS ||
      created > now ||
      file.size > DEBUG_FILE_BYTES ||
      index < files.length - DEBUG_FILE_COUNT
    ) {
      file.delete();
      return false;
    }
    return true;
  });
}

/** Batch append, bounded rotation. No disk access at import time; caller serializes flush/clear/export. */
export function appendMobileDebugFile(batch: string): void {
  const files = retainedFiles();
  if (!batch) return;
  const bytes = new TextEncoder().encode(batch).byteLength;
  if (bytes > DEBUG_FILE_BYTES) throw new Error("debug batch too large");
  const dir = directory();
  dir.create({ intermediates: true, idempotent: true });
  let file = files.at(-1);
  if (!file || file.size + bytes > DEBUG_FILE_BYTES) {
    do {
      file = new File(dir, `mobile-debug-${Date.now()}-${sequence++}.ndjson`);
    } while (file.exists);
    file.create();
    // Enforce the total cap before appending another file.
    if (files.length >= DEBUG_FILE_COUNT) files[0].delete();
  }
  file.write(batch, { append: true });
}

export function clearMobileDebugFiles(): void {
  const dir = directory();
  if (!dir.exists) return;
  for (const file of dir.list())
    if (file instanceof File && FILE_NAME.test(file.name)) file.delete();
}

/** Copy bounded chunks, not the whole journal into JS memory. Export is the detailed local log. */
export function copyMobileDebugFiles(destination: File): void {
  destination.create();
  for (const file of retainedFiles()) {
    const handle = file.open();
    try {
      while ((handle.offset ?? 0) < (handle.size ?? 0)) {
        destination.write(handle.readBytes(64 * 1024), { append: true });
      }
    } finally {
      handle.close();
    }
  }
}
