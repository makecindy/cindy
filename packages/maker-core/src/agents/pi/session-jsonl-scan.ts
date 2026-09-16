import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const ENTRY_PREFIX_CHARS = 4096;

export const MAX_PI_SESSION_JSONL_SCAN_BYTES = 64 * 1024 * 1024;
export const PI_SESSION_JSONL_SCAN_TIMEOUT_MS = 5_000;

export interface PiSessionJsonlScan {
  userEntryIds: Set<string>;
  lastPlanModeEnabled: boolean | null;
}

export type ScanPiSessionJsonlOptions = {
  maxBytes?: number;
  timeoutMs?: number;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function firstQuoted(field: string, prefix: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(prefix);
  return match?.[1];
}

function extractEntryMeta(line: string): {
  type?: string;
  id?: string;
  role?: string;
  customType?: string;
  planEnabled?: boolean;
} {
  const prefix = line.length > ENTRY_PREFIX_CHARS ? line.slice(0, ENTRY_PREFIX_CHARS) : line;
  if (line.length <= 64 * 1024) {
    try {
      const entry = recordOf(JSON.parse(line));
      if (!entry) return {};
      const message = recordOf(entry.message);
      const data = recordOf(entry.data);
      return {
        type: typeof entry.type === 'string' ? entry.type : undefined,
        id: typeof entry.id === 'string' ? entry.id : undefined,
        role: typeof message?.role === 'string' ? message.role : undefined,
        customType: typeof entry.customType === 'string' ? entry.customType : undefined,
        planEnabled: typeof data?.enabled === 'boolean' ? data.enabled : undefined,
      };
    } catch {
      /* fall through to prefix scan for truncated / huge lines */
    }
  }
  return {
    type: firstQuoted('type', prefix),
    id: firstQuoted('id', prefix),
    role: firstQuoted('role', prefix),
    customType: firstQuoted('customType', prefix),
  };
}

function applyEntry(scan: PiSessionJsonlScan, line: string): void {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (trimmed.length === 0) return;
  const meta = extractEntryMeta(trimmed);
  if (meta.type === 'message' && meta.role === 'user' && meta.id) {
    scan.userEntryIds.add(meta.id);
  }
  if (meta.customType === 'plan-mode' && typeof meta.planEnabled === 'boolean') {
    scan.lastPlanModeEnabled = meta.planEnabled;
  }
}

function isInsideDir(dir: string, candidate: string): boolean {
  const relative = path.relative(dir, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * get_state.sessionFile 必须落在启动时钉住的 --session-dir 真身里。
 * 用启动时的 realpath，不跟随后来被换成界外链接的 session-dir。
 */
export async function resolveLocalPiSessionScanFile(
  pinnedRealSessionDir: string,
  sessionFile: string,
): Promise<string | null> {
  if (!pinnedRealSessionDir || !sessionFile) return null;
  const resolvedSessionDir = path.resolve(pinnedRealSessionDir);
  const resolvedFile = path.isAbsolute(sessionFile)
    ? path.resolve(sessionFile)
    : path.resolve(resolvedSessionDir, sessionFile);
  if (!isInsideDir(resolvedSessionDir, resolvedFile)) return null;
  try {
    const listed = await fs.lstat(resolvedFile);
    if (!listed.isFile() || listed.isSymbolicLink()) return null;
    const realFile = await fs.realpath(resolvedFile);
    if (!isInsideDir(resolvedSessionDir, realFile)) return null;
    return realFile;
  } catch {
    return null;
  }
}

/**
 * 只扫 session JSONL 的元数据:user entry id 与最后一条 plan-mode。
 * 不经过 Pi RPC,也不把整段带图历史装进 16 Mi 字符的 JSONL 响应帧。
 * 普通文件仍有字节和时间预算，超限返回 null，由调用方回退 RPC。
 */
export async function scanPiSessionJsonl(
  sessionFile: string,
  options: ScanPiSessionJsonlOptions = {},
): Promise<PiSessionJsonlScan | null> {
  const maxBytes = options.maxBytes ?? MAX_PI_SESSION_JSONL_SCAN_BYTES;
  const timeoutMs = options.timeoutMs ?? PI_SESSION_JSONL_SCAN_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let listedDev = 0n;
  let listedIno = 0n;
  try {
    const listed = await fs.lstat(sessionFile, { bigint: true });
    if (!listed.isFile() || listed.isSymbolicLink() || listed.dev === 0n || listed.ino === 0n) {
      return null;
    }
    listedDev = listed.dev;
    listedIno = listed.ino;
    handle = await fs.open(
      sessionFile,
      fsConstants.O_RDONLY
        | (fsConstants.O_NOFOLLOW ?? 0)
        | (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== listedDev || opened.ino !== listedIno) {
      await handle.close();
      return null;
    }
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
  if (!handle) return null;
  const openedHandle = handle;

  return new Promise((resolve) => {
    const scan: PiSessionJsonlScan = {
      userEntryIds: new Set<string>(),
      lastPlanModeEnabled: null,
    };
    const stream = openedHandle.createReadStream({ autoClose: true });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let prefix = '';
    let skippingRestOfLine = false;
    let bytesRead = 0;
    let settled = false;

    const finish = (result: PiSessionJsonlScan | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    const consumePrefixLine = (): void => {
      if (prefix.length === 0) return;
      applyEntry(scan, prefix);
      prefix = '';
    };

    const emitCompleteLines = (): void => {
      while (true) {
        if (skippingRestOfLine) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) {
            buffer = '';
            return;
          }
          buffer = buffer.slice(newlineIndex + 1);
          skippingRestOfLine = false;
          consumePrefixLine();
          continue;
        }
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          if (buffer.length > ENTRY_PREFIX_CHARS) {
            prefix = buffer.slice(0, ENTRY_PREFIX_CHARS);
            buffer = '';
            skippingRestOfLine = true;
          }
          return;
        }
        applyEntry(scan, buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      bytesRead += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytesRead > maxBytes) {
        finish(null);
        return;
      }
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      emitCompleteLines();
    });
    stream.on('error', () => finish(null));
    stream.on('end', () => {
      buffer += decoder.end();
      emitCompleteLines();
      if (!skippingRestOfLine && buffer.length > 0) applyEntry(scan, buffer);
      else consumePrefixLine();
      finish(scan);
    });
  });
}
