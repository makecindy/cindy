import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReviewReadPath, type ReviewReadGrant } from '../shared/review-read-scope.js';
import type { DynamicToolCallResponse, DynamicToolSpec } from './app-server/protocol.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PAGE_SIZE = 200;
const DENIED = 'Review refused this read: invalid arguments, unavailable file, or outside the approved read scope.';

/** Also used before startup so an unreadable network scope never starts Review. */
export function isWindowsReviewLocalPath(rawPath: string, workingDir: string): boolean {
  try {
    const value = rawPath.trim();
    const target = /^file:/i.test(value) ? fileURLToPath(value) : value;
    const resolved = path.win32.resolve(workingDir, target);
    return /^[a-z]:\\/i.test(resolved) && !resolved.slice(2).includes(':');
  } catch {
    return false;
  }
}

export const REVIEW_READ_TOOLS: DynamicToolSpec[] = [
  {
    type: 'function', name: 'review_read_file',
    description: 'Read a UTF-8 evidence file within the approved Review scope. Returns up to 200 numbered lines (maximum file size 2 MiB). Use offset for the next page. Read applicable AGENTS.md files explicitly with this tool.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['path'], additionalProperties: false },
  },
  {
    type: 'function', name: 'review_list_directory',
    description: 'List an evidence directory within the approved Review scope. Sensitive files and paths outside the scope are excluded. Returns up to 200 entries; use nextOffset for the next page.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['path'], additionalProperties: false },
  },
  {
    type: 'function', name: 'review_view_image',
    description: 'View a PNG, JPEG, GIF or WebP evidence image within the approved Review scope (maximum 10 MiB).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
];

export function reviewReadDenied(): DynamicToolCallResponse {
  return { success: false, contentItems: [{ type: 'inputText', text: DENIED }] };
}

/** No subprocess, general host tool, or network capability is available here. */
export async function callReviewReadTool(
  name: string,
  args: unknown,
  workingDir: string,
  grants: readonly ReviewReadGrant[],
): Promise<DynamicToolCallResponse> {
  if (!REVIEW_READ_TOOLS.some((tool) => tool.name === name)) return reviewReadDenied();
  if (!args || typeof args !== 'object' || Array.isArray(args)) return reviewReadDenied();
  const input = args as Record<string, unknown>;
  const offset = input.offset ?? 0;
  if (typeof input.path !== 'string' || !Number.isSafeInteger(offset) || Number(offset) < 0
    || Number(offset) > 1_000_000 || Object.keys(input).some((key) => key !== 'path' && key !== 'offset')) {
    return reviewReadDenied();
  }
  // Reject Windows device paths, network shares and alternate data streams
  // before making any filesystem request (including realpath).
  if (process.platform === 'win32' && !isWindowsReviewLocalPath(input.path, workingDir)) {
    return reviewReadDenied();
  }
  try {
    const realPath = await resolveReviewReadPath(input.path, workingDir, grants);
    if (!realPath) return reviewReadDenied();
    const before = await fs.stat(realPath);
    const unchanged = async () => {
      const checked = await resolveReviewReadPath(input.path as string, workingDir, grants);
      if (checked !== realPath) return false;
      const after = await fs.stat(realPath);
      return before.ino !== 0 && before.ino === after.ino && before.dev === after.dev
        && before.nlink === after.nlink && before.mtimeMs === after.mtimeMs;
    };
    if (name === 'review_list_directory') {
      if (!before.isDirectory()) return reviewReadDenied();
      const entries: { name: string; directory: boolean }[] = [];
      let scanned = 0;
      let more = false;
      const directory = await fs.opendir(realPath);
      for await (const entry of directory) {
        if (scanned++ < Number(offset)) continue;
        if (scanned > Number(offset) + PAGE_SIZE) { more = true; break; }
        const resolved = await resolveReviewReadPath(path.join(realPath, entry.name), workingDir, grants);
        if (resolved) entries.push({ name: entry.name, directory: (await fs.stat(resolved)).isDirectory() });
      }
      if (!(await unchanged())) return reviewReadDenied();
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ entries, nextOffset: more ? Number(offset) + PAGE_SIZE : null }) }] };
    }
    if (!before.isFile()) return reviewReadDenied();
    const maxBytes = name === 'review_view_image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (before.size > maxBytes) return reviewReadDenied();
    const file = await fs.open(realPath, 'r');
    let data: Buffer;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || !before.ino || opened.ino !== before.ino || opened.dev !== before.dev
        || opened.nlink !== before.nlink || !(await unchanged())) return reviewReadDenied();
      // Bounded descriptor reads, even if another process grows the file.
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxBytes || !(await unchanged())) return reviewReadDenied();
      data = buffer.subarray(0, size);
    } finally {
      await file.close();
    }
    if (name === 'review_view_image') {
      const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
          : /^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii')) ? 'image/gif'
            : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
      if (!mime) return reviewReadDenied();
      return { success: true, contentItems: [{ type: 'inputImage', imageUrl: `data:${mime};base64,${data.toString('base64')}` }] };
    }
    if (data.includes(0)) return reviewReadDenied();
    const lines = data.toString('utf8').split('\n');
    const start = Number(offset);
    let text = '';
    let end = start;
    for (; end < Math.min(lines.length, start + PAGE_SIZE); end++) {
      // Bound single-line/minified files too. Never silently truncate evidence.
      if (text.length + lines[end].length > 64 * 1024) {
        if (end === start) return reviewReadDenied();
        break;
      }
      text += `${end + 1}: ${lines[end]}\n`;
    }
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ text, nextOffset: end < lines.length ? end : null }) }] };
  } catch {
    // Do not disclose filesystem errors or paths outside the read scope.
    return reviewReadDenied();
  }
}
