import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

import {
  RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL,
  type BrowserExtensionStoreOpenResult,
} from '../../../shared/browserBackend.js';
import type { ChromiumKind, InstalledChromium } from '../browser-real-profile/types.js';

export interface UserBrowserProcessState {
  /** Whether a main browser process using the normal/default user profile is running. */
  normalRunning: boolean;
  /** Whether a main browser process of the same browser is running with a different --user-data-dir (e.g. Cindy dedicated browser). */
  customProfileRunning: boolean;
  /** macOS-only: PIDs of running normal-profile main browser processes. */
  normalPids?: number[];
  /**
   * Whether the running normal-profile browser currently has at least one real browser window.
   * - `true`: at least one window exists (visible or minimized).
   * - `false`: macOS 0-window Dock shell whose Profile was unloaded by Chromium's
   *   DestroyProfileOnBrowserClose; reopening via `open -g -a` without `-n` wakes the Profile safely.
   * - `undefined`: not determined (non-macOS, browser stopped, or window probe unavailable);
   *   callers treat `undefined` conservatively as having windows.
   */
  hasWindow?: boolean;
}

export interface ProcessCommandEntry {
  pid?: number;
  commandLine: string;
}

export interface OpenExtensionStoreDeps {
  platform?: NodeJS.Platform;
  /** The user's default Chromium browser, else the first installed one; throws when none. */
  resolveBrowser: () => InstalledChromium;
  launch?: (file: string, args: string[]) => Promise<void>;
  /** Override process-table inspection for tests. */
  inspectProcesses?: (
    browser: InstalledChromium,
    platform: NodeJS.Platform,
  ) => Promise<UserBrowserProcessState>;
  /** Override raw command-line listing for tests. */
  listProcessCommandLines?: (
    browser: InstalledChromium,
    platform: NodeJS.Platform,
  ) => Promise<string[] | null>;
  /** Override PID + command-line listing for tests. */
  listProcesses?: (
    browser: InstalledChromium,
    platform: NodeJS.Platform,
  ) => Promise<ProcessCommandEntry[] | null>;
  /** Override macOS CoreGraphics window-existence probe for tests. */
  hasBrowserWindow?: (
    pids: readonly number[],
    browser: InstalledChromium,
    platform: NodeJS.Platform,
  ) => Promise<boolean | undefined>;
}

const LINUX_BINARY_NAMES: Record<ChromiumKind, readonly string[]> = {
  chrome: ['chrome', 'google-chrome', 'google-chrome-stable'],
  edge: ['msedge', 'microsoft-edge', 'microsoft-edge-stable'],
  brave: ['brave', 'brave-browser', 'brave-browser-stable'],
  chromium: ['chromium', 'chromium-browser'],
};

const CHILD_PROCESS_FLAG_RE = /(?:^|\s)--type=/;
const USER_DATA_DIR_FLAG_RE = /(?:^|\s)--user-data-dir(?:=|\s+)/;

function normalizeProfileDir(dir: string, platform: NodeJS.Platform): string {
  const osPath = platform === 'win32' ? path.win32 : path.posix;
  const trimmed = dir.trim().replace(/^["']|["']$/g, '');
  const resolved = osPath.resolve(trimmed).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function extractUserDataDir(commandLine: string): string | null {
  const match = USER_DATA_DIR_FLAG_RE.exec(commandLine);
  if (!match) return null;
  const rest = commandLine.slice(match.index + match[0].length);
  if (!rest) return null;
  const first = rest[0];
  if (first === '"' || first === "'") {
    const end = rest.indexOf(first, 1);
    return end > 1 ? rest.slice(1, end) : rest.slice(1);
  }
  // On POSIX `ps -axo args=`, spaces inside paths (e.g. "Application Support") are unquoted;
  // consume until the next `--flag` token or end of line.
  const nextFlag = rest.search(/\s+--/);
  return (nextFlag === -1 ? rest : rest.slice(0, nextFlag)).trim() || null;
}

function splitExecutableToken(commandLine: string): { token: string; rest: string } {
  const trimmed = commandLine.trim();
  if (!trimmed) return { token: '', rest: '' };
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) {
      return { token: trimmed.slice(1, end), rest: trimmed.slice(end + 1) };
    }
  }
  const space = trimmed.search(/\s/);
  if (space === -1) return { token: trimmed, rest: '' };
  return { token: trimmed.slice(0, space), rest: trimmed.slice(space) };
}

function matchesBrowserMainExecutable(
  commandLine: string,
  browser: InstalledChromium,
  platform: NodeJS.Platform,
): { matched: boolean; rest: string } {
  const trimmed = commandLine.trim();
  if (!trimmed) return { matched: false, rest: '' };
  const execPath = browser.executablePath;

  if (platform === 'darwin') {
    // macOS `ps -axo args=` prints unquoted executable paths with spaces
    // (e.g. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flag`).
    const unquoted =
      trimmed.startsWith(`"${execPath}"`)
        ? { matched: true, rest: trimmed.slice(execPath.length + 2) }
        : trimmed === execPath || trimmed.startsWith(`${execPath} `)
          ? { matched: true, rest: trimmed.slice(execPath.length) }
          : null;
    if (unquoted && (unquoted.rest === '' || /^\s/.test(unquoted.rest))) {
      return unquoted;
    }
    return { matched: false, rest: '' };
  }

  if (platform === 'win32') {
    const { token, rest } = splitExecutableToken(trimmed);
    const normalizedToken = token.toLowerCase();
    const normalizedExec = execPath.toLowerCase();
    const expectedBase = path.win32.basename(execPath).toLowerCase();
    const tokenBase = path.win32.basename(token).toLowerCase();
    // Unquoted paths with spaces (e.g. C:\Program Files\Google\Chrome\Application\chrome.exe --flag)
    if (
      trimmed.toLowerCase() === normalizedExec ||
      trimmed.toLowerCase().startsWith(`${normalizedExec} `)
    ) {
      return { matched: true, rest: trimmed.slice(execPath.length) };
    }
    if (normalizedToken === normalizedExec || (expectedBase && tokenBase === expectedBase)) {
      return { matched: true, rest };
    }
    return { matched: false, rest: '' };
  }

  // Linux: match either exact executablePath or the known unwrapped binary basename
  // (e.g. `/usr/bin/google-chrome-stable` execs `/opt/google/chrome/chrome`).
  if (trimmed === execPath || trimmed.startsWith(`${execPath} `)) {
    return { matched: true, rest: trimmed.slice(execPath.length) };
  }
  const { token, rest } = splitExecutableToken(trimmed);
  if (token === execPath) return { matched: true, rest };
  const base = path.posix.basename(token);
  if (LINUX_BINARY_NAMES[browser.kind].includes(base)) {
    return { matched: true, rest };
  }
  return { matched: false, rest: '' };
}

/**
 * Pure classifier over OS process entries: distinguishes a running normal-profile
 * user browser from a dedicated-profile instance (e.g. Cindy's `external` Chrome launched
 * with `--user-data-dir=<cindy-runtime>`). Helper/renderer/GPU/crashpad child processes
 * (`--type=...`) are ignored.
 */
export function classifyChromiumProcessEntries(
  entries: readonly ProcessCommandEntry[],
  browser: InstalledChromium,
  platform: NodeJS.Platform = process.platform,
): UserBrowserProcessState {
  let normalRunning = false;
  let customProfileRunning = false;
  const normalPids = new Set<number>();
  const expectedDefaultDir = normalizeProfileDir(browser.userDataDir, platform);

  for (const entry of entries) {
    const { matched, rest } = matchesBrowserMainExecutable(entry.commandLine, browser, platform);
    if (!matched) continue;
    if (CHILD_PROCESS_FLAG_RE.test(rest)) continue;
    const customDir = extractUserDataDir(rest);
    if (!customDir || normalizeProfileDir(customDir, platform) === expectedDefaultDir) {
      normalRunning = true;
      if (typeof entry.pid === 'number' && Number.isSafeInteger(entry.pid) && entry.pid > 0) {
        normalPids.add(entry.pid);
      }
    } else {
      customProfileRunning = true;
    }
  }
  return {
    normalRunning,
    customProfileRunning,
    ...(normalPids.size > 0 ? { normalPids: [...normalPids] } : {}),
  };
}

export function classifyChromiumProcesses(
  commandLines: readonly string[],
  browser: InstalledChromium,
  platform: NodeJS.Platform = process.platform,
): Pick<UserBrowserProcessState, 'normalRunning' | 'customProfileRunning'> {
  const { normalRunning, customProfileRunning } = classifyChromiumProcessEntries(
    commandLines.map((commandLine) => ({ commandLine })),
    browser,
    platform,
  );
  return { normalRunning, customProfileRunning };
}

function defaultListProcesses(
  browser: InstalledChromium,
  platform: NodeJS.Platform,
): Promise<ProcessCommandEntry[] | null> {
  if (platform === 'win32') {
    const exeName = path.win32.basename(browser.executablePath);
    if (!/^[a-zA-Z0-9._-]+$/.test(exeName)) return Promise.resolve(null);
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | ` +
      'ForEach-Object { if ($_.CommandLine) { $_.CommandLine } }';
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) return resolve(null);
          resolve(
            stdout
              .split(/\r?\n/)
              .filter((line) => line.trim().length > 0)
              .map((commandLine) => ({ commandLine })),
          );
        },
      );
    });
  }
  const psBin = platform === 'darwin' ? '/bin/ps' : 'ps';
  const psArgs = platform === 'darwin' ? ['-axo', 'pid=,args='] : ['-axo', 'args='];
  return new Promise((resolve) => {
    execFile(
      psBin,
      psArgs,
      { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        const entries: ProcessCommandEntry[] = [];
        for (const raw of stdout.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line) continue;
          if (platform === 'darwin') {
            const match = /^(\d+)\s+(.+)$/.exec(line);
            if (!match) continue;
            entries.push({ pid: Number(match[1]), commandLine: match[2] });
          } else {
            entries.push({ commandLine: line });
          }
        }
        resolve(entries);
      },
    );
  });
}

/**
 * macOS zero-TCC window-existence probe via CoreGraphics (`CGWindowListCopyWindowInfo`).
 * Distinguishes a real browser window (visible or minimized: layer 0, alpha > 0, >= 100x100)
 * from Chromium's 1x1 sentinel and menu-bar overlay strips, without invoking AppleScript/TCC
 * Automation prompts. Returns `undefined` when indeterminate so callers fail conservatively.
 */
function defaultHasBrowserWindow(
  pids: readonly number[],
  _browser: InstalledChromium,
  platform: NodeJS.Platform,
): Promise<boolean | undefined> {
  if (platform !== 'darwin') return Promise.resolve(undefined);
  const validPids = pids.filter((p) => Number.isSafeInteger(p) && p > 0);
  if (validPids.length === 0) return Promise.resolve(undefined);
  const script =
    'ObjC.import("CoreGraphics"); ObjC.import("Foundation");' +
    `const pids = new Set([${validPids.join(',')}]);` +
    'const ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID);' +
    'if (!ref) { "unknown"; } else {' +
    '  const arr = ObjC.deepUnwrap(ObjC.castRefToObject(ref));' +
    '  if (!Array.isArray(arr)) { "unknown"; } else {' +
    '    const found = arr.some(w => {' +
    '      if (!w || !pids.has(Number(w.kCGWindowOwnerPID))) return false;' +
    '      if (Number(w.kCGWindowLayer) !== 0) return false;' +
    '      if (!(Number(w.kCGWindowAlpha) > 0)) return false;' +
    '      const b = w.kCGWindowBounds;' +
    '      return Number(b && b.Width || 0) >= 100 && Number(b && b.Height || 0) >= 100;' +
    '    });' +
    '    found ? "yes" : "no";' +
    '  }' +
    '}';
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: 3_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const out = stdout.trim();
        if (out === 'yes') return resolve(true);
        if (out === 'no') return resolve(false);
        return resolve(undefined);
      },
    );
  });
}

export async function inspectUserBrowserProcesses(
  deps: Pick<
    OpenExtensionStoreDeps,
    'platform' | 'resolveBrowser' | 'listProcessCommandLines' | 'listProcesses' | 'hasBrowserWindow'
  >,
): Promise<UserBrowserProcessState> {
  let browser: InstalledChromium;
  try {
    browser = deps.resolveBrowser();
  } catch {
    return { normalRunning: false, customProfileRunning: false };
  }
  const platform = deps.platform ?? process.platform;
  const entries = deps.listProcesses
    ? await deps.listProcesses(browser, platform).catch(() => null)
    : deps.listProcessCommandLines
      ? await deps
          .listProcessCommandLines(browser, platform)
          .then((lines) => (lines ? lines.map((commandLine) => ({ commandLine })) : null))
          .catch(() => null)
      : await defaultListProcesses(browser, platform).catch(() => null);
  if (!entries) return { normalRunning: false, customProfileRunning: false };
  const state = classifyChromiumProcessEntries(entries, browser, platform);
  if (state.normalRunning && platform === 'darwin') {
    const pids = state.normalPids ?? [];
    const probe = deps.hasBrowserWindow ?? (pids.length > 0 ? defaultHasBrowserWindow : undefined);
    if (probe) {
      const hasWindow = await probe(pids, browser, platform).catch(() => undefined);
      if (typeof hasWindow === 'boolean') {
        return { ...state, hasWindow };
      }
    }
  }
  return state;
}

/** Whether the user's normal-profile Chromium browser is currently running. */
export async function isUserBrowserRunning(
  deps: Pick<
    OpenExtensionStoreDeps,
    'platform' | 'resolveBrowser' | 'listProcessCommandLines' | 'listProcesses' | 'hasBrowserWindow'
  >,
): Promise<boolean> {
  const state = await inspectUserBrowserProcesses(deps);
  return state.normalRunning;
}

function defaultLaunch(file: string, args: string[]): Promise<void> {
  if (file === '/usr/bin/open') {
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 15_000 }, (error) => (error ? reject(error) : resolve()));
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Open the official Cindy extension's store page in the browser the user actually uses, so
 * "My browser" can be finished from Settings. The store still asks the user to confirm Add;
 * Settings notices the connection on its own once the extension is in.
 */
export async function openExtensionStoreInUserBrowser(
  deps: OpenExtensionStoreDeps,
): Promise<BrowserExtensionStoreOpenResult> {
  let browser: InstalledChromium;
  try {
    browser = deps.resolveBrowser();
  } catch {
    return { ok: false, error: 'NO_CHROMIUM' };
  }
  const platform = deps.platform ?? process.platform;
  const launch = deps.launch ?? defaultLaunch;
  const url = RECOMMENDED_PAGE_CONTROL_EXTENSION_STORE_URL;
  // On macOS hand the URL to the app bundle so an already running browser opens it as a tab.
  const appBundle = platform === 'darwin' ? /^(.*?\.app)\//.exec(browser.executablePath)?.[1] : undefined;
  try {
    if (appBundle) await launch('/usr/bin/open', ['-a', appBundle, url]);
    else await launch(browser.executablePath, [url]);
    return { ok: true };
  } catch {
    return { ok: false, error: 'OPEN_FAILED' };
  }
}

/** Start the normal browser without navigating or changing its profile.
 * Use normal profile startup so extensions initialize too. Never use --user-data-dir or a debugging port here.
 *
 * macOS nuances:
 * - If the normal-profile browser is already running with an open window (or window state is unknown),
 *   do NOT spawn a duplicate instance (using `-n` causes ProcessSingleton conflicts, Dock flashing, and crashes).
 * - If the normal-profile browser is running with 0 windows (`hasWindow === false`), macOS kept the
 *   process in the Dock while Chromium's DestroyProfileOnBrowserClose unloaded the Profile and all
 *   extensions. Sending `open -g -a <appBundle>` WITHOUT `-n` safely reopens the existing instance in
 *   the background so it creates a window and reloads the Profile + extensions without a duplicate process.
 * - Only pass `-n` on macOS when a dedicated-profile instance of the same `.app` bundle (e.g. Cindy's
 *   external browser) is running while the normal-profile browser is NOT running, so LaunchServices
 *   cannot swallow the launch into the dedicated profile.
 * - Never pass `--start-minimized` on macOS (it is a Windows Chromium flag).
 */
export async function startUserBrowser(deps: OpenExtensionStoreDeps): Promise<void> {
  let browser: InstalledChromium;
  try { browser = deps.resolveBrowser(); }
  catch { throw new Error('未找到可用的 Chrome / Edge，请先安装浏览器。'); }
  const platform = deps.platform ?? process.platform;
  const processState: UserBrowserProcessState = deps.inspectProcesses
    ? await deps.inspectProcesses(browser, platform).catch(
        (): UserBrowserProcessState => ({
          normalRunning: false,
          customProfileRunning: false,
        }),
      )
    : await inspectUserBrowserProcesses({
        platform,
        resolveBrowser: () => browser,
        listProcessCommandLines: deps.listProcessCommandLines,
        listProcesses: deps.listProcesses,
        hasBrowserWindow: deps.hasBrowserWindow,
      });
  const wakeZeroWindowMac =
    platform === 'darwin' && processState.normalRunning && processState.hasWindow === false;
  if (processState.normalRunning && !wakeZeroWindowMac) return;
  const appBundle = platform === 'darwin' ? /^(.*?\.app)\//.exec(browser.executablePath)?.[1] : undefined;
  const launch = deps.launch ?? defaultLaunch;
  try {
    if (appBundle) {
      const openArgs =
        !wakeZeroWindowMac && processState.customProfileRunning
          ? ['-g', '-n', '-a', appBundle]
          : ['-g', '-a', appBundle];
      await launch('/usr/bin/open', openArgs);
    } else {
      await launch(browser.executablePath, ['--start-minimized']);
    }
  } catch { throw new Error('未能启动浏览器，请检查 Chrome / Edge 是否可以正常打开。'); }
}
