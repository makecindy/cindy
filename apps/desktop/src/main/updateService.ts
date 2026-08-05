/**
 * UpdateService — F2 + F3 (thin shell over unified-downloader).
 * ---------------------------------------------------------------------------
 * Tech spec: .sivi/docs/tech_specs/app-update-system-frontend.md
 *
 * Responsibilities (after refactor):
 *   - Orchestrate manifest fetch + version compare + download scheduling.
 *   - Persist patch-info.json so a startup after download can decide between
 *     "ready to relaunch" vs "fresh check".
 *   - Register IPC handlers and broadcast `update-status` / `app-update-progress`.
 *   - Platform-specific relaunch executors (Windows / macOS / Linux).
 *
 * NOT responsible anymore (delegated to unified-downloader):
 *   - HTTP request / Range header / redirect handling
 *   - SHA256 verification + corrupt-file cleanup
 *   - Retry & backoff
 *
 * The progress field on `app-update-progress` and `update-status` flows through
 * ProgressNormalizer so the renderer never sees out-of-range / non-monotonic
 * values — fixing the "progress bounces to 0" regression at the caller layer.
 */

import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import { fetchManifest, getBaseUrl, isDev } from './manifestService';
import type { Manifest } from './manifestService';
import { download, DownloadError } from './downloader/index';
import { ProgressNormalizer } from './updateProgressNormalizer';

import { createLogger, maskPath } from './logger';
import {
  readAutoUpdateSettings,
  readAutoUpdateSettingsState,
  resetAutoUpdateSettings,
  writeAutoRelaunchOnIdle,
} from './auto-update-settings-store';
import {
  AUTO_UPDATE_IDLE_THRESHOLD_SECONDS,
  getAutoRelaunchBlockReason,
  type AutoRelaunchBlockReason,
} from './updateAutoRelaunchPolicy';
import { throwIpcError } from './utils/ipcValidate';
import { noteExpectedExit } from './startup-diagnostics';
import { buildMacOSUpdateScript } from './updateScriptMacOS';
import { disposeAndroidAdb } from './mcp-integrations/android';
import { getGhostNodeRuntimeBroker } from './cindy-brain/index';
import { cleanOldUpdateFiles } from './updateArtifacts';

const log = createLogger('updateService');

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Lifecycle states for the in-app update flow.
 *
 * `superseding`: 已经处于 `ready`(本地有 a 版补丁),后台轮询发现了更高的 b 版,
 * 正在静默下载 b。期间 banner 继续可见,版本号停留在 a,但 relaunch 按钮显示 loading
 * 并禁用,防止用户点了之后装上的是 a。下载成功 → `ready` (b);下载失败 → 静默回退
 * 到 `ready` (a),下一次轮询再试。
 */
type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'superseding' | 'error';

interface UpdateStatusPayload {
  status: UpdateStatus;
  version?: string;
  progress?: number;
  errorCode?: string;
}

interface PatchInfo {
  version: string;
  fileName: string;
  sha256: string;
  /**
   * release-relogin-on-update: whether the manifest declared this version
   * requires Feishu re-authorization. Carried in patch-info.json so the relaunch
   * decision survives a process exit between download and apply.
   */
  requireRelogin?: boolean;
  /**
   * Counts how many times executeRelaunch() has been attempted for this patch.
   * Persisted so that if the updater process itself crashes (spawn succeeds
   * but file-replacement fails), we don't loop forever. Cleared when spawn
   * fails (deterministic — retry won't help) or when the threshold is hit.
   */
  applyAttempts?: number;
}

/**
 * release-relogin-on-update: one-shot marker file that lives at the userData
 * root (NOT inside `updates/`, which gets cleaned by `cleanOldFiles` on the
 * next download). Written when a `requireRelogin: true` patch finishes
 * downloading; consumed by `authManager.initialize()` exactly once after the
 * relaunch into the new version, then deleted.
 */
const RELOGIN_FLAG_FILE = 'relogin-required.flag';

interface ReloginFlag {
  /** The app version that required the re-login. Must match `app.getVersion()` to fire. */
  version: string;
}

function getReloginFlagPath(): string {
  return path.join(app.getPath('userData'), RELOGIN_FLAG_FILE);
}

function writeReloginFlag(targetVersion: string): void {
  try {
    const payload: ReloginFlag = { version: targetVersion };
    fs.writeFileSync(getReloginFlagPath(), JSON.stringify(payload));
    log.info('relogin flag written for v%s', targetVersion);
  } catch (err) {
    log.error('writeReloginFlag failed:', err);
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

const FIRST_CHECK_DELAY_MS = 10_000;         // first background check delay
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30min polling
const AUTO_RELAUNCH_POLL_INTERVAL_MS = 30_000;
// 启动态 manifest 短超时（#26）：probe 最坏 1.5s + external CDN P99 < 5s，8s 留足余量
const STARTUP_MANIFEST_TIMEOUT_MS = 8_000;

// ── State ──────────────────────────────────────────────────────────────────

let currentStatus: UpdateStatus = 'idle';
let readyVersion: string | undefined;
let readyFilePath: string | undefined;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let autoRelaunchPollTimer: ReturnType<typeof setInterval> | null = null;
let isRelaunching = false;
let lastErrorCode: string | undefined;
let autoRelaunchInProgress = false;
let lastAutoRelaunchBlockReason: AutoRelaunchBlockReason | null = null;
let lastBusyAtMs: number | null = null;
let lastResumeAtMs: number | null = null;
let startupUpdateCheckInProgress = false;
let resolvedRelaunchTheme: 'light' | 'dark' = 'dark';
let busyProbe: () => boolean | Promise<boolean> = () => false;

// ── Helpers ────────────────────────────────────────────────────────────────

function getUpdatesDir(): string {
  const dir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function broadcastStatus(payload: UpdateStatusPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update-status', payload);
    }
  }
}

function setStatus(status: UpdateStatus, extra?: Partial<UpdateStatusPayload>): void {
  currentStatus = status;
  lastErrorCode = extra?.errorCode;
  broadcastStatus({ status, ...extra });
  if (status === 'ready' && !startupUpdateCheckInProgress) {
    void evaluateAutoRelaunch('status-ready');
  }
}

function autoUpdateSettingsWire() {
  const state = readAutoUpdateSettingsState();
  return {
    autoRelaunchOnIdle: state.value.autoRelaunchOnIdle,
    isCustomized: state.isCustomized,
    defaultAutoRelaunchOnIdle: state.defaults.autoRelaunchOnIdle,
  };
}

function readSystemIdleState(): 'active' | 'idle' | 'locked' | 'unknown' {
  try {
    return powerMonitor.getSystemIdleState(AUTO_UPDATE_IDLE_THRESHOLD_SECONDS);
  } catch {
    return 'unknown';
  }
}

function readSystemIdleTimeSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return 0;
  }
}

async function hasBusyTasks(): Promise<boolean> {
  try {
    return await busyProbe();
  } catch (err) {
    log.warn('auto relaunch busy probe failed; treating app as busy', {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

async function getAutoRelaunchBlockReasonForCurrentState(): Promise<AutoRelaunchBlockReason | null> {
  if (!readAutoUpdateSettings().autoRelaunchOnIdle) return 'disabled';
  if (isDev()) return 'dev';
  if (currentStatus !== 'ready') return 'not-ready';
  if (isRelaunching || autoRelaunchInProgress) return 'relaunching';
  const hasBusyTasksNow = await hasBusyTasks();

  // The busy probe can await SQLite. Re-snapshot every mutable gate after it
  // settles so settings/status/relaunch changes during that window cannot be
  // bypassed by stale values at the final apply boundary.
  const enabled = readAutoUpdateSettings().autoRelaunchOnIdle;
  const dev = isDev();
  const status = currentStatus;
  const relaunching = isRelaunching || autoRelaunchInProgress;
  const nowMs = Date.now();
  if (hasBusyTasksNow) lastBusyAtMs = nowMs;

  return getAutoRelaunchBlockReason({
    enabled,
    isDev: dev,
    status,
    isRelaunching: relaunching,
    hasBusyTasks: hasBusyTasksNow,
    idleTimeSeconds: readSystemIdleTimeSeconds(),
    idleState: readSystemIdleState(),
    nowMs,
    lastBusyAtMs,
    lastResumeAtMs,
  });
}

/**
 * Startup/splash relaunch gate — intentionally looser than the background idle
 * policy. Startup is the safest moment to apply a staged patch: the app has just
 * launched, so there is no in-flight agent turn / schedule / active session to
 * interrupt. We therefore relaunch into the updater as soon as a patch is ready,
 * gating only on the essentials:
 *   - `disabled`     — user turned the auto-update relaunch switch off; respect it.
 *   - `dev`          — the native updater replaces the *installed* app; it can't
 *                      sanely update a dev / electron-forge instance, so never
 *                      auto-launch it there.
 *   - `not-ready`    — no staged patch to apply.
 *   - `relaunching`  — a relaunch is already in flight; don't double-fire.
 * The idle / busy / user-active / recent-resume / screen-state checks are NOT
 * applied here — those protect a long-running session from a surprise restart,
 * which is not a concern at a fresh launch. (Background auto-relaunch keeps the
 * full policy via getAutoRelaunchBlockReasonForCurrentState.)
 */
async function getStartupRelaunchBlockReason(): Promise<AutoRelaunchBlockReason | null> {
  if (!readAutoUpdateSettings().autoRelaunchOnIdle) return 'disabled';
  if (isDev()) return 'dev';
  if (currentStatus !== 'ready') return 'not-ready';
  if (isRelaunching || autoRelaunchInProgress) return 'relaunching';
  return null;
}

/**
 * Startup update checks apply a staged patch as soon as it is ready (the historic
 * behavior), gated only by the lightweight startup policy above. Whenever that
 * policy blocks (auto-update off / dev / not ready / already relaunching) the
 * patch stays staged and the app enters normally, surfacing the UpdateBanner.
 */
async function buildStartupReadyReply(version: string | undefined): Promise<{
  hasUpdate: true;
  action: 'relaunch' | 'none';
  version: string | undefined;
}> {
  const blockReason = await getStartupRelaunchBlockReason();
  if (blockReason) {
    lastAutoRelaunchBlockReason = blockReason;
    log.info(
      'startup update relaunch deferred (%s); patch v%s remains ready',
      blockReason,
      version ?? '<unknown>',
    );
    return { hasUpdate: true, action: 'none', version };
  }
  return { hasUpdate: true, action: 'relaunch', version };
}

interface AutoRelaunchRequestResult {
  accepted: boolean;
  blockReason?: AutoRelaunchBlockReason;
}

async function requestAutoRelaunch(
  reason: string,
  theme: 'light' | 'dark',
  useStartupPolicy = false,
): Promise<AutoRelaunchRequestResult> {
  // The startup/splash apply path uses the lighter gate (no idle/busy checks —
  // nothing is in flight at launch); background triggers keep the full policy.
  const blockReason = useStartupPolicy
    ? await getStartupRelaunchBlockReason()
    : await getAutoRelaunchBlockReasonForCurrentState();
  if (blockReason) {
    if (blockReason !== lastAutoRelaunchBlockReason) {
      lastAutoRelaunchBlockReason = blockReason;
      if (readAutoUpdateSettings().autoRelaunchOnIdle && currentStatus === 'ready') {
        log.info('auto relaunch blocked (%s)', blockReason);
      }
    }
    return { accepted: false, blockReason };
  }

  lastAutoRelaunchBlockReason = null;
  autoRelaunchInProgress = true;
  log.info('auto relaunch conditions met (%s), applying update v%s', reason, readyVersion ?? '<unknown>');
  executeRelaunch(theme);
  return { accepted: true };
}

async function evaluateAutoRelaunch(reason: string): Promise<void> {
  await requestAutoRelaunch(reason, resolvedRelaunchTheme);
}

function markRecentResume(): void {
  lastResumeAtMs = Date.now();
}

function markRecentBusyActivity(): void {
  lastBusyAtMs = Date.now();
}

function handlePowerMonitorActivity(): void {
  markRecentResume();
  void evaluateAutoRelaunch('power-activity');
}

function startAutoRelaunchPoller(): void {
  if (autoRelaunchPollTimer || isDev()) return;
  autoRelaunchPollTimer = setInterval(() => {
    void evaluateAutoRelaunch('poll');
  }, AUTO_RELAUNCH_POLL_INTERVAL_MS);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function broadcastUpdateProgress(payload: {
  progress: number;
  received: number;
  total: number;
  speed?: string;
  failed?: boolean;
  error?: string;
}): void {
  // Diagnostic: 排查 splash 100% 卡死时使用——webContents.send (fan-out) 与 ipcMain.handle
  // invoke reply 在 Electron 内部走不同通道，到渲染端不保证 FIFO。这条日志记录每次
  // app-update-progress 广播的时点和关键字段，配合 'update-check-startup returning' 日志
  // 可以反推出 reply / progress 在主进程发送侧的真实顺序。
  log.info(
    '[diag] broadcastUpdateProgress p=%d recv=%d total=%d failed=%s',
    payload.progress,
    payload.received,
    payload.total,
    payload.failed === true ? 'yes' : 'no',
  );
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('app-update-progress', payload);
    }
  }
}

// ── patch-info.json helpers ───────────────────────────────────────────────

const PATCH_INFO_FILE = 'patch-info.json';
const UPDATE_LOCK_FILE = '.updating';

/**
 * Snapshot of the current update lifecycle state. Used by callers that need to
 * gate side-effects (e.g. don't bring the FeishuBot online if an update is
 * actively downloading or staged for relaunch — it would just go offline again
 * within seconds and spam the owner with a needless online/offline pair).
 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

export function setUpdateAutoRelaunchBusyProbe(
  probe: () => boolean | Promise<boolean>,
): void {
  busyProbe = probe;
  void evaluateAutoRelaunch('busy-probe-installed');
}

export function notifyUpdateAutoRelaunchBusyStateChanged(): void {
  markRecentBusyActivity();
  void evaluateAutoRelaunch('busy-state-changed');
}

/**
 * Path to the update lock file. Windows update script creates it before
 * robocopy and deletes it after. The app's main process should refuse to
 * launch fully (or wait) while this file exists.
 */
export function getUpdateLockPath(): string {
  return path.join(getUpdatesDir(), UPDATE_LOCK_FILE);
}

/**
 * release-relogin-on-update: read the relogin flag without deleting it.
 * Caller compares `version` against `app.getVersion()` and, on a match,
 * calls `clearReloginFlag()` to consume it.
 *
 * Why two-step (read then delete) instead of read-and-delete in one call:
 * if the user downloads an update and closes the app *before* relaunching,
 * a fresh launch of the OLD binary would otherwise see the flag, mismatch
 * the version, and silently wipe the marker — leaving the eventual relaunch
 * into the NEW binary with nothing to act on. Keeping the flag until the
 * version actually matches is the safe default.
 */
export function readReloginFlag(): ReloginFlag | null {
  const flagPath = getReloginFlagPath();
  try {
    if (!fs.existsSync(flagPath)) return null;
    const raw = fs.readFileSync(flagPath, 'utf-8');
    const parsed = JSON.parse(raw) as ReloginFlag;
    if (parsed && typeof parsed.version === 'string' && parsed.version) {
      return parsed;
    }
  } catch (err) {
    log.error('readReloginFlag failed:', err);
  }
  return null;
}

export function clearReloginFlag(): void {
  try {
    fs.unlinkSync(getReloginFlagPath());
  } catch {
    // ENOENT is fine — flag was never written or already gone
  }
}

/**
 * Tri-state startup decision based on patch-info.json:
 *   - 'relaunch' → A patch matching a NEW version is sitting on disk; renderer
 *                  should show the splash relaunch dialog.
 *   - 'check'    → No usable patch (or patch already applied); proceed with a
 *                  manifest fetch as if this were a normal startup.
 *   - 'none'     → (Reserved; current implementation never returns this — kept
 *                  in the union for backward compatibility with prior callers.)
 */
function checkExistingPatch(): { action: 'relaunch' | 'check' | 'none'; version?: string } {
  const updatesDir = getUpdatesDir();
  const infoPath = path.join(updatesDir, PATCH_INFO_FILE);

  let patchInfo: PatchInfo;
  try {
    const raw = fs.readFileSync(infoPath, 'utf-8');
    patchInfo = JSON.parse(raw) as PatchInfo;
    if (!patchInfo.version || !patchInfo.fileName) {
      throw new Error('invalid patch-info');
    }
  } catch {
    return { action: 'check' };
  }

  const patchFilePath = path.join(updatesDir, patchInfo.fileName);
  if (!fs.existsSync(patchFilePath)) {
    removePatchInfo();
    return { action: 'check' };
  }

  const currentVersion = app.getVersion();
  if (patchInfo.version === currentVersion) {
    // Patch matches current version → already applied; clean up and re-check.
    try { fs.unlinkSync(patchFilePath); } catch { /* ignore */ }
    removePatchInfo();
    return { action: 'check' };
  }

  const attempts = patchInfo.applyAttempts ?? 0;
  if (attempts >= 3) {
    log.error(
      'Patch v%s failed to apply %d times — giving up, clearing patch',
      patchInfo.version, attempts,
    );
    try { fs.unlinkSync(patchFilePath); } catch { /* ignore */ }
    removePatchInfo();
    return { action: 'check' };
  }

  // Patch present, awaiting relaunch.
  readyVersion = patchInfo.version;
  readyFilePath = patchFilePath;
  return { action: 'relaunch', version: patchInfo.version };
}

function writePatchInfo(info: PatchInfo): void {
  try {
    fs.writeFileSync(
      path.join(getUpdatesDir(), PATCH_INFO_FILE),
      JSON.stringify(info),
    );
  } catch (err) {
    log.error('writePatchInfo failed:', err);
  }
}

function removePatchInfo(): void {
  try { fs.unlinkSync(path.join(getUpdatesDir(), PATCH_INFO_FILE)); } catch { /* ignore */ }
}

function incrementApplyAttempts(): void {
  const infoPath = path.join(getUpdatesDir(), PATCH_INFO_FILE);
  try {
    const raw = fs.readFileSync(infoPath, 'utf-8');
    const info = JSON.parse(raw) as PatchInfo;
    info.applyAttempts = (info.applyAttempts ?? 0) + 1;
    fs.writeFileSync(infoPath, JSON.stringify(info));
    log.info('applyAttempts incremented to %d for v%s', info.applyAttempts, info.version);
  } catch (err) {
    log.error('incrementApplyAttempts failed:', err);
  }
}

/**
 * Sweep stale `cindy-update*` / legacy `xdt-update*` leftovers from %TEMP%
 * older than MAX_AGE_DAYS.
 * Mirrors the Rust updater's `sweep_stale_temp_dirs` (installer.rs) but
 * runs in the main process at app startup — so users who never trigger
 * another update still get their disk cleaned up. The Rust sweep only
 * fires when the updater itself is launched; without this counterpart a
 * user on the latest version would keep the post-update workdir + the
 * `cindy-updater-{ts}.exe` binary inside it forever.
 *
 * Best-effort: any IO failure is swallowed — sweeping is housekeeping, not
 * correctness. 7-day threshold matches the Rust side so the two sweeps
 * agree about what counts as "stale".
 */
function sweepStaleUpdateTempDirs(): void {
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const tmp = os.tmpdir();
  const now = Date.now();
  let swept = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('cindy-update') && !name.startsWith('xdt-update')) continue;
    const full = path.join(tmp, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const ageMs = now - stat.mtimeMs;
    if (ageMs < MAX_AGE_MS) continue;
    try {
      if (stat.isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        fs.unlinkSync(full);
      }
      swept++;
      log.info(
        'sweep removed stale %s (age %dd)',
        maskPath(full),
        Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      );
    } catch {
      // Likely the file is the updater binary from a still-recent run we
      // mis-aged, or an AV holds a handle. Either way next startup retries.
    }
  }
  if (swept > 0) {
    log.info('sweep cleaned %d stale temp entries', swept);
  }
}

/**
 * Remove old downloaded files, keeping only the matching keepFileName plus
 * its sidecars (.part, .meta.json), patch-info.json, and the update lock.
 */
function cleanOldFiles(keepFileName: string): void {
  try {
    cleanOldUpdateFiles(getUpdatesDir(), keepFileName, [PATCH_INFO_FILE, UPDATE_LOCK_FILE]);
  } catch { /* ignore */ }
}

/**
 * packaged macOS 从 App Translocation 临时挂载运行时，安装根不是可持久化
 * 身份；普通热更必须等用户移入 Applications 后再 stage/apply。
 */
function isMacAppTranslocated(): boolean {
  return !isDev() && process.platform === 'darwin' && !app.isInApplicationsFolder();
}

// ── Core check logic ───────────────────────────────────────────────────────

export type CheckForUpdateResult =
  | 'ready'
  | 'manifest_failed'
  | 'download_failed'
  | 'manual_download'
  | 'idle';

// Module-level in-flight guard so the startup IPC handler and the background
// poll don't race on the same destPath. ALL access to `inFlightCheck` MUST
// go through `checkForUpdate()` — direct assignment from elsewhere reopens
// the race the guard exists to close (see history note in this file's header).
let inFlightCheck: Promise<CheckForUpdateResult> | null = null;

export async function checkForUpdate(
  manifestOverride?: Manifest | null,
): Promise<CheckForUpdateResult> {
  if (inFlightCheck) {
    log.info('checkForUpdate() in-flight — reusing existing promise');
    return inFlightCheck;
  }
  inFlightCheck = doCheckForUpdate(manifestOverride);
  try {
    return await inFlightCheck;
  } finally {
    inFlightCheck = null;
  }
}

/**
 * 版本无关打包(本地无版本 packaging)写入的占位版本。
 * 这类包(占位 0.0.0)不参与热更新:任何 CDN manifest 版本与它都不相等,
 * 不做豁免的话 packaged 版本无关包启动即被拉去下载线上版本自更——
 * 与"开源社区拉仓即可打包试用"的定位相悖。'0.0.0-*' 前缀一并覆盖,
 * 兼容历史脚本注释里的 0.0.0-dev 形态。
 */
export function isVersionlessAppVersion(version: string): boolean {
  return version === '0.0.0' || version.startsWith('0.0.0-');
}

async function doCheckForUpdate(manifestOverride?: Manifest | null): Promise<CheckForUpdateResult> {
  log.info('checkForUpdate() called, currentStatus=%s', currentStatus);

  if (isVersionlessAppVersion(app.getVersion())) {
    log.info('Versionless build (placeholder %s) — in-app update disabled', app.getVersion());
    currentStatus = 'idle';
    return 'idle';
  }

  if (process.platform === 'linux') {
    log.info('Linux first-release guard: skipping in-app update flow');
    currentStatus = 'idle';
    return 'manual_download';
  }

  // wasReady 路径:本地已经下好了 a 版本,正在等用户点重启。这次轮询要继续做版本对比,
  // 发现 b > a 时进入 superseding 状态去下 b,而不是像旧实现那样直接短路返回。
  // previousReadyVersion/Path 用于失败时静默回退到 a。
  const wasReady = currentStatus === 'ready';
  const previousReadyVersion = wasReady ? readyVersion : undefined;
  const previousReadyFilePath = wasReady ? readyFilePath : undefined;

  // 只有非 ready 路径才广播 'checking' — wasReady 路径下广播 checking 会让 banner
  // 的可见条件(status === 'ready' || 'superseding')瞬间不满足,banner 抖一下。
  if (!wasReady) {
    setStatus('checking');
  }

  const manifest = manifestOverride ?? await fetchManifest();
  if (!manifest) {
    log.info('Manifest fetch failed');
    if (!wasReady) currentStatus = 'idle';
    return 'manifest_failed';
  }

  const asset = manifest.app.hotfix;
  if (!asset) {
    log.info('No hotfix in manifest');
    if (!wasReady) currentStatus = 'idle';
    return 'idle';
  }

  const latestVersion = manifest.app.version;
  const currentVersion = app.getVersion();
  log.info('Version check: current=%s, latest=%s, ready=%s', currentVersion, latestVersion, previousReadyVersion ?? '<none>');

  if (latestVersion === currentVersion) {
    log.info('Versions match, no update needed');
    if (!wasReady) currentStatus = 'idle';
    return 'idle';
  }

  // wasReady 且 manifest 仍是已下好的同一个版本 → 无事发生,保持 ready。
  if (wasReady && latestVersion === previousReadyVersion) {
    log.info('Ready patch v%s still matches latest — no superseding needed', previousReadyVersion);
    return 'ready';
  }

  log.info('Update available: %s → %s (wasReady=%s)', currentVersion, latestVersion, wasReady);

  const downloadUrl = `${getBaseUrl()}/${asset.file}`;
  const fileName = path.basename(asset.file);
  const destPath = path.join(getUpdatesDir(), fileName);

  // wasReady 路径下,旧的 a.zip 必须保留到 b 通过 SHA 校验之后才能删,否则 b 下载失败
  // 时用户连旧的 a 都装不上了。非 wasReady 路径保持原行为(下载前清理腾空间)。
  if (!wasReady) {
    cleanOldFiles(fileName);
    setStatus('downloading', { version: latestVersion, progress: 0 });
  } else {
    // 广播 superseding,version 字段刻意保留 previousReadyVersion(a),让 banner 顶部
    // 仍然显示「检测到新版本」+ a 信息,直到 b 下完才整体切换。
    setStatus('superseding', { version: previousReadyVersion });
  }

  // Track latest raw counters; updated by onProgress BEFORE normalizer.handle()
  // so by the time normalizer's onIpc fires they already reflect the latest
  // event. Single broadcast path through normalizer keeps the ≤5/sec throttle
  // honoured on BOTH `update-status` and `app-update-progress`. Earlier code
  // had a wrappedNormalizer that broadcast on every raw event AFTER calling
  // normalizer.handle(), which bypassed the throttle and could cause the two
  // channels to receive interleaved-out-of-order updates.
  let lastReceived = 0;
  let lastTotal = typeof asset.size === 'number' ? asset.size : 0;
  let lastSpeed: string | undefined;

  // 显式广播一次 0%:ProgressNormalizer 只在进度上升时才 emit,首个 ≥1% 事件
  // 在大补丁/慢速网络下可能要等数秒,这期间 splash 不知道热更下载已经开始
  // (会停留在 'checking',grace 定时器也看不到 'updating' 而提前放行进 app)。
  // 启动态热更包几乎总是队首(入队即开下),这条 0% 就是"真实开始"的信号;
  // 极少数排在二进制下载之后的场景,renderer 侧会在二进制段活跃期间丢弃它,
  // 不会产生假进度条。后台轮询场景 renderer 以 status==='passed' 挡掉,不受影响。
  if (!wasReady) {
    broadcastUpdateProgress({ progress: 0, received: 0, total: lastTotal });
  }

  // Caller-side progress normalization (clamp + monotonic + throttle).
  const normalizer = new ProgressNormalizer({
    onIpc: (progress) => {
      // Mirror onto BOTH the new status channel (used by useUpdateStatus / banner)
      // AND the legacy `app-update-progress` channel (used by EnvCheckContext
      // splash flow). Keeping the old channel preserves the current renderer
      // contract — see app-update-system-frontend.md ADR-2.
      // wasReady 路径不广播 update-status:banner 期间维持 superseding,version 不变,
      // 否则每次 progress 都会把 status 重新设回 downloading,banner 隐藏闪烁。
      if (!wasReady) {
        broadcastStatus({
          status: 'downloading',
          version: latestVersion,
          progress,
        });
      }
      broadcastUpdateProgress({
        progress,
        received: lastReceived,
        total: lastTotal,
        speed: lastSpeed,
      });
    },
  });

  try {
    const result = await download({
      url: downloadUrl,
      targetPath: destPath,
      sha256: asset.sha256.toLowerCase(),
      expectedSize: typeof asset.size === 'number' ? asset.size : undefined,
      onProgress: (e) => {
        lastReceived = e.loaded;
        if (e.total !== null) lastTotal = e.total;
        lastSpeed = e.speedBps > 0 ? `${formatBytes(e.speedBps)}/s` : undefined;
        normalizer.handle(e);
      },
      onRetry: (e) => {
        log.warn(
          'downloader retry attempt %d in %dms (%s)',
          e.attempt, e.delayMs, e.cause.message,
        );
      },
      onResume: (e) => {
        log.info(
          'downloader resume from %d / %s bytes',
          e.fromBytes, e.totalBytes ?? '?',
        );
      },
      logger: {
        debug: (m, meta) => { /* noisy — silenced in prod */ void meta; void m; },
        info: (m, meta) => log.info(m, meta ?? ''),
        warn: (m, meta) => log.warn(m, meta ?? ''),
        error: (m, meta) => log.error(m, meta ?? ''),
      },
    });

    // Success path. Force the bar to 100 (in case the last raw event was
    // throttled away just before the rename).
    normalizer.flush();
    broadcastUpdateProgress({
      progress: 100,
      received: result.size,
      total: result.size,
    });

    // wasReady 路径下,SHA 已经过了,这时候才真正安全地把旧 a.zip 清掉。
    if (wasReady) {
      cleanOldFiles(fileName);
    }

    const requireRelogin = manifest.app.requireRelogin === true;
    writePatchInfo({
      version: latestVersion,
      fileName,
      sha256: asset.sha256.toLowerCase(),
      requireRelogin,
    });
    // release-relogin-on-update: drop the marker the moment we've committed a
    // good patch on disk. Doing it here (rather than inside the platform
    // executor scripts) keeps the logic cross-platform and avoids touching
    // the .cmd / .sh templates. Worst case the user never relaunches —
    // initialize() will still consume it on the *next* launch, version-gated.
    if (requireRelogin) {
      writeReloginFlag(latestVersion);
    }
    readyVersion = latestVersion;
    readyFilePath = result.path;
    setStatus('ready', { version: latestVersion });
    return 'ready';
  } catch (err) {
    if (err instanceof DownloadError) {
      log.warn(
        'download failed: code=%s message=%s',
        err.code, err.message,
      );
    } else {
      log.error('unexpected download error:', err);
    }

    // wasReady 路径:静默回退到旧的 ready 状态。a.zip / patch-info.json / readyVersion /
    // readyFilePath 全都没动过,直接重新广播 ready 让 banner 按钮从 loading 恢复成可点。
    // 下一次 30min 轮询会再次尝试 b。
    if (wasReady) {
      log.info('Superseding download failed — rolling back to ready v%s', previousReadyVersion);
      readyVersion = previousReadyVersion;
      readyFilePath = previousReadyFilePath;
      setStatus('ready', { version: previousReadyVersion });
      return 'ready';
    }

    // CRITICAL: broadcast the terminal failure so the renderer escapes the
    // "downloading" splash state. Previously a silent return left the splash
    // hung waiting for a 100% that would never arrive — this was one of the
    // three root causes of the prod regression on 2026-04-21.
    broadcastUpdateProgress({
      progress: normalizer.getCurrent(),
      received: lastReceived,
      total: lastTotal,
      failed: true,
      error: err instanceof DownloadError ? err.code : 'UNKNOWN',
    });
    currentStatus = 'error';
    return 'download_failed';
  }
}

// ── Spawn failure handler ─────────────────────────────────────────────────

function handleApplyFailure(reason: string): void {
  log.error('Update apply failed (reason=%s), clearing patch and notifying renderer', reason);
  removePatchInfo();
  readyVersion = undefined;
  readyFilePath = undefined;
  isRelaunching = false;
  autoRelaunchInProgress = false;
  setStatus('error', { errorCode: 'updater_spawn_failed' });
}

// ── F3: Platform Executors ────────────────────────────────────────────────


function executeUpdateWindows(zipPath: string, theme: 'light' | 'dark'): void {
  const appExePath = app.getPath('exe');
  const appDir = path.dirname(appExePath);
  const exeName = path.basename(appExePath);
  const ts = Date.now();
  const lockFilePath = getUpdateLockPath();
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'cindy-update.log');
  const pid = process.pid;

  log.info('Windows relaunch: exe=%s, zip=%s, pid=%d', maskPath(appExePath), maskPath(zipPath), pid);
  try {
    const exeStat = fs.statSync(appExePath);
    const zipStat = fs.statSync(zipPath);
    log.info(
      'pre-update stat: exe size=%d mtime=%s, zip size=%d',
      exeStat.size, exeStat.mtime.toISOString(), zipStat.size,
    );
  } catch (err) {
    log.error('pre-update stat failed:', err);
  }

  // Pre-create one timestamped workdir for this attempt and copy the updater
  // binary into it. The updater puts its `extract/` and `rollback/` subdirs
  // inside the same workdir, so a single rm wipes everything for one attempt.
  // Reason for copying out of resources/ at all: the in-resources copy must
  // itself be replaceable when the updater swaps appDir/* with the new
  // release. Running it from %TEMP% means the in-resources updater copy is no
  // longer file-locked. (electron-updater uses the same trick for elevate.exe.)
  const updaterSrc = path.join(process.resourcesPath, `${BRAND_IDENTITY.updaterName}.exe`);
  const workDir = path.join(os.tmpdir(), `cindy-update-${ts}`);
  // Keep `{ts}` on the binary too so a copy-out for support still carries
  // the attempt timestamp in its filename.
  const updaterRun = path.join(workDir, `${BRAND_IDENTITY.updaterName}-${ts}.exe`);
  if (!fs.existsSync(updaterSrc) || fs.statSync(updaterSrc).size === 0) {
    log.error('updater binary missing at %s — cannot apply update', maskPath(updaterSrc));
    handleApplyFailure('updater_missing');
    return;
  }
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.copyFileSync(updaterSrc, updaterRun);
  } catch (err) {
    log.error('failed to set up updater workdir at %s:', maskPath(workDir), err);
    handleApplyFailure('workdir_setup_failed');
    return;
  }

  // Theme is resolved by the renderer (collapses 'system' via the live DOM
  // class) and forwarded through the `update-relaunch` IPC, so the updater's
  // first frame matches the app the user is currently looking at — even when
  // an in-app override disagrees with the OS preference.
  const args = [
    '--zip', zipPath,
    '--app-dir', appDir,
    '--exe-name', exeName,
    '--pid', String(pid),
    '--log', logPath,
    '--lock', lockFilePath,
    '--theme', theme,
    '--workdir', workDir,
  ];
  log.info('Spawning updater: %s', maskPath(updaterRun));
  log.info('  args: %s', JSON.stringify(args));

  const child = spawn(updaterRun, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });

  const spawnTimeout = setTimeout(() => {
    log.error('updater spawn timed out after 5 s');
    handleApplyFailure('spawn_timeout');
  }, 5_000);

  child.on('spawn', () => {
    clearTimeout(spawnTimeout);
    child.unref();
    forceQuit();
  });

  child.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(spawnTimeout);
    log.error('updater spawn failed: %s (code=%s)', err.message, err.code);
    handleApplyFailure(err.code ?? 'unknown');
  });
}

/**
 * Force-quit, bypassing graceful before-quit handlers. The graceful path can
 * fire async cleanups whose throws would pop a native dialog and block exit —
 * which would block the update script (it polls until our PID disappears).
 */
function forceQuit(): void {
  log.info('forceQuit() — destroying windows and exiting');
  // 本路径绕过 lifecycle 的 before-quit 链 —— 显式给 run marker 打上「更新重启」
  // 标记,否则下次启动的退出尸检会把这次强退误判成异常退出 (issue #758)。
  noteExpectedExit('update-relaunch');
  // 绕过 onQuit 链意味着 disposeAndroidAdb 不会被自动调用——显式 fire-and-forget
  // 收掉自带 adb server,避免它锁住安装目录阻碍 updater 替换文件。
  disposeAndroidAdb();
  // Node 子进程同理——before-quit 的 destroyAll 不会触发,这里同步 kill。
  try { getGhostNodeRuntimeBroker().destroyAll(); } catch { /* best-effort */ }
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  }
  process.exit(0);
}

function executeUpdateMacOS(zipPath: string): void {
  const appPath = path.dirname(path.dirname(path.dirname(app.getAppPath())));
  const appName = path.basename(appPath, '.app');
  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const extractDir = path.join(tmpDir, `xdt-maker-update-${ts}`);
  const scriptPath = path.join(tmpDir, `xdt-maker-update-${ts}.sh`);
  const lockFilePath = getUpdateLockPath();
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'cindy-update.log');
  const pid = process.pid;

  log.info('macOS relaunch: app=%s, zip=%s, pid=%d', maskPath(appPath), maskPath(zipPath), pid);
  // Mirror Windows: capture pre-update identity so the post-mortem log can
  // prove ditto+mv actually replaced the bundle.
  try {
    const appStat = fs.statSync(appPath);
    const zipStat = fs.statSync(zipPath);
    log.info(
      'pre-update stat: app mtime=%s, zip size=%d',
      appStat.mtime.toISOString(), zipStat.size,
    );
  } catch (err) {
    log.error('pre-update stat failed:', err);
  }

  const script = buildMacOSUpdateScript({
    pid, appPath, appName, extractDir, zipPath, lockFilePath, scriptPath, logPath,
  });

  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  forceQuit();
}

function executeRelaunch(theme: 'light' | 'dark'): void {
  if (isRelaunching) {
    log.info('executeRelaunch() skipped — already in progress');
    return;
  }
  isRelaunching = true;

  // translocated bundle 的临时路径不能写入 updater marker，也不能从该只读位置
  // 执行普通热更。
  if (isMacAppTranslocated()) {
    log.error('macOS App Translocation detected — update cannot be applied from read-only path');
    isRelaunching = false;
    autoRelaunchInProgress = false;
    setStatus('error', { errorCode: 'translocated' });
    return;
  }

  log.info('executeRelaunch() called, theme=%s, readyFilePath=%s', theme, maskPath(readyFilePath));
  if (!readyFilePath || !fs.existsSync(readyFilePath)) {
    log.error('No ready update file to apply');
    handleApplyFailure('no_ready_file');
    return;
  }

  // Increment applyAttempts before spawning so that if the updater itself
  // crashes (spawn succeeds → forceQuit → updater fails → old version boots),
  // the counter persists across restarts and eventually breaks the loop.
  incrementApplyAttempts();

  log.info(
    'Executing relaunch with file: %s (%s bytes)',
    maskPath(readyFilePath), fs.statSync(readyFilePath).size,
  );

  switch (process.platform) {
    case 'win32':
      executeUpdateWindows(readyFilePath, theme);
      break;
    case 'darwin':
      executeUpdateMacOS(readyFilePath);
      break;
    case 'linux':
      log.error('Linux in-app update is intentionally disabled in first release');
      handleApplyFailure('linux_update_disabled');
      break;
    default:
      log.error(`Unsupported platform: ${process.platform}`);
      handleApplyFailure('unsupported_platform');
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function initUpdateService(): void {
  // Best-effort cleanup of >7-day-old `cindy-update*`/`xdt-update*` leftovers in %TEMP%.
  // Counterpart to the Rust updater's own sweep — covers the case where the
  // user stays on the latest version and never triggers another updater run.
  sweepStaleUpdateTempDirs();

  ipcMain.on('update-relaunch', (_event, theme: 'light' | 'dark') => {
    // Defensive default: if an old preload is somehow loaded (or theme is
    // missing), fall back to dark — matches the renderer's getStoredTheme()
    // default and the .env'd-out look most users have.
    const resolved = theme === 'light' || theme === 'dark' ? theme : 'dark';
    resolvedRelaunchTheme = resolved;
    executeRelaunch(resolved);
  });

  ipcMain.handle(
    'update-relaunch-auto',
    async (_event, theme: 'light' | 'dark'): Promise<AutoRelaunchRequestResult> => {
      // Startup checks and the renderer's 1.5 s presentation delay create a
      // real TOCTOU window. Re-run the startup policy at the apply boundary so a
      // settings change / already-in-flight relaunch cannot be cut off by a
      // stale decision. (Startup deliberately does not gate on idle/busy — there
      // is no in-flight work to protect at a fresh launch.)
      const resolved = theme === 'light' || theme === 'dark' ? theme : 'dark';
      resolvedRelaunchTheme = resolved;
      const result = await requestAutoRelaunch('startup-apply-boundary', resolved, true);
      if (!result.accepted) {
        log.info(
          'startup automatic relaunch deferred at apply boundary (%s)',
          result.blockReason ?? 'unknown',
        );
      }
      return result;
    },
  );

  ipcMain.handle('update-get-status', () => {
    return { status: currentStatus, version: readyVersion, errorCode: lastErrorCode };
  });

  ipcMain.handle('update-auto-settings-get', () => {
    return autoUpdateSettingsWire();
  });

  ipcMain.handle('update-auto-settings-set', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') {
      throwIpcError('INVALID_PARAMS', 'auto update settings payload required');
    }
    const next = (payload as { autoRelaunchOnIdle?: unknown }).autoRelaunchOnIdle;
    if (typeof next !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'autoRelaunchOnIdle required (boolean)');
    }
    writeAutoRelaunchOnIdle(next);
    void evaluateAutoRelaunch('settings-set');
    return autoUpdateSettingsWire();
  });

  ipcMain.handle('update-auto-settings-reset', () => {
    resetAutoUpdateSettings();
    void evaluateAutoRelaunch('settings-reset');
    return autoUpdateSettingsWire();
  });

  ipcMain.on('update-set-relaunch-theme', (_event, theme: 'light' | 'dark') => {
    if (theme === 'light' || theme === 'dark') {
      resolvedRelaunchTheme = theme;
    }
  });

  ipcMain.handle('update-move-to-applications', () => {
    if (process.platform !== 'darwin') return { moved: false };
    if (app.isInApplicationsFolder()) return { moved: false };
    try {
      app.moveToApplicationsFolder();
      return { moved: true };
    } catch (err) {
      log.error('moveToApplicationsFolder failed:', err);
      return { moved: false };
    }
  });

  ipcMain.handle('update-check-now', async (): Promise<{ result: CheckForUpdateResult | 'downloading' }> => {
    // Short-circuit when a check / download is already in flight or finished:
    // we don't want the user to wait for an entire download just to see the
    // toast, and re-entering checkForUpdate() during 'downloading' would
    // simply re-attach to the same in-flight Promise (still slow to respond).
    // 'superseding' 等价于"已经在 ready 之上偷偷下新版了",对用户来说也是「正在下载」,
    // 这里复用 'downloading' 结果让前端 toast 文案保持一致。
    if (currentStatus === 'downloading') return { result: 'downloading' };
    if (currentStatus === 'superseding') return { result: 'downloading' };
    if (currentStatus === 'ready')       return { result: 'ready' };
    const result = await checkForUpdate();
    return { result };
  });

  ipcMain.handle('update-check-startup', async () => {
    log.info('update-check-startup called');
    startupUpdateCheckInProgress = true;
    try {
      if (isDev()) {
        return { hasUpdate: false, action: 'none' as const };
      }

      // 版本无关包(占位 0.0.0)整条启动更新链都豁免——不只 doCheckForUpdate:
      // 本 handler 在调 checkForUpdate() 之前还有"本地 patch 直接 relaunch"的
      // 快路径(下方 Step 1/2)。版本无关包与正式版同 userData,一台跑过正式版
      // 的机器 updates/ 里可能残留已下好的 patch,不在这里挡住会把 0.0.0 安装体
      // 启动即替换成线上版本。
      if (isVersionlessAppVersion(app.getVersion())) {
        log.info('Versionless build (placeholder %s) — skipping startup update flow', app.getVersion());
        return { hasUpdate: false, action: 'none' as const };
      }

      // Step 1: prefer manifest (so we don't relaunch into a stale intermediate version).
      // 启动态用短超时，避免 external CDN 慢时阻塞启动关键路径（#26）。
      // 后台 30-min 轮询仍走默认 30s 超时。
      const manifest = await fetchManifest(STARTUP_MANIFEST_TIMEOUT_MS);

      if (!manifest) {
        // Network unavailable — fall back to local patch.
        log.info('Manifest fetch failed, falling back to local patch');
        const patchResult = checkExistingPatch();
        if (patchResult.action === 'relaunch') {
          currentStatus = 'ready';
          return await buildStartupReadyReply(patchResult.version);
        }
        return { hasUpdate: false, action: 'none' as const, error: 'manifest_failed' as const };
      }

      const latestVersion = manifest.app.version;
      const currentVersion = app.getVersion();
      log.info('Startup: current=%s, latest=%s', currentVersion, latestVersion);

      if (latestVersion === currentVersion) {
        // Already up to date — clean up any stale patch directory.
        checkExistingPatch();
        return { hasUpdate: false, action: 'none' as const };
      }

      // Step 2: local patch may already match latest → skip download.
      const patchResult = checkExistingPatch();
      if (patchResult.action === 'relaunch' && patchResult.version === latestVersion) {
        log.info('Local patch v%s matches latest, requesting relaunch', patchResult.version);
        currentStatus = 'ready';
        return await buildStartupReadyReply(patchResult.version);
      }

      // Stale local patch — drop refs, fresh download will overwrite.
      if (patchResult.action === 'relaunch') {
        log.info(
          'Stale patch v%s (latest is v%s), will re-download',
          patchResult.version, latestVersion,
        );
        readyVersion = undefined;
        readyFilePath = undefined;
      }

      // Step 3: download (re-using the manifest we already have). Route through
      // checkForUpdate() so the inFlightCheck guard catches a concurrent
      // background poll that would otherwise start a duplicate download against
      // the same destPath.
      const result = await checkForUpdate(manifest);
      log.info('Startup download result: %s', result);

      if (result === 'manifest_failed') {
        log.info('[diag] update-check-startup returning error=manifest_failed');
        return { hasUpdate: false, action: 'none' as const, error: 'manifest_failed' as const };
      }
      if (result === 'download_failed') {
        // We KNOW there is a newer version (manifest already confirmed); we just
        // couldn't pull the file. hasUpdate=true keeps the renderer in splash so
        // a "download failed, retry" dialog shows instead of falling through to
        // phase 2 with the stale binary.
        log.info('[diag] update-check-startup returning error=download_failed');
        return { hasUpdate: true, action: 'none' as const, error: 'download_failed' as const };
      }
      const reply =
        currentStatus === 'ready'
          ? await buildStartupReadyReply(readyVersion)
          : { hasUpdate: false, action: 'none' as const, version: readyVersion };
      // Diagnostic: 时间戳就是 reply 在主进程被推上 IPC 的瞬间，配合 broadcastUpdateProgress
      // 的 [diag] 日志可以还原"reply 与 progress 事件谁先到渲染端"的顺序——这是 splash 100%
      // 卡死的关键证据。
      log.info(
        '[diag] update-check-startup returning hasUpdate=%s action=%s version=%s',
        reply.hasUpdate,
        reply.action,
        reply.version ?? '<none>',
      );
      return reply;
    } finally {
      startupUpdateCheckInProgress = false;
    }
  });

  if (isDev()) {
    log.info('Dev mode — skipping background polling');
    return;
  }

  startAutoRelaunchPoller();
  powerMonitor.on('resume', handlePowerMonitorActivity);
  powerMonitor.on('unlock-screen', handlePowerMonitorActivity);
  powerMonitor.on('user-did-become-active', handlePowerMonitorActivity);

  setTimeout(() => {
    log.info('First background check fires');
    checkForUpdate().catch((err) => {
      log.error('Background check threw:', err);
    });

    pollTimer = setInterval(() => {
      log.info('Poll timer fires');
      checkForUpdate().catch((err) => {
        log.error('Poll check threw:', err);
      });
    }, POLL_INTERVAL_MS);
  }, FIRST_CHECK_DELAY_MS);

  log.info('Initialized — first check in 10s, polling every 30min');
}

export function stopUpdateService(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (autoRelaunchPollTimer) {
    clearInterval(autoRelaunchPollTimer);
    autoRelaunchPollTimer = null;
  }
  powerMonitor.removeListener('resume', handlePowerMonitorActivity);
  powerMonitor.removeListener('unlock-screen', handlePowerMonitorActivity);
  powerMonitor.removeListener('user-did-become-active', handlePowerMonitorActivity);
}
