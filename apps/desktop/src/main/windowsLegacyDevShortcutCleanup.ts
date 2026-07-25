/**
 * Removes legacy development shortcuts that launch Electron without app args.
 *
 * This runs during Windows startup before notifications are initialized. Keep
 * it free of script hosts: spawning PowerShell here is both unnecessary
 * (a `.lnk` is a documented binary format) and prone to security-product alerts.
 *
 * Shortcut resolution also stays off Electron's synchronous shell shortcut
 * reader: that API resolves links synchronously on the main thread and may touch
 * the (possibly redirected or high-latency) target volume, so a single slow call
 * cannot be interrupted by the cleanup deadline and would freeze startup. Instead
 * we read the raw bytes with async fs and decode only the stored target/arguments,
 * so the main thread performs at most a microsecond-scale in-memory parse.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { app } from 'electron';
import { createLogger } from './logger';

const log = createLogger('legacyDevShortcutCleanup');
const CLEANUP_TIMEOUT_MS = 8_000;

interface ShortcutDirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface LegacyShortcutDetails {
  target: string;
  args: string;
}

export interface LegacyDevShortcutCleanupDeps {
  platform: NodeJS.Platform;
  appDataDir: () => string | null;
  exists: (filePath: string) => Promise<boolean>;
  readdir: (dirPath: string) => Promise<ShortcutDirEntry[]>;
  unlink: (filePath: string) => Promise<void>;
  readShortcut: (filePath: string) => Promise<LegacyShortcutDetails | null>;
  logger?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>;
}

// [MS-SHLLINK] ShellLinkHeader is a fixed 0x4C-byte prefix whose LinkCLSID is the
// packed GUID {00021401-0000-0000-C000-000000000046}.
const SHELL_LINK_HEADER_SIZE = 0x4c;
const SHELL_LINK_CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]);

// [MS-SHLLINK] LinkFlags bits used here.
const FLAG_HAS_LINK_TARGET_ID_LIST = 0x0000_0001;
const FLAG_HAS_LINK_INFO = 0x0000_0002;
const FLAG_HAS_NAME = 0x0000_0004;
const FLAG_HAS_RELATIVE_PATH = 0x0000_0008;
const FLAG_HAS_WORKING_DIR = 0x0000_0010;
const FLAG_HAS_ARGUMENTS = 0x0000_0020;
const FLAG_IS_UNICODE = 0x0000_0080;

function decodeNullTerminated(buffer: Buffer, start: number, unicode: boolean): string {
  if (start < 0 || start >= buffer.length) return '';
  if (unicode) {
    let end = start;
    while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) end += 2;
    return buffer.toString('utf16le', start, end);
  }
  let end = start;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return buffer.toString('latin1', start, end);
}

/**
 * Decodes the stored target path and command-line arguments from raw `.lnk`
 * bytes. Best-effort and defensive: any structural anomaly yields `null` (or an
 * empty field) rather than throwing, so a malformed shortcut is simply skipped.
 * We only need enough of [MS-SHLLINK] to recognize an argumentless dev Electron
 * link, not a faithful round-trip of every field.
 */
export function parseWindowsShortcut(buffer: Buffer): LegacyShortcutDetails | null {
  if (buffer.length < SHELL_LINK_HEADER_SIZE) return null;
  if (buffer.readUInt32LE(0) !== SHELL_LINK_HEADER_SIZE) return null;
  if (!buffer.subarray(4, 20).equals(SHELL_LINK_CLSID)) return null;

  const flags = buffer.readUInt32LE(20);
  const unicode = (flags & FLAG_IS_UNICODE) !== 0;
  let offset = SHELL_LINK_HEADER_SIZE;

  // LinkTargetIDList: a 2-byte size prefix + IDList. We only need to skip it.
  if (flags & FLAG_HAS_LINK_TARGET_ID_LIST) {
    if (offset + 2 > buffer.length) return null;
    const idListSize = buffer.readUInt16LE(offset);
    offset += 2 + idListSize;
    if (offset > buffer.length) return null;
  }

  let target = '';

  // LinkInfo: LocalBasePath (+ CommonPathSuffix) is the resolved target for a
  // local file, without touching the target volume the way shell resolution does.
  if (flags & FLAG_HAS_LINK_INFO) {
    const linkInfoStart = offset;
    if (linkInfoStart + 4 > buffer.length) return null;
    const linkInfoSize = buffer.readUInt32LE(linkInfoStart);
    if (linkInfoSize < 0x1c || linkInfoStart + linkInfoSize > buffer.length) return null;
    const headerSize = buffer.readUInt32LE(linkInfoStart + 4);
    const linkInfoFlags = buffer.readUInt32LE(linkInfoStart + 8);
    if (linkInfoFlags & 0x1) {
      // VolumeIDAndLocalBasePath present.
      const basePathOffset = buffer.readUInt32LE(linkInfoStart + 16);
      const suffixOffset = buffer.readUInt32LE(linkInfoStart + 24);
      let base = '';
      let suffix = '';
      if (headerSize >= 0x24 && linkInfoStart + 36 <= buffer.length) {
        const basePathOffsetUnicode = buffer.readUInt32LE(linkInfoStart + 28);
        const suffixOffsetUnicode = buffer.readUInt32LE(linkInfoStart + 32);
        if (basePathOffsetUnicode) {
          base = decodeNullTerminated(buffer, linkInfoStart + basePathOffsetUnicode, true);
        }
        if (suffixOffsetUnicode) {
          suffix = decodeNullTerminated(buffer, linkInfoStart + suffixOffsetUnicode, true);
        }
      }
      if (!base && basePathOffset) {
        base = decodeNullTerminated(buffer, linkInfoStart + basePathOffset, false);
      }
      if (!suffix && suffixOffset) {
        suffix = decodeNullTerminated(buffer, linkInfoStart + suffixOffset, false);
      }
      target = base + suffix;
    }
    offset = linkInfoStart + linkInfoSize;
  }

  // StringData: NAME, RELATIVE_PATH, WORKING_DIR, COMMAND_LINE_ARGUMENTS,
  // ICON_LOCATION — each a 2-byte character count followed by the string.
  const readStringData = (): string | null => {
    if (offset + 2 > buffer.length) return null;
    const count = buffer.readUInt16LE(offset);
    offset += 2;
    const byteLength = unicode ? count * 2 : count;
    if (offset + byteLength > buffer.length) return null;
    const value = buffer.toString(unicode ? 'utf16le' : 'latin1', offset, offset + byteLength);
    offset += byteLength;
    return value;
  };

  let relativePath = '';
  let args = '';
  if (flags & FLAG_HAS_NAME && readStringData() === null) return null;
  if (flags & FLAG_HAS_RELATIVE_PATH) {
    const value = readStringData();
    if (value === null) return null;
    relativePath = value;
  }
  if (flags & FLAG_HAS_WORKING_DIR && readStringData() === null) return null;
  if (flags & FLAG_HAS_ARGUMENTS) {
    const value = readStringData();
    if (value === null) return null;
    args = value;
  }

  // A relative path preserves the trailing "...\electron.exe" segment, which is
  // all the classifier needs, so it is an adequate fallback when LinkInfo is absent.
  if (!target && relativePath) target = relativePath;
  if (!target) return null;
  return { target, args };
}

function defaultDeps(): LegacyDevShortcutCleanupDeps {
  return {
    platform: process.platform,
    appDataDir: () => {
      try {
        return app.getPath('appData');
      } catch {
        return null;
      }
    },
    exists: async (filePath) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    readdir: (dirPath) => fs.readdir(dirPath, { withFileTypes: true }),
    unlink: (filePath) => fs.unlink(filePath),
    readShortcut: async (filePath) => parseWindowsShortcut(await fs.readFile(filePath)),
    logger: log,
  };
}

async function collectShortcutFiles(
  deps: LegacyDevShortcutCleanupDeps,
  rootDir: string,
  shouldStop: () => boolean,
): Promise<string[]> {
  const shortcuts: string[] = [];
  const pending = [rootDir];

  while (pending.length > 0 && !shouldStop()) {
    const dirPath = pending.pop()!;
    let entries: ShortcutDirEntry[];
    try {
      entries = await deps.readdir(dirPath);
    } catch {
      // Start Menu may contain protected or concurrently removed directories.
      continue;
    }
    if (shouldStop()) break;
    for (const entry of entries) {
      if (shouldStop()) break;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.lnk') {
        shortcuts.push(entryPath);
      }
    }
  }

  return shortcuts;
}

function isArgumentlessDevElectronShortcut(details: LegacyShortcutDetails): boolean {
  if (typeof details.target !== 'string' || details.target.length === 0) return false;
  const target = details.target.replace(/\//g, '\\').toLowerCase();
  // Whitespace-only arguments are equivalent to no arguments — a `.lnk` may store
  // a trailing space or empty COMMAND_LINE_ARGUMENTS, and the legacy dev links we
  // target carry none. Trim before deciding so those are still recognized.
  const hasArgs = (details.args ?? '').trim().length > 0;
  return target.endsWith('\\node_modules\\electron\\dist\\electron.exe') && !hasArgs;
}

async function runCleanup(
  deps: LegacyDevShortcutCleanupDeps,
  appData: string,
  shouldStop: () => boolean,
): Promise<void> {
  const startMenuDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  let removed = 0;

  if (shouldStop()) return;
  const knownShortcut = path.join(startMenuDir, 'XdtMakerDev.lnk');
  try {
    const exists = await deps.exists(knownShortcut);
    if (shouldStop()) return;
    if (exists) {
      await deps.unlink(knownShortcut);
      if (shouldStop()) return;
      removed += 1;
    }
  } catch (err) {
    deps.logger?.warn('failed to remove known legacy dev shortcut', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (shouldStop()) return;
  const shortcutFiles = await collectShortcutFiles(deps, startMenuDir, shouldStop);
  if (shouldStop()) return;
  for (const shortcutPath of shortcutFiles) {
    if (shouldStop()) return;
    let details: LegacyShortcutDetails | null;
    try {
      // Async byte read + in-memory parse; unlike the synchronous shell reader
      // this yields to the deadline instead of blocking the main thread.
      details = await deps.readShortcut(shortcutPath);
    } catch {
      continue;
    }
    if (shouldStop()) return;
    if (!details || !isArgumentlessDevElectronShortcut(details)) continue;
    try {
      await deps.unlink(shortcutPath);
      if (shouldStop()) return;
      removed += 1;
    } catch (err) {
      deps.logger?.warn('failed to remove scanned legacy dev shortcut', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (shouldStop()) return;
  if (removed > 0) {
    deps.logger?.info('legacy dev shortcut cleanup applied', { removed });
  }
}

/**
 * Best-effort cleanup entrypoint. The known SnoreToast shortcut is removed by
 * name; the recursive fallback only removes argumentless links whose resolved
 * target is a development Electron binary. Slow or redirected Start Menu
 * storage must not delay the rest of application startup.
 */
export async function cleanupLegacyDevShortcuts(
  overrides?: Partial<LegacyDevShortcutCleanupDeps>,
): Promise<void> {
  const deps: LegacyDevShortcutCleanupDeps = { ...defaultDeps(), ...overrides };
  if (deps.platform !== 'win32') return;

  const appData = deps.appDataDir();
  if (!appData) return;

  const deadlineAt = Date.now() + CLEANUP_TIMEOUT_MS;
  let expired = false;
  const expire = (): void => {
    if (expired) return;
    expired = true;
    deps.logger?.warn('legacy dev shortcut cleanup timed out; continuing startup', {
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });
  };
  const shouldStop = (): boolean => {
    if (!expired && Date.now() >= deadlineAt) expire();
    return expired;
  };
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      expire();
      resolve();
    }, CLEANUP_TIMEOUT_MS);
  });

  try {
    await Promise.race([runCleanup(deps, appData, shouldStop), timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
