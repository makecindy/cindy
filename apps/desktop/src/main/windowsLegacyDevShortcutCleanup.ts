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
// A real `.lnk` is a few KB. Cap how much of a shortcut we ever load so a corrupt
// or hostile oversized file (another installer's broken Start Menu entry) cannot
// make this startup-path maintenance allocate its whole length into memory. The
// 8s cleanup deadline does not cancel an in-flight `fs.readFile`, so an unbounded
// read could keep allocating after cleanup already returned.
export const MAX_SHORTCUT_BYTES = 1_048_576;

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

// Returns the decoded string, or `null` when a NUL terminator is not found
// within bounds. Callers pass an offset already known to be inside the containing
// structure, so `null` specifically means "field present but unterminated"
// (malformed/hostile) — distinct from a field that is simply absent. That
// distinction is load-bearing: silently collapsing a corrupt field to "" and
// building the target from a surviving field can let one field alone forge a
// "...\electron.exe" path and get an unrelated shortcut deleted.
function decodeNullTerminated(
  buffer: Buffer,
  start: number,
  unicode: boolean,
  limit: number,
): string | null {
  // Never read past `limit` (the end of the containing structure). A corrupt
  // `.lnk` can point a path offset past its own structure but still inside the
  // file; without this bound we would decode unrelated bytes as the path.
  const stop = Math.min(limit, buffer.length);
  if (start < 0 || start >= stop) return null;
  if (unicode) {
    for (let end = start; end + 1 < stop; end += 2) {
      if (buffer[end] === 0 && buffer[end + 1] === 0) {
        return buffer.toString('utf16le', start, end);
      }
    }
    return null;
  }
  for (let end = start; end < stop; end += 1) {
    if (buffer[end] === 0) return buffer.toString('latin1', start, end);
  }
  return null;
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

  // LinkInfo: the resolved target for a local file is LocalBasePath (+ optional
  // CommonPathSuffix); for a file on a network share it is the share name from the
  // CommonNetworkRelativeLink (+ the same CommonPathSuffix). Either avoids touching
  // the target volume the way shell resolution does.
  if (flags & FLAG_HAS_LINK_INFO) {
    const linkInfoStart = offset;
    if (linkInfoStart + 4 > buffer.length) return null;
    const linkInfoSize = buffer.readUInt32LE(linkInfoStart);
    if (linkInfoSize < 0x1c || linkInfoStart + linkInfoSize > buffer.length) return null;
    const linkInfoEnd = linkInfoStart + linkInfoSize;
    const headerSize = buffer.readUInt32LE(linkInfoStart + 4);
    const linkInfoFlags = buffer.readUInt32LE(linkInfoStart + 8);
    // The optional unicode offset fields live at bytes [28,36) of the LinkInfo
    // header; only read them when the header (and thus the LinkInfo block, whose
    // size was already validated) actually extends that far. Guarding on
    // linkInfoEnd — not the whole buffer — keeps a bogus headerSize from making us
    // read the following StringData section as offset fields.
    const hasUnicodeOffsets = headerSize >= 0x24 && linkInfoStart + 36 <= linkInfoEnd;
    // A path offset is relative to the LinkInfo start and MUST land inside this
    // structure's data region (after its header, before its end). Anything else
    // is a corrupt/hostile `.lnk`; return an absolute offset only when in range,
    // otherwise -1 so the field is skipped rather than aliasing later bytes.
    const inStructAbs = (rawOffset: number): number =>
      rawOffset >= headerSize && rawOffset < linkInfoSize ? linkInfoStart + rawOffset : -1;

    // Any path field that is present (offset in range) but unterminated makes the
    // whole target untrustworthy — we must skip the shortcut rather than assemble
    // a partial, misleading path (see decodeNullTerminated). `corrupt` latches
    // that condition across every field we touch here.
    let corrupt = false;
    // Reads the path field whose unicode-preferred / ansi offsets sit at the given
    // LinkInfo header positions. Returns '' for a genuinely absent field, and
    // latches `corrupt` (returning '') for a present-but-unterminated one. A
    // corrupt unicode field is NOT retried as ansi: falling back would resurrect
    // exactly the forged-path risk this guards against.
    const readPathField = (unicodeOffsetPos: number, ansiOffsetPos: number): string => {
      if (hasUnicodeOffsets) {
        const abs = inStructAbs(buffer.readUInt32LE(unicodeOffsetPos));
        if (abs >= 0) {
          const decoded = decodeNullTerminated(buffer, abs, true, linkInfoEnd);
          if (decoded === null) corrupt = true;
          return decoded ?? '';
        }
      }
      const abs = inStructAbs(buffer.readUInt32LE(ansiOffsetPos));
      if (abs >= 0) {
        const decoded = decodeNullTerminated(buffer, abs, false, linkInfoEnd);
        if (decoded === null) corrupt = true;
        return decoded ?? '';
      }
      return '';
    };

    // CommonNetworkRelativeLink.NetName — the `\\server\share` target root for a
    // link whose file lives on a network share. Its offsets are relative to the
    // CommonNetworkRelativeLink block, not the LinkInfo header. A flag that
    // promises this block but points nowhere valid latches `corrupt`.
    const readNetworkShareName = (): string => {
      const cnrlAbs = inStructAbs(buffer.readUInt32LE(linkInfoStart + 20));
      if (cnrlAbs < 0 || cnrlAbs + 0x14 > linkInfoEnd) {
        corrupt = true;
        return '';
      }
      const cnrlSize = buffer.readUInt32LE(cnrlAbs);
      const cnrlEnd = cnrlAbs + cnrlSize;
      if (cnrlSize < 0x14 || cnrlEnd > linkInfoEnd) {
        corrupt = true;
        return '';
      }
      const inCnrl = (rawOffset: number): number =>
        rawOffset >= 0x14 && rawOffset < cnrlSize ? cnrlAbs + rawOffset : -1;
      const netNameOffset = buffer.readUInt32LE(cnrlAbs + 8);
      // A NetNameOffset > 0x14 signals an optional unicode NetName at +20.
      if (netNameOffset > 0x14 && cnrlAbs + 24 <= cnrlEnd) {
        const unicodeAbs = inCnrl(buffer.readUInt32LE(cnrlAbs + 20));
        if (unicodeAbs >= 0) {
          const decoded = decodeNullTerminated(buffer, unicodeAbs, true, cnrlEnd);
          if (decoded === null) corrupt = true;
          return decoded ?? '';
        }
      }
      const ansiAbs = inCnrl(netNameOffset);
      if (ansiAbs < 0) {
        corrupt = true;
        return '';
      }
      const decoded = decodeNullTerminated(buffer, ansiAbs, false, cnrlEnd);
      if (decoded === null) corrupt = true;
      return decoded ?? '';
    };

    let base = '';
    if (linkInfoFlags & 0x1) {
      // VolumeIDAndLocalBasePath: LocalBasePath (unicode @ +28 / ansi @ +16).
      base = readPathField(linkInfoStart + 28, linkInfoStart + 16);
    } else if (linkInfoFlags & 0x2) {
      // CommonNetworkRelativeLinkAndPathSuffix: target root is the share name.
      base = readNetworkShareName();
    }

    if (!corrupt && base) {
      // CommonPathSuffix (unicode @ +32 / ansi @ +24) appends to either root.
      const suffix = readPathField(linkInfoStart + 32, linkInfoStart + 24);
      if (!corrupt) target = base + suffix;
    }

    if (corrupt) return null;
    offset = linkInfoEnd;
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

/**
 * Reads a shortcut's raw bytes with a hard size ceiling before parsing. Stats the
 * file first and refuses anything larger than {@link MAX_SHORTCUT_BYTES}, then
 * reads only that many bytes — so the allocation is bounded even if the file grew
 * after the stat. Returns null (skip) for oversized files.
 */
export async function readBoundedShortcut(filePath: string): Promise<LegacyShortcutDetails | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const { size } = await handle.stat();
    if (size > MAX_SHORTCUT_BYTES) return null;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return parseWindowsShortcut(bytesRead === size ? buffer : buffer.subarray(0, bytesRead));
  } finally {
    await handle?.close();
  }
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
    readShortcut: readBoundedShortcut,
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

const DEV_ELECTRON_TARGET_SUFFIX = '\\node_modules\\electron\\dist\\electron.exe';

function isCindyDevCheckoutTarget(target: string): boolean {
  if (!target.endsWith(DEV_ELECTRON_TARGET_SUFFIX)) return false;
  const checkoutDir = target.slice(0, -DEV_ELECTRON_TARGET_SUFFIX.length);
  return (
    /(?:^|\\)(?:cindy|xdt-maker)$/.test(checkoutDir) ||
    /(?:^|\\)(?:cindy|xdt-maker)\\\.(?:cindy|xdt)-worktrees\\[^\\]+$/.test(checkoutDir)
  );
}

function isOwnedArgumentlessDevElectronShortcut(
  shortcutPath: string,
  details: LegacyShortcutDetails,
): boolean {
  if (typeof details.target !== 'string' || details.target.length === 0) return false;
  const target = details.target.replace(/\//g, '\\').toLowerCase();
  // Whitespace-only arguments are equivalent to no arguments — a `.lnk` may store
  // a trailing space or empty COMMAND_LINE_ARGUMENTS, and the legacy dev links we
  // target carry none. Trim before deciding so those are still recognized.
  const hasArgs = (details.args ?? '').trim().length > 0;
  // Electron.lnk is the one generic filename historically registered for Cindy
  // dev, but other Electron apps can create the same link. Require both that name
  // and a Cindy/xdt-maker checkout-shaped target before deleting anything found
  // by the recursive scan. The product-specific XdtMakerDev.lnk is handled by the
  // exact-name fast path above.
  return (
    path.basename(shortcutPath).toLowerCase() === 'electron.lnk' &&
    isCindyDevCheckoutTarget(target) &&
    !hasArgs
  );
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
    if (!details || !isOwnedArgumentlessDevElectronShortcut(shortcutPath, details)) continue;
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
 * name; the recursive fallback only removes the known Electron.lnk shape when
 * its resolved target proves it belongs to a Cindy/xdt-maker development
 * checkout. Slow or redirected Start Menu storage must not delay the rest of
 * application startup.
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
