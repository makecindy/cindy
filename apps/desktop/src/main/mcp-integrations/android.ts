import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { app } from 'electron';
import JSZip from 'jszip';
import type {
  AndroidAdbPathSource,
  AndroidAdbPreparationState,
  AndroidConnectedDevice,
  AndroidCurrentAppState,
  AndroidDeviceStateResult,
  AndroidMcpCallContext,
  AndroidMcpDeps,
  AndroidMcpErrorCode,
  AndroidMcpToolName,
  AndroidScreenState,
  AndroidStatusSummary,
  AndroidUiNode,
} from '@cindy/mcps';
import {
  readAndroidAutomationSettings,
  type AndroidAutomationSettings,
} from '../android-automation-settings-store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('mcp/cindy_android');

const ADB_COMMAND = 'adb';
const BUNDLED_ANDROID_PLATFORM_TOOLS_RESOURCE_ROOT = ['tools', 'android-platform-tools'];
const BUNDLED_ANDROID_PLATFORM_TOOLS_SOURCE_ROOT = ['apps', 'android-platform-tools-bin'];
const PREPARED_ANDROID_PLATFORM_TOOLS_ROOT = 'android-platform-tools';
const MAX_PLATFORM_TOOLS_ZIP_BYTES = 256 * 1024 * 1024;
const DEFAULT_PLATFORM_TOOLS_DOWNLOAD_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 3_000;
const ADB_COLD_START_TIMEOUT_MS = 15_000;
const ADB_COLD_START_POLL_INTERVAL_MS = 250;
const CALL_TIMEOUT_MS = 20_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 512 * 1024;
const MAX_UI_NODES = 200;
const ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;
const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
// 与旧写法 (?:\.[A-Za-z0-9_.]+)+ 语言等价:内层字符类本就含 '.',外层 '+' 只带来
// 指数回溯(CodeQL js/redos),去掉后接受的字符串集合不变。
const ANDROID_ACTIVITY_RE = /^(?:\.[A-Za-z0-9_.]+|[A-Za-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+)$/;
const SAFE_ADB_INPUT_TEXT_RE = /^[A-Za-z0-9 .,:@/_+=%+-]+$/;

const PLATFORM_TOOLS_DOWNLOADS: Record<string, { url: string }> = {
  'darwin-arm64': { url: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip' },
  'darwin-x64': { url: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip' },
  'linux-x64': { url: 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip' },
  'win32-x64': { url: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' },
};

interface AndroidStateSnapshot {
  sessionId: string;
  deviceSerial: string;
  screen: AndroidScreenState;
  nodes: AndroidUiNode[];
  capturedAt: number;
}

const KEYEVENT_CODE: Record<string, string> = {
  BACK: '4',
  HOME: '3',
  ENTER: '66',
  APP_SWITCH: '187',
  POWER: '26',
  DPAD_UP: '19',
  DPAD_DOWN: '20',
  DPAD_LEFT: '21',
  DPAD_RIGHT: '22',
  DPAD_CENTER: '23',
};

interface ExecResult {
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
  exitCode: number | null;
}

interface AndroidToolOk<T> {
  ok: true;
  data: T;
}

interface AndroidToolErr {
  ok: false;
  errorCode: AndroidMcpErrorCode;
  message: string;
  data?: Record<string, unknown>;
}

type AndroidToolResult<T> = AndroidToolOk<T> | AndroidToolErr;

export interface AndroidMcpDepsOptions {
  isAndroidAutomationEnabled?: (context?: AndroidMcpCallContext) => boolean;
}

interface AdbCandidate {
  command: string;
  source: AndroidAdbPathSource;
  strict?: boolean;
}

interface ResolvedAdbCommand {
  command: string;
  source: AndroidAdbPathSource;
  signature?: string;
  probeResult?: ExecResult;
}

const latestStateSnapshots = new Map<string, AndroidStateSnapshot>();
let runnableAdbCache: ResolvedAdbCommand | null = null;
const adbDeviceListRequests = new Map<string, Promise<AndroidConnectedDevice[]>>();
let platformToolsDownloadTimeoutMs = DEFAULT_PLATFORM_TOOLS_DOWNLOAD_TIMEOUT_MS;
/** 本会话用「我们分发的 adb」(bundled/prepared)跑过命令时记录其路径,退出时 kill-server 用。 */
let managedAdbCommandUsed: string | null = null;
/**
 * 我们第一次使用 bundled/prepared adb 时,5037 端口上是否已有 server 在跑。
 * true = 有预存 server(别人的,不能杀);false = 没有(我们 fork 的,退出时可杀);
 * null = 尚未检测。检测一次后不再变,保证整个会话的语义一致。
 */
let serverPreExistedBeforeUs: boolean | null = null;

export function clearAndroidStateSnapshotsForTest(): void {
  latestStateSnapshots.clear();
  runnableAdbCache = null;
  adbDeviceListRequests.clear();
  platformToolsDownloadTimeoutMs = DEFAULT_PLATFORM_TOOLS_DOWNLOAD_TIMEOUT_MS;
  managedAdbCommandUsed = null;
  serverPreExistedBeforeUs = null;
}

export function setServerPreExistedForTest(value: boolean | null): void {
  serverPreExistedBeforeUs = value;
}

/**
 * App 退出清理(bootstrap 的 onQuit 链调用,sync 阶段):如果本会话确实 fork 了
 * 自己的 adb server 守护进程(即首次使用 bundled/prepared adb 时 5037 上没有
 * 已有 server),fire-and-forget 一个 `adb kill-server` 收掉它。detached + unref,
 * 绝不阻塞退出。
 *
 * 如果用户在 XDMaker 之前已有 server 在跑(Android Studio / SDK 等),我们的
 * bundled adb 只是复用了它,此时 kill-server 会杀掉用户的 server、中断其 logcat
 * / 设备连接——这种情况不触发 kill。判断依据是首次使用前对 5037 端口的探活结果,
 * 记录在 serverPreExistedBeforeUs 中(一次检测,整个会话生效)。
 */
export function disposeAndroidAdb(): void {
  const command = managedAdbCommandUsed;
  if (!command) return;
  managedAdbCommandUsed = null;

  if (serverPreExistedBeforeUs) {
    logger.info('quit cleanup: skipping kill-server — server pre-existed before our usage', { command });
    return;
  }

  try {
    logger.info('quit cleanup: adb kill-server', { command });
    spawn(command, ['kill-server'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    logger.warn('quit cleanup adb kill-server failed (ignored)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}


export function setAndroidPlatformToolsDownloadTimeoutForTest(timeoutMs: number | null): void {
  platformToolsDownloadTimeoutMs = timeoutMs ?? DEFAULT_PLATFORM_TOOLS_DOWNLOAD_TIMEOUT_MS;
}

class AndroidDriverError extends Error {
  readonly errorCode: AndroidMcpErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(
    errorCode: AndroidMcpErrorCode,
    message: string,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AndroidDriverError';
    this.errorCode = errorCode;
    this.data = data;
  }
}

/** Identifies a timed-out adb child process without relying on its user-facing message. */
class AdbCommandTimeoutError extends AndroidDriverError {
  readonly args: readonly string[];

  constructor(args: string[], timeoutMs: number) {
    super(
      'ANDROID_DRIVER_ERROR',
      `adb ${args.join(' ')} timed out after ${timeoutMs}ms`,
    );
    this.name = 'AdbCommandTimeoutError';
    this.args = [...args];
  }
}

function isAdbCommandTimeoutFor(err: unknown, args: readonly string[]): boolean {
  return err instanceof AdbCommandTimeoutError
    && err.args.length === args.length
    && err.args.every((arg, index) => arg === args[index]);
}

let readSettings = readAndroidAutomationSettings;

export function setAndroidAutomationSettingsReaderForTest(
  reader: (() => AndroidAutomationSettings) | null,
): void {
  readSettings = reader ?? readAndroidAutomationSettings;
}

function getAndroidSettings(): AndroidAutomationSettings {
  try {
    return readSettings();
  } catch (err) {
    logger.warn('Android automation settings read failed; using defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { defaultDeviceSerial: null, adbPathOverride: null };
  }
}

function adbExecutableName(): string {
  return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

function platformToolsKey(): string | null {
  if (process.platform === 'win32') return 'win32-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  return null;
}

function preparedPlatformToolsInstallRoot(key: string): string {
  return path.join(app.getPath('userData'), PREPARED_ANDROID_PLATFORM_TOOLS_ROOT, key);
}

function preparedAdbPath(key: string): string {
  return path.join(preparedPlatformToolsInstallRoot(key), 'platform-tools', adbExecutableName());
}

function getPreparedAdbCandidate(): AdbCandidate[] {
  const key = platformToolsKey();
  if (!key) return [];
  return [{ command: preparedAdbPath(key), source: 'prepared' }];
}

function getSdkAdbCandidates(home: string): AdbCandidate[] {
  if (process.platform === 'win32') {
    const candidates: AdbCandidate[] = [];
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push({
        command: path.join(localAppData, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        source: 'sdk',
      });
    }
    candidates.push(
      {
        command: path.join(home, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        source: 'sdk',
      },
      { command: 'adb.exe', source: 'path' },
      { command: ADB_COMMAND, source: 'path' },
    );
    return candidates;
  }
  return [
    { command: path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), source: 'sdk' },
    { command: path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'), source: 'sdk' },
    { command: '/opt/homebrew/bin/adb', source: 'path' },
    { command: '/usr/local/bin/adb', source: 'path' },
    { command: ADB_COMMAND, source: 'path' },
  ];
}

function getAdbCandidates(settings = getAndroidSettings()): AdbCandidate[] {
  const customPath = settings.adbPathOverride?.trim();
  if (customPath) return [{ command: customPath, source: 'custom', strict: true }];
  const envPath = process.env.XDT_ANDROID_ADB_PATH?.trim();
  if (envPath) return [{ command: envPath, source: 'env', strict: true }];
  const candidates: AdbCandidate[] = [];
  candidates.push(...getBundledAdbCandidates().map((command) => ({ command, source: 'bundled' as const })));
  candidates.push(...getPreparedAdbCandidate());
  const home = app.getPath('home');
  candidates.push(...getSdkAdbCandidates(home));
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.command || seen.has(candidate.command)) return false;
    seen.add(candidate.command);
    return true;
  });
}

function canUseAdbCandidate(candidate: AdbCandidate): boolean {
  if (candidate.strict) return true;
  if (candidate.command === ADB_COMMAND || candidate.command === 'adb.exe') return true;
  return existsSync(candidate.command);
}

function adbCandidatesSignature(candidates: AdbCandidate[]): string {
  return candidates
    .map((candidate) => `${candidate.source}:${candidate.strict ? '1' : '0'}:${candidate.command}`)
    .join('|');
}

export function resolveAdbCommandDetails(settings = getAndroidSettings()): {
  command: string;
  source: AndroidAdbPathSource;
} {
  for (const candidate of getAdbCandidates(settings)) {
    if (canUseAdbCandidate(candidate)) {
      return { command: candidate.command, source: candidate.source };
    }
  }
  return { command: process.platform === 'win32' ? 'adb.exe' : ADB_COMMAND, source: 'fallback' };
}

function currentAdbCommandDetails(settings = getAndroidSettings()): {
  command: string;
  source: AndroidAdbPathSource;
} {
  const candidates = getAdbCandidates(settings);
  const signature = adbCandidatesSignature(candidates);
  if (runnableAdbCache?.signature === signature) {
    return { command: runnableAdbCache.command, source: runnableAdbCache.source };
  }
  return resolveAdbCommandDetails(settings);
}

function getBundledAdbCandidates(): string[] {
  const key = platformToolsKey();
  if (!key) return [];
  const candidates: string[] = [];
  const adbName = adbExecutableName();
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, ...BUNDLED_ANDROID_PLATFORM_TOOLS_RESOURCE_ROOT, key, adbName));
  }
  try {
    const appPath = app.getAppPath();
    candidates.push(path.join(appPath, '..', '..', ...BUNDLED_ANDROID_PLATFORM_TOOLS_SOURCE_ROOT, key, adbName));
  } catch {
    // app.getAppPath() is unavailable in a few test harnesses before Electron is ready.
  }
  candidates.push(path.join(process.cwd(), ...BUNDLED_ANDROID_PLATFORM_TOOLS_SOURCE_ROOT, key, adbName));
  return candidates;
}

function shouldProbeAdbCandidate(candidate: AdbCandidate): boolean {
  return candidate.command !== ADB_COMMAND && candidate.command !== 'adb.exe';
}

function adbNotFoundFromProbe(command: string, err: unknown): AndroidDriverError {
  if (err instanceof AndroidDriverError) return err;
  return new AndroidDriverError(
    'ADB_NOT_FOUND',
    err instanceof Error ? err.message : `adb not runnable at ${command}: ${String(err)}`,
  );
}

function adbServerPort(): number {
  const p = Number(process.env.ANDROID_ADB_SERVER_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 5037;
}

/**
 * 在首次使用 bundled/prepared adb 跑 server-touching 命令前,探测 adb server
 * 端口是否已有 server 在监听。结果缓存在 serverPreExistedBeforeUs 中(整个会话
 * 只检测一次)。端口遵守 ANDROID_ADB_SERVER_PORT 环境变量(与 adb 行为一致)。
 */
async function detectPreExistingAdbServer(): Promise<void> {
  if (serverPreExistedBeforeUs !== null) return;
  const port = adbServerPort();
  serverPreExistedBeforeUs = await isPortListening(port);
  if (serverPreExistedBeforeUs) {
    logger.info(`adb server already running on port ${port} before our first use — will not kill on quit`);
  }
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

async function probeAdbCandidate(candidate: AdbCandidate): Promise<ExecResult> {
  try {
    // `adb version` 不启动 server(AOSP 直接返回版本字符串,不触发 start-server),
    // 所以这里不设 managedAdbCommandUsed——真正的标记在 spawnAdb 里,只有跑了
    // 会 start-server 的命令(devices/push/shell 等)才算"我们用过 server"。
    const result = await spawnAdbWithCommand(candidate.command, ['version'], STATUS_TIMEOUT_MS);
    if (result.exitCode === 0) return result;
    throw new AndroidDriverError(
      'ADB_NOT_FOUND',
      result.stderr.trim() || `adb version failed for ${candidate.command}`,
    );
  } catch (err) {
    throw adbNotFoundFromProbe(candidate.command, err);
  }
}

async function resolveAdbCommandForSpawn(): Promise<ResolvedAdbCommand> {
  const candidates = getAdbCandidates();
  const signature = adbCandidatesSignature(candidates);
  if (runnableAdbCache?.signature === signature) return runnableAdbCache;

  for (const candidate of candidates) {
    if (!canUseAdbCandidate(candidate)) continue;
    if (!shouldProbeAdbCandidate(candidate)) {
      return { command: candidate.command, source: candidate.source, signature };
    }

    try {
      const probeResult = await probeAdbCandidate(candidate);
      const resolved = {
        command: candidate.command,
        source: candidate.source,
        signature,
        probeResult,
      };
      runnableAdbCache = resolved;
      return resolved;
    } catch (err) {
      if (candidate.strict) throw err;
      logger.debug('Skipping unusable Android adb candidate', {
        source: candidate.source,
        command: candidate.command,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    command: process.platform === 'win32' ? 'adb.exe' : ADB_COMMAND,
    source: 'fallback',
    signature,
  };
}

function currentAdbPreparationState(
  resolution = currentAdbCommandDetails(),
  readyOverride?: boolean,
): AndroidAdbPreparationState {
  const key = platformToolsKey() ?? `${process.platform}-${process.arch}`;
  const supported = Boolean(platformToolsKey() && PLATFORM_TOOLS_DOWNLOADS[platformToolsKey() ?? '']);
  const ready = readyOverride ?? resolution.source !== 'fallback';
  return {
    supported,
    ready,
    platform: key,
    path: ready ? resolution.command : null,
    source: ready ? resolution.source : null,
  };
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedParent = path.resolve(parent);
  if (normalizedCandidate === normalizedParent) return true;
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function downloadPlatformToolsZip(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), platformToolsDownloadTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new AndroidDriverError(
        'ANDROID_DRIVER_ERROR',
        `Android platform-tools download failed HTTP ${response.status}`,
      );
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > MAX_PLATFORM_TOOLS_ZIP_BYTES) {
      throw new AndroidDriverError('ANDROID_DRIVER_ERROR', 'Android platform-tools download is too large');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PLATFORM_TOOLS_ZIP_BYTES) {
      throw new AndroidDriverError('ANDROID_DRIVER_ERROR', 'Android platform-tools download is too large');
    }
    return buffer;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new AndroidDriverError(
        'ANDROID_DRIVER_ERROR',
        `Android platform-tools download timed out after ${platformToolsDownloadTimeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function extractPlatformToolsZip(buffer: Buffer, key: string): Promise<void> {
  const parent = path.join(app.getPath('userData'), PREPARED_ANDROID_PLATFORM_TOOLS_ROOT);
  const finalRoot = preparedPlatformToolsInstallRoot(key);
  const tempRoot = path.join(parent, `${key}.tmp-${Date.now()}`);
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.values(zip.files).filter((entry) => entry.name.startsWith('platform-tools/'));
    if (entries.length === 0) {
      throw new AndroidDriverError('ANDROID_DRIVER_ERROR', 'Android platform-tools archive has no platform-tools directory');
    }
    for (const entry of entries) {
      const parts = entry.name.split('/').filter(Boolean);
      const target = path.resolve(tempRoot, ...parts);
      if (!isSameOrChildPath(target, tempRoot)) {
        throw new AndroidDriverError('ANDROID_DRIVER_ERROR', 'Android platform-tools archive contains an unsafe path');
      }
      if (entry.dir) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await entry.async('nodebuffer'));
      if (process.platform !== 'win32') {
        await chmod(target, 0o755).catch(() => undefined);
      }
    }
    await rm(finalRoot, { recursive: true, force: true });
    await rename(tempRoot, finalRoot);
  } catch (err) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export async function prepareAndroidAdb(): Promise<AndroidAdbPreparationState> {
  const settings = getAndroidSettings();
  const initialResolution = currentAdbCommandDetails(settings);
  try {
    await adbVersion();
    return currentAdbPreparationState(currentAdbCommandDetails(settings));
  } catch (err) {
    if (settings.adbPathOverride || process.env.XDT_ANDROID_ADB_PATH?.trim()) {
      return {
        ...currentAdbPreparationState(initialResolution, false),
        ready: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const key = platformToolsKey();
  const download = key ? PLATFORM_TOOLS_DOWNLOADS[key] : null;
  if (!key || !download) {
    return {
      supported: false,
      ready: false,
      platform: `${process.platform}-${process.arch}`,
      path: null,
      source: null,
      error: 'Automatic Android platform-tools preparation is not supported on this platform.',
    };
  }

  try {
    logger.info('Preparing Android platform-tools', { platform: key });
    const buffer = await downloadPlatformToolsZip(download.url);
    await extractPlatformToolsZip(buffer, key);
    runnableAdbCache = null;
    await adbVersion();
    return currentAdbPreparationState(currentAdbCommandDetails());
  } catch (err) {
    logger.warn('Android platform-tools preparation failed', {
      platform: key,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      supported: true,
      ready: false,
      platform: key,
      path: preparedAdbPath(key),
      source: 'prepared',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let lastArtifactCleanupAt = 0;

async function cleanupOldArtifacts(dir: string): Promise<void> {
  const now = Date.now();
  if (now - lastArtifactCleanupAt < 60 * 60 * 1000) return;
  lastArtifactCleanupAt = now;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const filePath = path.join(dir, entry.name);
      const info = await stat(filePath).catch(() => null);
      if (!info || now - info.mtimeMs < ARTIFACT_RETENTION_MS) return;
      await rm(filePath, { force: true }).catch(() => undefined);
    }));
  } catch (err) {
    logger.debug('Android adb artifact cleanup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function adbArtifactDir(): Promise<string> {
  const dir = path.join(app.getPath('temp'), 'xdt-maker-adb');
  await mkdir(dir, { recursive: true });
  void cleanupOldArtifacts(dir);
  return dir;
}

async function writeArtifact(
  prefix: string,
  extension: string,
  data: Buffer | string,
): Promise<string> {
  const filePath = path.join(
    await adbArtifactDir(),
    `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`,
  );
  await writeFile(filePath, data);
  return filePath;
}

function isCommandNotFoundError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function spawnAdbWithCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  captureBinary = false,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new AdbCommandTimeoutError(args, timeoutMs));
    }, timeoutMs);

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isCommandNotFoundError(err)) {
        reject(new AndroidDriverError('ADB_NOT_FOUND', err instanceof Error ? err.message : String(err)));
        return;
      }
      reject(err);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
        stdoutOverflow = true;
        stdoutBytes += chunk.length;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutOverflow) {
        reject(new AndroidDriverError(
          captureBinary ? 'SCREENSHOT_FAILED' : 'ANDROID_DRIVER_ERROR',
          `adb ${args.join(' ')} stdout exceeded ${MAX_STDOUT_BYTES} bytes`,
        ));
        return;
      }
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stderrBuffer = Buffer.concat(stderrChunks);
      resolve({
        stdout: captureBinary ? stdoutBuffer.toString('binary') : stdoutBuffer.toString('utf8'),
        stderr: stderrBuffer.toString('utf8'),
        stdoutBuffer,
        exitCode,
      });
    });
  });
}

async function spawnAdb(args: string[], timeoutMs: number, captureBinary = false): Promise<ExecResult> {
  const resolution = await resolveAdbCommandForSpawn();
  if (
    !captureBinary
    && args.length === 1
    && args[0] === 'version'
    && resolution.probeResult
  ) {
    const result = resolution.probeResult;
    delete resolution.probeResult;
    return result;
  }
  const isVersionOnly = args.length === 1 && args[0] === 'version';
  if (resolution.source === 'bundled' || resolution.source === 'prepared') {
    if (!isVersionOnly) {
      await detectPreExistingAdbServer();
      managedAdbCommandUsed = resolution.command;
    }
  }
  const result = await spawnAdbWithCommand(resolution.command, args, timeoutMs, captureBinary);
  if (result.exitCode === 0 && resolution.signature) {
    runnableAdbCache = {
      command: resolution.command,
      source: resolution.source,
      signature: resolution.signature,
    };
  }
  return result;
}

function ok<T>(data: T): AndroidToolOk<T> {
  return { ok: true, data };
}

function toError(err: unknown): AndroidToolErr {
  if (err instanceof AndroidDriverError) {
    return {
      ok: false,
      errorCode: err.errorCode,
      message: err.message,
      ...(err.data ? { data: err.data } : {}),
    };
  }
  return {
    ok: false,
    errorCode: 'ANDROID_DRIVER_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
}

function parseDevices(output: string): AndroidConnectedDevice[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const device: AndroidConnectedDevice = {
        device_serial: parts[0] ?? '',
        state: parts[1] ?? 'unknown',
      };
      for (const part of parts.slice(2)) {
        const [key, value] = part.split(':', 2);
        if (!value) continue;
        if (key === 'product') device.product = value;
        if (key === 'model') device.model = value;
        if (key === 'device') device.device = value;
        if (key === 'transport_id') device.transport_id = value;
        if (key === 'usb') device.usb = value;
      }
      return device;
    });
}

async function adbVersion(): Promise<string | null> {
  const result = await spawnAdb(['version'], STATUS_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new AndroidDriverError(
      'ADB_NOT_FOUND',
      result.stderr.trim() || 'adb version failed',
    );
  }
  const line = result.stdout.split(/\r?\n/).find((value) => value.includes('Android Debug Bridge'));
  return line?.trim() ?? (result.stdout.trim() || null);
}

async function listDevicesWithTimeout(timeoutMs: number): Promise<AndroidConnectedDevice[]> {
  const result = await spawnAdb(['devices', '-l'], timeoutMs);
  if (result.exitCode !== 0) {
    throw new AndroidDriverError(
      'ANDROID_DRIVER_ERROR',
      result.stderr.trim() || 'adb devices -l failed',
    );
  }
  return parseDevices(result.stdout);
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isTransientAdbStartupError(err: unknown): boolean {
  if (err instanceof AdbCommandTimeoutError) return true;
  if (!(err instanceof AndroidDriverError)) return false;
  return /protocol fault|connection reset by peer|cannot connect to daemon|daemon not running|failed to connect to.*daemon/i
    .test(err.message);
}

async function waitForAdbDevicesReady(deadlineMs: number): Promise<AndroidConnectedDevice[]> {
  let lastError: unknown = new AdbCommandTimeoutError(
    ['devices', '-l'],
    ADB_COLD_START_TIMEOUT_MS,
  );
  while (Date.now() < deadlineMs) {
    const remainingMs = deadlineMs - Date.now();
    try {
      return await listDevicesWithTimeout(Math.min(STATUS_TIMEOUT_MS, remainingMs));
    } catch (err) {
      if (!isTransientAdbStartupError(err)) throw err;
      lastError = err;
      const delayMs = Math.min(ADB_COLD_START_POLL_INTERVAL_MS, deadlineMs - Date.now());
      if (delayMs <= 0) break;
      await waitForDelay(delayMs);
    }
  }
  throw lastError;
}

async function waitForAdbServerStarted(deadlineMs: number): Promise<void> {
  let lastError: unknown = new AdbCommandTimeoutError(
    ['start-server'],
    ADB_COLD_START_TIMEOUT_MS,
  );
  while (Date.now() < deadlineMs) {
    const remainingMs = deadlineMs - Date.now();
    let attemptError: unknown;
    try {
      const result = await spawnAdb(['start-server'], remainingMs);
      if (result.exitCode === 0) return;
      attemptError = new AndroidDriverError(
        'ANDROID_DRIVER_ERROR',
        result.stderr.trim() || 'adb start-server failed after devices timed out',
      );
    } catch (err) {
      attemptError = err;
    }
    if (!isTransientAdbStartupError(attemptError)) throw attemptError;
    lastError = attemptError;

    const delayMs = Math.min(ADB_COLD_START_POLL_INTERVAL_MS, deadlineMs - Date.now());
    if (delayMs <= 0) break;
    await waitForDelay(delayMs);
  }
  throw lastError;
}

async function runAdbColdStartRecovery(): Promise<AndroidConnectedDevice[]> {
  const deadlineMs = Date.now() + ADB_COLD_START_TIMEOUT_MS;
  await waitForAdbServerStarted(deadlineMs);
  return waitForAdbDevicesReady(deadlineMs);
}

function recoverAdbColdStart(): Promise<AndroidConnectedDevice[]> {
  logger.info('adb devices timed out; waiting for a cold daemon startup before retrying', {
    initialTimeoutMs: STATUS_TIMEOUT_MS,
    coldStartTimeoutMs: ADB_COLD_START_TIMEOUT_MS,
  });
  return runAdbColdStartRecovery();
}

function listDevicesRaw(): Promise<AndroidConnectedDevice[]> {
  const details = currentAdbCommandDetails();
  const key = `${details.source}:${details.command}`;
  const existing = adbDeviceListRequests.get(key);
  if (existing) {
    logger.debug('joining in-flight adb device query', { command: details.command });
    return existing;
  }

  const request = (async () => {
    try {
      return await listDevicesWithTimeout(STATUS_TIMEOUT_MS);
    } catch (err) {
      if (!isAdbCommandTimeoutFor(err, ['devices', '-l'])) throw err;
      return recoverAdbColdStart();
    }
  })().finally(() => {
    adbDeviceListRequests.delete(key);
  });
  adbDeviceListRequests.set(key, request);
  return request;
}

function classifyDeviceIssue(devices: AndroidConnectedDevice[]): AndroidMcpErrorCode | null {
  const activeDevices = devices.filter((device) => device.state === 'device');
  if (activeDevices.length > 1) return 'MULTIPLE_DEVICES';
  if (activeDevices.length === 1) return null;
  if (devices.some((device) => device.state === 'unauthorized')) return 'DEVICE_UNAUTHORIZED';
  if (devices.some((device) => device.state === 'offline')) return 'DEVICE_OFFLINE';
  return 'NO_DEVICE';
}

function classifyConfiguredDeviceIssue(
  devices: AndroidConnectedDevice[],
  serial: string | null,
): { issue: AndroidMcpErrorCode | null; error?: string } {
  if (!serial) return { issue: classifyDeviceIssue(devices) };
  const match = devices.find((device) => device.device_serial === serial);
  if (!match) {
    return {
      issue: 'NO_DEVICE',
      error: `Default Android device is not connected: ${serial}`,
    };
  }
  if (match.state === 'device') return { issue: null };
  if (match.state === 'unauthorized') {
    return {
      issue: 'DEVICE_UNAUTHORIZED',
      error: `Default Android device is unauthorized: ${serial}`,
    };
  }
  if (match.state === 'offline') {
    return {
      issue: 'DEVICE_OFFLINE',
      error: `Default Android device is offline: ${serial}`,
    };
  }
  return {
    issue: 'NO_DEVICE',
    error: `Default Android device is not ready: ${serial}`,
  };
}

function resolveRequestedDeviceSerial(requestedSerial?: string): string | undefined {
  const explicit = requestedSerial?.trim();
  if (explicit) return explicit;
  return getAndroidSettings().defaultDeviceSerial ?? undefined;
}

function resolveTargetDevice(
  devices: AndroidConnectedDevice[],
  requestedSerial?: string,
): AndroidConnectedDevice {
  if (requestedSerial) {
    const match = devices.find((device) => device.device_serial === requestedSerial);
    if (!match) {
      throw new AndroidDriverError('NO_DEVICE', `Device not found: ${requestedSerial}`);
    }
    if (match.state === 'unauthorized') {
      throw new AndroidDriverError('DEVICE_UNAUTHORIZED', `Device unauthorized: ${requestedSerial}`);
    }
    if (match.state === 'offline') {
      throw new AndroidDriverError('DEVICE_OFFLINE', `Device offline: ${requestedSerial}`);
    }
    if (match.state !== 'device') {
      throw new AndroidDriverError('NO_DEVICE', `Device is not ready: ${requestedSerial}`);
    }
    return match;
  }

  const activeDevices = devices.filter((device) => device.state === 'device');
  if (activeDevices.length === 1) return activeDevices[0];
  if (activeDevices.length > 1) {
    throw new AndroidDriverError('MULTIPLE_DEVICES', 'Multiple adb devices are connected');
  }
  if (devices.some((device) => device.state === 'unauthorized')) {
    throw new AndroidDriverError('DEVICE_UNAUTHORIZED', 'An adb device is connected but unauthorized');
  }
  if (devices.some((device) => device.state === 'offline')) {
    throw new AndroidDriverError('DEVICE_OFFLINE', 'An adb device is connected but offline');
  }
  throw new AndroidDriverError('NO_DEVICE', 'No adb device connected');
}

function withDeviceArgs(serial: string, args: string[]): string[] {
  return ['-s', serial, ...args];
}

async function runDeviceAdb(
  serial: string,
  args: string[],
  timeoutMs = CALL_TIMEOUT_MS,
  captureBinary = false,
): Promise<ExecResult> {
  const result = await spawnAdb(withDeviceArgs(serial, args), timeoutMs, captureBinary);
  if (result.exitCode !== 0) {
    throw new AndroidDriverError(
      'ANDROID_DRIVER_ERROR',
      result.stderr.trim() || `adb ${args.join(' ')} failed`,
      {
        device_serial: serial,
        args,
      },
    );
  }
  return result;
}

async function readScreenState(serial: string): Promise<AndroidScreenState> {
  const sizeResult = await runDeviceAdb(serial, ['shell', 'wm', 'size']);
  const densityResult = await runDeviceAdb(serial, ['shell', 'wm', 'density']);
  const sizeMatch = /Physical size:\s*(\d+)x(\d+)/.exec(sizeResult.stdout);
  if (!sizeMatch) {
    throw new AndroidDriverError('ANDROID_DRIVER_ERROR', 'Unable to parse adb shell wm size output');
  }
  const densityMatch = /Physical density:\s*(\d+)/.exec(densityResult.stdout);
  return {
    width: Number(sizeMatch[1]),
    height: Number(sizeMatch[2]),
    density: densityMatch ? Number(densityMatch[1]) : null,
  };
}

function parseFocusedComponent(output: string): AndroidCurrentAppState | null {
  const focusMatch = /mCurrentFocus=.*?\s([A-Za-z0-9._$]+)\/([A-Za-z0-9._$/]+)\}/.exec(output)
    ?? /mFocusedApp=.*?\s([A-Za-z0-9._$]+)\/([A-Za-z0-9._$/]+)\s/.exec(output)
    ?? /topResumedActivity=.*?\s([A-Za-z0-9._$]+)\/([A-Za-z0-9._$/]+)\s/.exec(output)
    ?? /ResumedActivity:.*?\s([A-Za-z0-9._$]+)\/([A-Za-z0-9._$/]+)\s/.exec(output);
  if (!focusMatch) return null;
  return {
    package: focusMatch[1] ?? null,
    activity: focusMatch[2] ?? null,
  };
}

async function readCurrentAppState(serial: string): Promise<AndroidCurrentAppState> {
  const windowResult = await runDeviceAdb(serial, ['shell', 'dumpsys', 'window', 'windows']);
  const windowFocus = parseFocusedComponent(windowResult.stdout);
  if (windowFocus) return windowFocus;

  const activityResult = await runDeviceAdb(serial, ['shell', 'dumpsys', 'activity', 'activities']);
  return parseFocusedComponent(activityResult.stdout) ?? {
    package: null,
    activity: null,
  };
}

function parseBounds(raw: string): { x1: number; y1: number; x2: number; y2: number } | null {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(raw.trim());
  if (!match) return null;
  return {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  };
}

function xmlDecode(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseUiNodes(xml: string): AndroidUiNode[] {
  const nodes: AndroidUiNode[] = [];
  const nodeRegex = /<node\b([^>]*?)(?:\/>|>)/g;
  let match: RegExpExecArray | null;
  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const boundsMatch = /bounds="([^"]+)"/.exec(attrs);
    const bounds = boundsMatch ? parseBounds(boundsMatch[1]) : null;
    if (!bounds) continue;
    const attr = (name: string) => {
      const value = new RegExp(`${name}="([^"]*)"`, 'i').exec(attrs)?.[1];
      return value ? xmlDecode(value) : '';
    };
    const boolAttr = (name: string) => attr(name) === 'true';
    const node: AndroidUiNode = {
      index: nodes.length + 1,
      text: attr('text') || undefined,
      content_desc: attr('content-desc') || undefined,
      class_name: attr('class') || undefined,
      resource_id: attr('resource-id') || undefined,
      package: attr('package') || undefined,
      bounds,
      clickable: boolAttr('clickable'),
      enabled: attr('enabled') !== 'false',
      ...(boolAttr('focusable') ? { focusable: true } : {}),
      ...(boolAttr('long-clickable') ? { long_clickable: true } : {}),
      ...(boolAttr('scrollable') ? { scrollable: true } : {}),
      ...(boolAttr('checked') ? { checked: true } : {}),
      ...(boolAttr('selected') ? { selected: true } : {}),
    };
    const hasSignal = Boolean(
      node.text
      || node.content_desc
      || node.resource_id
      || node.clickable
      || node.scrollable,
    );
    if (hasSignal) {
      nodes.push(node);
    }
  }
  return nodes.slice(0, MAX_UI_NODES);
}

async function captureScreenshot(serial: string): Promise<{
  filePath: string;
  base64: string;
  screenSize: Pick<AndroidScreenState, 'width' | 'height'> | null;
}> {
  const result = await runDeviceAdb(serial, ['exec-out', 'screencap', '-p'], CALL_TIMEOUT_MS, true);
  const buffer = result.stdoutBuffer;
  if (buffer.length === 0 || buffer[0] !== 0x89) {
    throw new AndroidDriverError('SCREENSHOT_FAILED', 'adb screencap did not return a PNG payload');
  }
  return {
    filePath: await writeArtifact('android-state', 'png', buffer),
    base64: buffer.toString('base64'),
    screenSize: readPngSize(buffer),
  };
}

function readPngSize(buffer: Buffer): Pick<AndroidScreenState, 'width' | 'height'> | null {
  if (buffer.length < 24) return null;
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!pngSignature.every((byte, index) => buffer[index] === byte)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

async function dumpUi(serial: string): Promise<{
  nodes: AndroidUiNode[];
  rawFilePath?: string;
  uiDumpError?: string;
}> {
  let dumpResult: ExecResult;
  try {
    dumpResult = await runDeviceAdb(serial, ['exec-out', 'uiautomator', 'dump', '/dev/tty']);
  } catch (err) {
    throw new AndroidDriverError(
      'UI_DUMP_FAILED',
      err instanceof Error ? err.message : 'uiautomator dump failed',
    );
  }
  const dumpText = dumpResult.stdout;
  const xmlStart = dumpText.indexOf('<?xml');
  if (xmlStart < 0) {
    throw new AndroidDriverError('UI_DUMP_FAILED', 'uiautomator dump did not return XML');
  }
  const xml = dumpText.slice(xmlStart);
  const rawFilePath = await writeArtifact('android-ui', 'xml', xml);
  return {
    nodes: parseUiNodes(xml),
    rawFilePath,
  };
}

function escapeAdbText(text: string): string {
  const unsafe = /[^A-Za-z0-9 .,:@/_+=%+-]/.exec(text);
  if (unsafe) {
    throw new AndroidDriverError(
      'ANDROID_DRIVER_ERROR',
      `Unsupported character for adb shell input text: ${unsafe[0]}`,
    );
  }
  if (!SAFE_ADB_INPUT_TEXT_RE.test(text)) {
    throw new AndroidDriverError(
      'ANDROID_DRIVER_ERROR',
      'adb shell input text contains unsupported characters.',
    );
  }
  if (/%s/.test(text)) {
    throw new AndroidDriverError(
      'ANDROID_DRIVER_ERROR',
      'Literal %s is unsupported because Android input text treats it as a space.',
    );
  }
  return text
    .replace(/ /g, '%s');
}

function centerOf(node: AndroidUiNode) {
  return {
    x: Math.floor((node.bounds.x1 + node.bounds.x2) / 2),
    y: Math.floor((node.bounds.y1 + node.bounds.y2) / 2),
  };
}

function assertValidAndroidPackage(value: string): void {
  if (!ANDROID_PACKAGE_RE.test(value)) {
    throw new AndroidDriverError('ANDROID_DRIVER_ERROR', `Invalid Android package name: ${value}`);
  }
}

function assertValidAndroidActivity(value: string): void {
  if (!ANDROID_ACTIVITY_RE.test(value)) {
    throw new AndroidDriverError('ANDROID_DRIVER_ERROR', `Invalid Android activity name: ${value}`);
  }
}

function snapshotKey(sessionId: string, deviceSerial: string): string {
  return `${sessionId}:${deviceSerial}`;
}

function readSessionId(context?: AndroidMcpCallContext): string {
  const raw = context?.sessionId?.trim();
  return raw || 'global';
}

function rememberStateSnapshot(
  sessionId: string,
  state: AndroidDeviceStateResult,
): AndroidDeviceStateResult {
  latestStateSnapshots.set(snapshotKey(sessionId, state.device_serial), {
    sessionId,
    deviceSerial: state.device_serial,
    screen: state.screen,
    nodes: state.nodes,
    capturedAt: Date.now(),
  });
  return state;
}

function clearStateSnapshot(sessionId: string, deviceSerial: string): void {
  latestStateSnapshots.delete(snapshotKey(sessionId, deviceSerial));
}

function assertPointInScreen(
  point: { x: number; y: number },
  screen: AndroidScreenState,
): void {
  if (
    point.x < 0
    || point.y < 0
    || point.x >= screen.width
    || point.y >= screen.height
  ) {
    throw new AndroidDriverError(
      'ANDROID_DRIVER_ERROR',
      `Coordinate out of screen bounds: (${point.x}, ${point.y}) for ${screen.width}x${screen.height}`,
    );
  }
}

function argsForLog(
  name: AndroidMcpToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name !== 'input_text' || typeof args.text !== 'string') {
    return args;
  }
  return {
    ...args,
    text: `[redacted ${Array.from(args.text).length} chars]`,
  };
}

async function status(): Promise<AndroidStatusSummary> {
  const settings = getAndroidSettings();
  const version = await adbVersion();
  const resolution = currentAdbCommandDetails(settings);
  const devices = await listDevicesRaw();
  const configuredDefault = settings.defaultDeviceSerial;
  const { issue, error } = classifyConfiguredDeviceIssue(devices, configuredDefault);
  const readyDevices = devices.filter((device) => device.state === 'device');
  return {
    adb_available: true,
    adb_path: resolution.command,
    adb_path_source: resolution.source,
    adb_preparation: currentAdbPreparationState(resolution, true),
    version,
    devices,
    default_device_serial: configuredDefault
      ?? (readyDevices.length === 1 ? readyDevices[0].device_serial : null)
      ?? null,
    configured_default_device_serial: configuredDefault,
    issue,
    ...(error ? { error } : {}),
  };
}

async function getDeviceStateInternal(
  device_serial: string | undefined,
  sessionId: string,
): Promise<AndroidDeviceStateResult> {
  const devices = await listDevicesRaw();
  const device = resolveTargetDevice(devices, resolveRequestedDeviceSerial(device_serial));
  const [screen, current_app, screenshot] = await Promise.all([
    readScreenState(device.device_serial),
    readCurrentAppState(device.device_serial),
    captureScreenshot(device.device_serial),
  ]);
  const coordinateScreen = screenshot.screenSize
    ? { ...screen, ...screenshot.screenSize }
    : screen;

  try {
    const dump = await dumpUi(device.device_serial);
    return rememberStateSnapshot(sessionId, {
      device_serial: device.device_serial,
      screen: coordinateScreen,
      current_app,
      screenshot_file_path: screenshot.filePath,
      screenshot_base64: screenshot.base64,
      screenshot_mime_type: 'image/png',
      nodes: dump.nodes,
      ...(dump.nodes.length >= MAX_UI_NODES ? { nodes_truncated: true } : {}),
      ...(dump.rawFilePath ? { raw_ui_dump_file_path: dump.rawFilePath } : {}),
    });
  } catch (err) {
    if (err instanceof AndroidDriverError && err.errorCode === 'UI_DUMP_FAILED') {
      return rememberStateSnapshot(sessionId, {
        device_serial: device.device_serial,
        screen: coordinateScreen,
        current_app,
        screenshot_file_path: screenshot.filePath,
        screenshot_base64: screenshot.base64,
        screenshot_mime_type: 'image/png',
        nodes: [],
        ui_dump_error: err.message,
      });
    }
    throw err;
  }
}

async function tap(args: Record<string, unknown>, sessionId: string) {
  const devices = await listDevicesRaw();
  const device = resolveTargetDevice(devices, resolveRequestedDeviceSerial(
    typeof args.device_serial === 'string' ? args.device_serial : undefined,
  ));
  let x: number;
  let y: number;
  let screen: AndroidScreenState;
  if (typeof args.element_index === 'number') {
    const snapshot = latestStateSnapshots.get(snapshotKey(sessionId, device.device_serial));
    if (!snapshot) {
      throw new AndroidDriverError(
        'INVALID_NODE',
        'No device snapshot is available. Call get_device_state before tap with element_index.',
        { device_serial: device.device_serial, session_id: sessionId },
      );
    }
    const node = snapshot.nodes.find((item) => item.index === args.element_index);
    if (!node) {
      throw new AndroidDriverError(
        'INVALID_NODE',
        `Node not found in latest device snapshot: ${String(args.element_index)}`,
        {
          device_serial: device.device_serial,
          session_id: sessionId,
          captured_at: snapshot.capturedAt,
        },
      );
    }
    ({ x, y } = centerOf(node));
    screen = snapshot.screen;
  } else {
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      throw new AndroidDriverError('ANDROID_DRIVER_ERROR', 'tap requires element_index or x/y coordinates');
    }
    x = args.x;
    y = args.y;
    const snapshot = latestStateSnapshots.get(snapshotKey(sessionId, device.device_serial));
    screen = snapshot?.screen ?? await readScreenState(device.device_serial);
  }
  assertPointInScreen({ x, y }, screen);
  await runDeviceAdb(device.device_serial, ['shell', 'input', 'tap', String(x), String(y)]);
  clearStateSnapshot(sessionId, device.device_serial);
  return {
    device_serial: device.device_serial,
    x,
    y,
  };
}

async function swipe(args: Record<string, unknown>, sessionId: string) {
  const devices = await listDevicesRaw();
  const device = resolveTargetDevice(devices, resolveRequestedDeviceSerial(
    typeof args.device_serial === 'string' ? args.device_serial : undefined,
  ));
  const start = args.start as { x: number; y: number };
  const end = args.end as { x: number; y: number };
  const duration = typeof args.duration_ms === 'number' ? args.duration_ms : 300;
  const snapshot = latestStateSnapshots.get(snapshotKey(sessionId, device.device_serial));
  const screen = snapshot?.screen ?? await readScreenState(device.device_serial);
  assertPointInScreen(start, screen);
  assertPointInScreen(end, screen);
  await runDeviceAdb(device.device_serial, [
    'shell',
    'input',
    'swipe',
    String(start.x),
    String(start.y),
    String(end.x),
    String(end.y),
    String(duration),
  ]);
  clearStateSnapshot(sessionId, device.device_serial);
  return {
    device_serial: device.device_serial,
    start,
    end,
    duration_ms: duration,
  };
}

async function inputText(args: Record<string, unknown>, sessionId: string) {
  const devices = await listDevicesRaw();
  const device = resolveTargetDevice(devices, resolveRequestedDeviceSerial(
    typeof args.device_serial === 'string' ? args.device_serial : undefined,
  ));
  const text = String(args.text ?? '');
  await runDeviceAdb(device.device_serial, ['shell', 'input', 'text', escapeAdbText(text)]);
  clearStateSnapshot(sessionId, device.device_serial);
  return {
    device_serial: device.device_serial,
    text,
  };
}

async function pressKey(args: Record<string, unknown>, sessionId: string) {
  const devices = await listDevicesRaw();
  const device = resolveTargetDevice(devices, resolveRequestedDeviceSerial(
    typeof args.device_serial === 'string' ? args.device_serial : undefined,
  ));
  const key = String(args.key ?? '');
  const keyCode = KEYEVENT_CODE[key];
  if (!keyCode) {
    throw new AndroidDriverError('ANDROID_DRIVER_ERROR', `Unsupported Android key: ${key}`);
  }
  await runDeviceAdb(device.device_serial, ['shell', 'input', 'keyevent', keyCode]);
  clearStateSnapshot(sessionId, device.device_serial);
  return {
    device_serial: device.device_serial,
    key,
    key_code: Number(keyCode),
  };
}

async function launchApp(args: Record<string, unknown>, sessionId: string) {
  const devices = await listDevicesRaw();
  const device = resolveTargetDevice(devices, resolveRequestedDeviceSerial(
    typeof args.device_serial === 'string' ? args.device_serial : undefined,
  ));
  const pkg = String(args.package ?? '');
  const activity = typeof args.activity === 'string' ? args.activity : null;
  assertValidAndroidPackage(pkg);
  if (activity) assertValidAndroidActivity(activity);
  const component = activity ? `${pkg}/${activity}` : pkg;
  const command = activity
    ? ['shell', 'am', 'start', '-n', component]
    : ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'];
  const result = await runDeviceAdb(device.device_serial, command);
  clearStateSnapshot(sessionId, device.device_serial);
  return {
    device_serial: device.device_serial,
    package: pkg,
    activity,
    output: result.stdout.trim() || result.stderr.trim() || null,
  };
}

export async function callAndroidDriverTool(
  name: AndroidMcpToolName,
  args: Record<string, unknown>,
  context?: AndroidMcpCallContext,
): Promise<AndroidToolResult<unknown>> {
  try {
    const sessionId = readSessionId(context);
    switch (name) {
      case 'status':
        return ok(await status());
      case 'list_devices':
        return ok(await listDevicesRaw());
      case 'get_device_state':
        return ok(await getDeviceStateInternal(
          typeof args.device_serial === 'string' ? args.device_serial : undefined,
          sessionId,
        ));
      case 'tap':
        return ok(await tap(args, sessionId));
      case 'swipe':
        return ok(await swipe(args, sessionId));
      case 'input_text':
        return ok(await inputText(args, sessionId));
      case 'press_key':
        return ok(await pressKey(args, sessionId));
      case 'launch_app':
        return ok(await launchApp(args, sessionId));
      default:
        throw new AndroidDriverError('ANDROID_DRIVER_ERROR', `Unknown Android tool: ${String(name)}`);
    }
  } catch (err) {
    logger.warn('Android adb tool call failed', {
      tool: name,
      args: argsForLog(name, args),
      sessionId: readSessionId(context),
      error: err instanceof Error ? err.message : String(err),
    });
    const result = toError(err);
    if (name === 'status') {
      return {
        ...result,
        data: {
          ...(result.data ?? {}),
          adb_preparation: currentAdbPreparationState(currentAdbCommandDetails(), false),
          adb_path_source: currentAdbCommandDetails().source,
          configured_default_device_serial: getAndroidSettings().defaultDeviceSerial,
        },
      };
    }
    return result;
  }
}

export async function getAndroidStatusSummary(): Promise<AndroidToolResult<AndroidStatusSummary>> {
  try {
    return ok(await status());
  } catch (err) {
    const result = toError(err);
    return {
      ...result,
      data: {
        ...(result.data ?? {}),
        adb_preparation: currentAdbPreparationState(currentAdbCommandDetails(), false),
        adb_path_source: currentAdbCommandDetails().source,
        configured_default_device_serial: getAndroidSettings().defaultDeviceSerial,
      },
    };
  }
}

export function getAndroidMcpDeps(options: AndroidMcpDepsOptions = {}): AndroidMcpDeps {
  return {
    callTool: async (name, args, context) => {
      if (options.isAndroidAutomationEnabled && !options.isAndroidAutomationEnabled(context)) {
        return {
          ok: false,
          errorCode: 'ANDROID_DRIVER_ERROR',
          message: 'Android automation is disabled in Settings.',
        };
      }
      return callAndroidDriverTool(name, args, context);
    },
    logger,
  };
}
