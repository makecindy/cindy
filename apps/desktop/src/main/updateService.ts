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

import {
  acquirePiSubagentLaunchFence,
  hasActivePiSubagentRunsSync,
  requestStopAllPiSubagentRunsSync,
  stopAllPiSubagentRunsForExit,
} from '@cindy/maker-core/pi-subagent-runs';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

import { fetchManifest, getBaseUrl, isDev, probeBetaManifest, clearCachedManifest } from './manifestService';
import type { Manifest } from './manifestService';
import { download, DownloadError } from './downloader/index';
import { ProgressNormalizer } from './updateProgressNormalizer';
import { compareAppUpdateVersions } from './updateVersionPolicy';

import { createLogger, maskPath } from './logger';
import {
  readAutoUpdateSettings,
  readAutoUpdateSettingsState,
  resetAutoUpdateSettings,
  writeAutoRelaunchOnIdle,
} from './auto-update-settings-store';
import {
  isEnableBetaUserCustomized,
  readUpdateChannelSettings,
  resetUpdateChannelSettings,
  tryEnableUncustomizedBetaAtomic,
  writeEnableBeta,
} from './updateChannelStore';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';
import {
  AUTO_UPDATE_IDLE_THRESHOLD_SECONDS,
  getAutoRelaunchBlockReason,
  type AutoRelaunchBlockReason,
} from './updateAutoRelaunchPolicy';
import { throwIpcError } from './utils/ipcValidate';
import { noteExpectedExit } from './startup-diagnostics';
import { buildMacOSUpdateScript } from './updateScriptMacOS';
import { buildLinuxUpdateScript, normalizeLinuxDebSha256 } from './updateScriptLinux';
import { disposeAndroidAdb } from './mcp-integrations/android';
import { abortIOSSimulatorOperationsForExit } from './mcp-integrations/ios-simulator-exit';
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
  /**
   * 下载这份补丁时的有效渠道。共库另一实例在本进程停机期间切过渠道后,
   * 冷启动读盘对账会丢掉这份旧包,避免 manifest 失败时把旧渠道 zip 当匹配补丁装上。
   * 旧 patch-info 没有这个字段,保持原行为。
   */
  enableBeta?: boolean;
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
/** 当前 staged 补丁对应的渠道代际。延迟清理用它区分「同路径上的新旧包」。 */
let readyChannelEpoch: number | undefined;
/**
 * 更新渠道代际计数:用户在下载进行中关掉 beta(clearStagedPatch)时 +1,
 * 让 in-flight 的 checkForUpdate 在写回 patch-info / 恢复旧 patch 前察觉
 * 「渠道已变」,放弃本次下载产物,避免 opt-out 后仍被装到 beta 版本。
 */
let updateChannelEpoch = 0;
/** 本进程上次看到的有效渠道。别的共库实例改开关后,用这个发现跨进程渠道变化。 */
let observedEnableBeta = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let autoRelaunchPollTimer: ReturnType<typeof setInterval> | null = null;
let isRelaunching = false;
let lastErrorCode: string | undefined;
let autoRelaunchInProgress = false;
/** 资格检查(含异步 busyProbe)进行中的次数。这段窗口暂缓清补丁。 */
let autoRelaunchDecisionDepth = 0;
/**
 * 资格检查期间要求作废的那份旧补丁。
 * 用路径 + 代际一起记:release / beta 资产 basename 相同时,新包会写回同一
 * readyFilePath,只比路径会把刚下好的新渠道补丁清掉。
 */
let deferredStagedPatch: { path?: string; epoch?: number } | undefined;
/** 并发渠道写入各自持有一次 hold。失败只能放自己那次,不能清掉别人的保护。 */
let pendingChannelChangeHolds = 0;
/** 已经落盘成功的渠道切换。后续失败写入不能把这笔作废请求清掉。 */
let committedChannelChangeInvalidation = false;
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

function channelSettingsWire() {
  return {
    enableBeta: process.platform === 'linux' ? false : readUpdateChannelSettings().enableBeta,
    isCustomized: isEnableBetaUserCustomized(),
  };
}

function broadcastChannelSettings(): void {
  const payload = channelSettingsWire();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('update-channel-settings', payload);
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
    requiresInteractiveAuth: process.platform === 'linux',
  });
}

/**
 * Startup/splash relaunch gate — intentionally looser than the background idle
 * policy. Startup is the safest moment to apply a staged patch: the app has just
 * launched, so there is no in-flight agent turn / schedule / active session to
 * interrupt. We therefore relaunch into the updater as soon as a patch is ready,
 * gating only on the essentials:
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
  if (isDev()) return 'dev';
  if (currentStatus !== 'ready') return 'not-ready';
  if (isRelaunching || autoRelaunchInProgress) return 'relaunching';
  // pkexec 必须用户在场输入密码，启动时不能自己装。
  if (process.platform === 'linux') return 'interactive-auth';
  return null;
}

/**
 * Startup update checks apply a staged patch as soon as it is ready (the historic
 * behavior), gated only by the lightweight startup policy above. Whenever that
 * policy blocks (dev / not ready / relaunching) the
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
  // 资格检查开始就抬深度:后台路径会 await busyProbe,这段空窗里 clearStagedPatch
  // 若放行,随后 executeRelaunch 会走 no_ready_file。
  autoRelaunchDecisionDepth += 1;
  try {
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

    if (syncObservedUpdateChannel()) {
      log.info('auto relaunch aborted — shared update channel changed');
      markCommittedChannelChangeInvalidation();
      return { accepted: false, blockReason: 'not-ready' };
    }

    if (shouldAbortStagedPatchApply()) {
      log.info('auto relaunch aborted — update channel changed during eligibility check');
      return { accepted: false, blockReason: 'not-ready' };
    }

    if (!readyFilePath || !fs.existsSync(readyFilePath)) {
      log.info('auto relaunch aborted — staged patch disappeared during eligibility check');
      return { accepted: false, blockReason: 'not-ready' };
    }

    lastAutoRelaunchBlockReason = null;
    autoRelaunchInProgress = true;
    log.info('auto relaunch conditions met (%s), applying update v%s', reason, readyVersion ?? '<unknown>');
    void executeRelaunch(theme);
    return { accepted: true };
  } finally {
    autoRelaunchDecisionDepth = Math.max(0, autoRelaunchDecisionDepth - 1);
    if (autoRelaunchDecisionDepth === 0 && !isRelaunching && !autoRelaunchInProgress) {
      flushDeferredStagedPatchClear();
    }
  }
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
 * Snapshot of the current update lifecycle state. Prefer
 * `isUpdateRelaunchImminent()` for gating side-effects — a staged patch does
 * NOT imply a relaunch is coming (see below).
 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

/**
 * Whether this process is actually about to be replaced by the updater.
 *
 * Callers use this to gate side-effects that would be torn down seconds later
 * (e.g. don't bring the FeishuBot online right before a relaunch — it would go
 * offline again immediately and spam the owner with a needless online/offline
 * pair).
 *
 * This is deliberately NOT `status === 'downloading' | 'ready'`: `ready` only
 * means "a patch is staged", and a staged patch stays staged forever when the
 * user turned auto-relaunch off (`getStartupRelaunchBlockReason() → 'disabled'`)
 * or on a dev build. Gating on the raw status made every cold boot of an
 * out-of-date install re-observe `ready` and skip the side-effect again, so the
 * "we'll do it on the next cold boot" fallback could never fire — the IM
 * transport stayed down permanently and `feishuBot:save` failed with
 * `[IM_NOT_READY]` until the user manually applied the update.
 *
 * When auto-relaunch IS on, a `ready` patch that is currently blocked by the
 * idle/busy policy still counts as imminent: the poller applies it once the app
 * goes idle, and the following cold boot is up to date and ungated.
 */
export function isUpdateRelaunchImminent(): boolean {
  // Already committed — the updater is spawning / windows are tearing down.
  if (isRelaunching || autoRelaunchInProgress) return true;
  // Nothing staged or being staged can relaunch us.
  if (currentStatus !== 'downloading' && currentStatus !== 'ready') return false;
  // The native updater replaces the *installed* app; it never runs in dev.
  if (isDev()) return false;
  // Linux 安装要 pkexec 密码，不会在空闲/启动时自己装。
  if (process.platform === 'linux') return false;
  // Respecting the user's switch: with auto-relaunch off the patch just sits
  // there until they click the banner, which is not "imminent".
  return readAutoUpdateSettings().autoRelaunchOnIdle;
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
    if (
      typeof patchInfo.version !== 'string' ||
      !patchInfo.version ||
      typeof patchInfo.fileName !== 'string' ||
      !patchInfo.fileName
    ) {
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

  const currentEnableBeta = readUpdateChannelSettings().enableBeta;
  if (typeof patchInfo.enableBeta === 'boolean' && patchInfo.enableBeta !== currentEnableBeta) {
    log.info(
      'discarding staged patch v%s from another update channel (patch=%s current=%s)',
      patchInfo.version,
      patchInfo.enableBeta ? 'beta' : 'release',
      currentEnableBeta ? 'beta' : 'release',
    );
    discardExistingPatch(patchInfo, patchFilePath, true);
    return { action: 'check' };
  }

  const currentVersion = app.getVersion();
  const versionRelation = compareAppUpdateVersions(patchInfo.version, currentVersion);
  if (versionRelation === 'same') {
    // Patch matches current version → already applied; clean up and re-check.
    // Keep the matching relogin flag: auth initialization owns consuming it.
    discardExistingPatch(patchInfo, patchFilePath, false);
    return { action: 'check' };
  }
  if (versionRelation !== 'newer') {
    log.warn(
      'discarding non-upgrade staged patch: current=%s patch=%s relation=%s',
      currentVersion,
      patchInfo.version,
      versionRelation,
    );
    discardExistingPatch(patchInfo, patchFilePath, true);
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
  readyChannelEpoch = updateChannelEpoch;
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

function discardExistingPatch(
  patchInfo: PatchInfo,
  patchFilePath: string,
  clearMatchingReloginFlag: boolean,
): void {
  try { fs.unlinkSync(patchFilePath); } catch { /* ignore */ }
  removePatchInfo();
  if (!clearMatchingReloginFlag) return;
  const flag = readReloginFlag();
  if (flag?.version === patchInfo.version) {
    clearReloginFlag();
  }
}

function isUpdateApplyCommitted(): boolean {
  return isRelaunching || autoRelaunchInProgress;
}

function invalidateInFlightChannelDownloads(): void {
  updateChannelEpoch += 1;
  clearCachedManifest();
}

function readObservedEnableBetaFromDisk(): boolean {
  return readUpdateChannelSettings().enableBeta;
}

function restoreObservedEnableBetaFromDisk(): boolean {
  const enableBeta = readObservedEnableBetaFromDisk();
  const changed = enableBeta !== observedEnableBeta;
  observedEnableBeta = enableBeta;
  return changed;
}

function syncObservedUpdateChannel(): boolean {
  if (pendingChannelChangeHolds > 0) return false;
  const enableBeta = readObservedEnableBetaFromDisk();
  if (enableBeta === observedEnableBeta) return false;
  observedEnableBeta = enableBeta;
  invalidateInFlightChannelDownloads();
  return true;
}

function shouldAbortStagedPatchApply(): boolean {
  if (pendingChannelChangeHolds > 0) return true;
  if (!deferredStagedPatch) return false;
  return !isCurrentPatchNewerThanDeferred(deferredStagedPatch);
}

function rememberDeferredStagedPatch(): void {
  deferredStagedPatch = {
    path: readyFilePath ?? deferredStagedPatch?.path,
    epoch: readyChannelEpoch ?? deferredStagedPatch?.epoch,
  };
}

function markCommittedChannelChangeInvalidation(): void {
  committedChannelChangeInvalidation = true;
  rememberDeferredStagedPatch();
}

function clearChannelChangeInvalidation(): void {
  pendingChannelChangeHolds = 0;
  committedChannelChangeInvalidation = false;
  deferredStagedPatch = undefined;
}

/** 先拦住 apply,不删 zip / patch-info。写入没成功时还能继续用这份补丁。 */
function holdStagedPatchForPendingChannelChange(): void {
  pendingChannelChangeHolds += 1;
  rememberDeferredStagedPatch();
}

/** 只放掉本次未提交的 hold。已落盘或共库已切渠道的作废请求必须留下。 */
function releasePendingChannelChangeHold(): void {
  pendingChannelChangeHolds = Math.max(0, pendingChannelChangeHolds - 1);
  if (pendingChannelChangeHolds === 0 && !committedChannelChangeInvalidation) {
    deferredStagedPatch = undefined;
  }
}

/**
 * 本次写入没提交。磁盘若已被别的实例改过,转成交割作废,不能把别人的标记清掉。
 */
function abandonPendingChannelChangeHold(): void {
  if (restoreObservedEnableBetaFromDisk()) {
    commitPendingChannelChange();
    return;
  }
  releasePendingChannelChangeHold();
}

/** 本次写入已经改到盘上。后续失败的并发写入不能再放开 apply。 */
function commitPendingChannelChange(): void {
  pendingChannelChangeHolds = Math.max(0, pendingChannelChangeHolds - 1);
  markCommittedChannelChangeInvalidation();
}

function isCurrentPatchNewerThanDeferred(
  stale: { path?: string; epoch?: number },
): boolean {
  if (readyChannelEpoch != null && stale.epoch != null) {
    return readyChannelEpoch > stale.epoch;
  }
  return Boolean(readyFilePath && readyFilePath !== stale.path);
}

function discardStagedPatchFiles(): void {
  // A background manifest check can resume while the native updater is already
  // reading this same file. Keep the patch intact in that window; the apply
  // path owns cleanup after it either succeeds or reports a spawn failure.
  if (isUpdateApplyCommitted()) {
    log.info('skipping staged patch discard — update apply already in flight');
    return;
  }
  if (autoRelaunchDecisionDepth > 0) {
    rememberDeferredStagedPatch();
    // Keep the payload until the async eligibility check settles, but remove
    // the marker now so a channel/app relaunch cannot revive this patch.
    removePatchInfo();
    log.info('deferring staged patch discard until auto-relaunch eligibility settles');
    return;
  }
  const discardedVersion = readyVersion;
  if (readyFilePath) {
    try { fs.unlinkSync(readyFilePath); } catch { /* ignore */ }
  }
  readyVersion = undefined;
  readyFilePath = undefined;
  readyChannelEpoch = undefined;
  linuxStagedDebSha256 = null;
  linuxStagedDebSize = null;
  removePatchInfo();
  const flag = discardedVersion ? readReloginFlag() : null;
  if (flag?.version === discardedVersion) {
    clearReloginFlag();
  }
  if (
    currentStatus === 'ready' ||
    currentStatus === 'superseding' ||
    currentStatus === 'downloading'
  ) {
    setStatus('idle');
  }
}

function flushDeferredStagedPatchClear(): void {
  if (!deferredStagedPatch) return;
  if (isUpdateApplyCommitted() || autoRelaunchDecisionDepth > 0) return;
  if (pendingChannelChangeHolds > 0) return;
  const stale = deferredStagedPatch;
  if (currentStatus === 'downloading' || currentStatus === 'superseding') {
    // 新渠道下载还在飞:不要再推进代际,也不要删同路径 dest。
    // 标记先留着——下载失败若把旧补丁快照写回来,后续还能再清。
    if (readyChannelEpoch === stale.epoch) {
      readyVersion = undefined;
      readyFilePath = undefined;
      readyChannelEpoch = undefined;
    }
    return;
  }
  clearChannelChangeInvalidation();
  if (isCurrentPatchNewerThanDeferred(stale)) {
    log.info('keeping newer staged patch after deferred channel-change clear');
    if (stale.path && stale.path !== readyFilePath) {
      try { fs.unlinkSync(stale.path); } catch { /* ignore */ }
    }
    return;
  }
  discardStagedPatchFiles();
}

/**
 * 渠道切换重启前把未应用的旧补丁从盘上拿掉。
 * 延迟清理只活在内存里,这里不补清的话,下次启动仍可能把旧渠道 zip 当匹配补丁装上。
 */
function discardUnappliedStagedPatchForChannelRelaunch(): void {
  if (isUpdateApplyCommitted()) return;
  clearChannelChangeInvalidation();
  discardStagedPatchFiles();
}

/**
 * 清掉已 staged 的补丁(ready 态):删 zip + patch-info.json,状态回 idle。
 * 切渠道时调用——opt-out 后不能仍让 staged 的旧渠道 patch 在下次启动/后台
 * 轮询里被装上去(切渠道不等于切版本,必须把旧渠道的补丁作废)。
 * 已经开始应用时不能清,否则 executeRelaunch 会走 no_ready_file。
 * 资格检查还在等 busyProbe 时先记下 zip,但立刻丢掉 patch-info,
 * 避免用户马上切渠道重启后旧补丁跨进程复活。
 */
function clearStagedPatch(): void {
  if (isUpdateApplyCommitted()) {
    log.info('skipping staged patch clear — update apply already in flight');
    return;
  }
  if (autoRelaunchDecisionDepth > 0) {
    rememberDeferredStagedPatch();
    // 立刻作废旧渠道 in-flight 下载,避免下载完成后又把旧补丁写成 ready。
    invalidateInFlightChannelDownloads();
    // patch-info 立刻拿掉:渠道重启走 app.quit(),等不到 probe/finally。
    removePatchInfo();
    log.info('deferring staged patch clear until auto-relaunch eligibility settles');
    return;
  }
  invalidateInFlightChannelDownloads();
  discardStagedPatchFiles();
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

/**
 * mac/win 热更下 hotfix zip；Linux 没有 hotfix，清单只挂 installer .deb。
 * 非 .deb 的 Linux installer 直接丢掉，避免把任意文件交给 pkexec。
 */
function resolveUpdateAsset(manifest: Manifest): { file: string; sha256: string; size: number } | undefined {
  if (process.platform === 'linux') {
    const installer = manifest.app.installer;
    if (!installer?.file || !installer.sha256) return undefined;
    if (!installer.file.toLowerCase().endsWith('.deb')) {
      log.error('Linux installer is not a .deb, refusing in-app update: %s', installer.file);
      return undefined;
    }
    return installer;
  }
  return manifest.app.hotfix;
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
  // 先跟共享设置对一次有效渠道:共库另一实例改过开关时,本进程内存代际还停在旧值。
  if (syncObservedUpdateChannel()) {
    log.info('shared update channel changed — discarding staged patch before check');
    clearStagedPatch();
    return 'idle';
  }
  // 快照发起时的渠道代际;下载期间若用户 opt-out(clearStagedPatch 递增),
  // 成功/失败写回前都据此作废本次产物。
  const channelEpochAtStart = updateChannelEpoch;
  const channelEnableBetaAtStart = observedEnableBeta;

  if (isVersionlessAppVersion(app.getVersion())) {
    log.info('Versionless build (placeholder %s) — in-app update disabled', app.getVersion());
    currentStatus = 'idle';
    return 'idle';
  }

  // wasReady 路径:本地已经下好了 a 版本,正在等用户点重启。这次轮询要继续做版本对比,
  // 发现 b > a 时进入 superseding 状态去下 b,而不是像旧实现那样直接短路返回。
  // previousReadyVersion/Path 用于失败时静默回退到 a。
  const wasReady = currentStatus === 'ready';
  const previousReadyVersion = wasReady ? readyVersion : undefined;
  const previousReadyFilePath = wasReady ? readyFilePath : undefined;
  const previousReadyChannelEpoch = wasReady ? readyChannelEpoch : undefined;

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

  const latestVersion = manifest.app.version;
  const currentVersion = app.getVersion();
  log.info('Version check: current=%s, latest=%s, ready=%s', currentVersion, latestVersion, previousReadyVersion ?? '<none>');

  const versionRelation = compareAppUpdateVersions(latestVersion, currentVersion);
  if (versionRelation === 'invalid') {
    log.error(
      'Refusing app update because version comparison is invalid: current=%s latest=%s',
      currentVersion,
      latestVersion,
    );
    if (wasReady) {
      discardStagedPatchFiles();
    } else {
      currentStatus = 'idle';
    }
    return 'manifest_failed';
  }
  if (versionRelation === 'same') {
    log.info('Versions match, no update needed');
    if (wasReady) {
      log.info('Discarding staged patch because the current manifest no longer advertises an upgrade');
      discardStagedPatchFiles();
    } else {
      currentStatus = 'idle';
    }
    return 'idle';
  }
  if (versionRelation === 'older') {
    log.warn(
      'Skipping app downgrade from %s to %s',
      currentVersion,
      latestVersion,
    );
    if (wasReady) {
      discardStagedPatchFiles();
    } else {
      currentStatus = 'idle';
    }
    return 'idle';
  }

  const asset = resolveUpdateAsset(manifest);
  if (!asset) {
    log.info(process.platform === 'linux' ? 'No installer in Linux manifest' : 'No hotfix in manifest');
    if (wasReady) {
      discardStagedPatchFiles();
    } else {
      currentStatus = 'idle';
    }
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

    // 下载期间用户切渠道(渠道代际已变):放弃这次下载的产物,不写 patch-info。
    // 否则会重新落盘一份旧渠道 patch,用户切渠道后仍被呈现旧版本更新。
    if (channelEpochAtStart !== updateChannelEpoch) {
      log.info('update channel changed during download — discarding patch v%s', latestVersion);
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      // 必须 setStatus:切渠道可能发生在请求仍在 checking 阶段时(clearStagedPatch
      // 不覆盖 checking),本分支之前已被 setStatus('downloading'),不归位的话
      // update-check-now 会一直 short-circuit 返回 downloading。
      setStatus('idle');
      return 'idle';
    }

    const requireRelogin = manifest.app.requireRelogin === true;
    writePatchInfo({
      version: latestVersion,
      fileName,
      sha256: asset.sha256.toLowerCase(),
      requireRelogin,
      enableBeta: channelEnableBetaAtStart,
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
    readyChannelEpoch = updateChannelEpoch;
    // 信任锚:manifest 里的 installer 摘要与大小,进本进程内存,不落用户可写盘。
    linuxStagedDebSha256 = normalizeLinuxDebSha256(asset.sha256 ?? '');
    linuxStagedDebSize = typeof asset.size === 'number' && asset.size > 0 ? asset.size : null;
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
      // 下载期间用户切渠道:旧 patch 已被作废,不能从局部快照恢复。
      // 代际在下载开始前就可能已经推进过,所以还要看旧补丁自己的代际。
      const staleChannelPatch =
        channelEpochAtStart !== updateChannelEpoch ||
        (previousReadyChannelEpoch != null && previousReadyChannelEpoch !== updateChannelEpoch);
      if (staleChannelPatch) {
        log.info('update channel changed during superseding download — not restoring stale patch');
        if (previousReadyFilePath) {
          try { fs.unlinkSync(previousReadyFilePath); } catch { /* ignore */ }
        }
        readyVersion = undefined;
        readyFilePath = undefined;
        readyChannelEpoch = undefined;
        removePatchInfo();
        setStatus('idle');
        return 'idle';
      }
      log.info('Superseding download failed — rolling back to ready v%s', previousReadyVersion);
      readyVersion = previousReadyVersion;
      readyFilePath = previousReadyFilePath;
      readyChannelEpoch = previousReadyChannelEpoch;
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
  readyChannelEpoch = undefined;
  isRelaunching = false;
  autoRelaunchInProgress = false;
  // Every failure exit converges here, including the two that fire *after*
  // `executeRelaunch` has already returned: the Windows updater registers its
  // `error` and 5s spawn-timeout callbacks and returns immediately, so
  // `isRelaunching` was still true when the outer `finally` checked it and the
  // fence was skipped. It then stood for the rest of the process's life, and
  // every durable Subagent launch this host attempted was refused as "Cindy is
  // restarting". Releasing here covers the synchronous refusals too, where it
  // is simply redundant — `clearSubagentLaunchFence` nulls the handle first, so
  // the outer `finally` finds nothing left to do.
  //
  // Not awaited, because nothing here can: this is a `void` handler called from
  // a child-process event. Nothing reads the outcome — the only consumer is the
  // next launch attempt — and the release itself is serialised behind the
  // fence's per-file work chain. The success path never reaches this function:
  // a spawned updater ends in `forceQuit()`, and the fence is meant to stand.
  void clearSubagentLaunchFence().catch((err: unknown) => {
    log.error('clearing the Subagent launch fence after a failed apply failed: %s', String(err));
  });
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
  // build_app uses detached process groups, so parent exit does not reliably
  // reap xcodebuild. Abort synchronously before process.exit bypasses Host dispose.
  abortIOSSimulatorOperationsForExit();
  // Residual window only, and now a millisecond-scale one: `executeRelaunch`
  // reclaimed this runtime's runners and then confirmed the agent home was
  // still quiet, refusing to get here otherwise. What is left is the gap
  // between that confirmation and this exit. Stays synchronous by necessity —
  // awaiting anything here can pop a dialog and stall the updater's pid poll.
  requestStopAllPiSubagentRunsSync(path.join(app.getPath('userData'), 'pi-agent-home'), {
    hostPid: process.pid,
  });
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

/**
 * Live launch fence, held from the first reclaim pass until the process exits.
 * Cleared on every cancellation path, so a refused relaunch cannot leave this
 * host unable to start Subagents.
 */
let releaseSubagentLaunchFence: (() => Promise<void>) | null = null;

async function clearSubagentLaunchFence(): Promise<void> {
  const release = releaseSubagentLaunchFence;
  releaseSubagentLaunchFence = null;
  if (release) await release().catch(() => undefined);
}

/** Total ceiling for the reclaim, including every re-check round. */
const SUBAGENT_RECLAIM_TOTAL_MS = 6_000;
/** Rounds before we stop trying and cancel the relaunch instead. */
const SUBAGENT_RECLAIM_MAX_ROUNDS = 3;

/**
 * One reclaim pass over this runtime's durable Subagent runners.
 *
 * Budget: 2s for the stop mailbox plus a 1.5s ceiling on the escalation (the
 * reclaims run concurrently), with a 4s race as the hard stop so a wedged probe
 * can never hold the update — and never pops a dialog, which is the whole
 * reason this path bypasses the graceful chain.
 */
async function reclaimSubagentRunnersOnce(agentHome: string): Promise<boolean> {
  try {
    return await Promise.race([
      stopAllPiSubagentRunsForExit(agentHome, 2_000, {
        // Scoped to this process so an update relaunch never kills a concurrent
        // instance's Subagents out of the shared agent home.
        hostPid: process.pid,
        killUnresponsiveRunners: true,
        // Inside the 4s ceiling below, leaving the 2s stop wait its own room.
        killBudgetMs: 1_500,
      }),
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 4_000); }),
    ]);
  } catch (err) {
    log.error('Subagent reclaim before update relaunch failed: %s', String(err));
    return false;
  }
}

/**
 * Reclaim until the agent home is *stable*, not merely until one pass says so.
 *
 * A single pass proves nothing about the moment after it: the parent task is
 * still running while we work, so it can launch another durable runner between
 * the last scan and `process.exit(0)` — and that one would survive the update
 * with credentials nobody is left holding. Stability here means a pass returned
 * true and a fresh scan afterwards finds nothing active; anything else gets
 * another round, up to a hard ceiling. Failing to reach it cancels the
 * relaunch, which is the same verdict as failing to reclaim.
 */
async function reclaimSubagentRunnersForRelaunch(): Promise<boolean> {
  const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
  // Close the door before the first sweep, not after the last one. The spawn
  // that has to be prevented happens inside the Pi process, in an extension the
  // Host never calls, so re-scanning can only ever narrow the window — the
  // fence removes it. The loop below then clears whatever was already in flight
  // when the door closed. Released by the caller on every exit path.
  releaseSubagentLaunchFence = await acquirePiSubagentLaunchFence(agentHome).catch((err) => {
    log.error('Could not raise the Subagent launch fence: %s', String(err));
    return null;
  });
  if (!releaseSubagentLaunchFence) return false;
  const deadline = Date.now() + SUBAGENT_RECLAIM_TOTAL_MS;
  for (let round = 1; round <= SUBAGENT_RECLAIM_MAX_ROUNDS; round += 1) {
    if (!await reclaimSubagentRunnersOnce(agentHome)) return false;
    let stillActive: boolean;
    try {
      stillActive = hasActivePiSubagentRunsSync(agentHome, { hostPid: process.pid });
    } catch (err) {
      // An unreadable agent home cannot be called stable.
      log.error('Subagent stability re-check failed: %s', String(err));
      return false;
    }
    if (!stillActive) return true;
    log.warn('A durable Subagent run appeared after reclaim round %d; retrying', round);
    if (Date.now() >= deadline) break;
  }
  return false;
}

/**
 * Never rejects.
 *
 * This became async so the Subagent reclaim could be awaited before the updater
 * spawns, and that quietly changed the failure contract: a throw used to reach
 * the caller synchronously, but both call sites are fire-and-forget, so after
 * the change *any* throw became an unhandled rejection. CI caught it on the
 * first `statSync` after the gate (the staged patch had been cleaned up under a
 * finished test), failing the whole run while every assertion passed. Production
 * has the same shape: a patch file that disappears between the readiness check
 * and the spawn.
 */
/**
 * Linux 安装包的信任锚:本进程从 CDN manifest 拿到的 installer 摘要。
 * patch-info.json 与暂存 .deb 都是用户可写文件,不能当可信来源——同一用户
 * 进程可以把两者一起换掉。只有本进程内存里的 manifest 摘要不可伪造;
 * 冷启动拿到旧补丁却没有 manifest 时(断网回落路径)宁可不装。
 */
let linuxStagedDebSha256: string | null = null;
let linuxStagedDebSize: number | null = null;

function readStagedLinuxDebSha256(debPath: string): string | null {
  if (!linuxStagedDebSha256 || linuxStagedDebSize === null) {
    log.error('no trusted Linux installer digest/size in process state — refusing to install');
    return null;
  }
  try {
    const raw = fs.readFileSync(path.join(getUpdatesDir(), PATCH_INFO_FILE), 'utf-8');
    const info = JSON.parse(raw) as PatchInfo;
    if (info.fileName && path.basename(debPath) !== info.fileName) return null;
  } catch {
    return null;
  }
  return linuxStagedDebSha256;
}

function executeUpdateLinux(debPath: string): void {
  const exePath = app.getPath('exe');
  const lockFilePath = getUpdateLockPath();
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'cindy-update.log');
  const pid = process.pid;

  if (!debPath.toLowerCase().endsWith('.deb') || !fs.existsSync(debPath)) {
    log.error('Linux update file is missing or not a .deb: %s', maskPath(debPath));
    handleApplyFailure('linux_deb_missing');
    return;
  }

  const sha256 = readStagedLinuxDebSha256(debPath);
  if (!sha256) {
    log.error('Linux staged .deb is missing a trusted sha256: %s', maskPath(debPath));
    handleApplyFailure('linux_deb_unverified');
    return;
  }

  log.info('Linux relaunch: exe=%s, deb=%s, pid=%d', maskPath(exePath), maskPath(debPath), pid);
  try {
    const exeStat = fs.statSync(exePath);
    const debStat = fs.statSync(debPath);
    log.info(
      'pre-update stat: exe size=%d mtime=%s, deb size=%d',
      exeStat.size, exeStat.mtime.toISOString(), debStat.size,
    );
  } catch (err) {
    log.error('pre-update stat failed:', err);
  }

  const sizeBytes = linuxStagedDebSize;
  if (sizeBytes === null) {
    log.error('Linux staged .deb is missing a trusted size: %s', maskPath(debPath));
    handleApplyFailure('linux_deb_unverified');
    return;
  }

  let script: string;
  try {
    script = buildLinuxUpdateScript({
      pid, debPath, sha256, sizeBytes, exePath, lockFilePath, logPath,
    });
  } catch (err) {
    log.error('failed to build Linux update script:', err);
    handleApplyFailure('linux_script_build_failed');
    return;
  }

  // 主进程在 spawn 之前先把锁建立起来(持有者 = 本进程 PID),再从 spawn
  // 事件退出。这样「点击更新 → 脚本写入锁」之间不存在没有锁的窗口:
  // 万一用户在 spawn 前重启 Cindy,bootstrap 至少能看到一把新鲜的心跳锁
  // 而继续等;脚本启动后第一件事就是把锁换成自己的 PID 继续心跳。
  // bootstrap 只按心跳新鲜度判断,因此交接窗口同样安全。
  try {
    fs.writeFileSync(lockFilePath, `updating ${process.pid}\n`);
  } catch (err) {
    log.error('failed to pre-create Linux update lock:', err);
    handleApplyFailure('linux_lock_create_failed');
    return;
  }

  // 脚本不落盘:内容经 argv 传给 bash -c,同一用户进程没有可替换的
  // 目录项,也就不能借 pkexec 授权执行自己的内容。
  const child = spawn('/bin/bash', ['-c', script, 'cindy-linux-update'], {
    detached: true,
    stdio: 'ignore',
  });

  // 三个终态里只有第一个赢。超时 / error 之后再收到迟到的 spawn 事件,
  // 不能再 forceQuit()——更新已经按失败处理,退出去连旧进程都没人拉起。
  let settled = false;
  const clearPrecreatedLock = (): void => {
    try { fs.unlinkSync(lockFilePath); } catch { /* ignore */ }
  };
  const spawnTimeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    log.error('Linux update script spawn timed out after 5 s');
    // detached spawn 是进程组组长:负 PID 杀整组,心跳子 shell / pkexec
    // 不会变成孤儿继续装。
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    clearPrecreatedLock();
    handleApplyFailure('spawn_timeout');
  }, 5_000);

  child.on('spawn', () => {
    if (settled) return;
    settled = true;
    clearTimeout(spawnTimeout);
    child.unref();
    forceQuit();
  });

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    clearTimeout(spawnTimeout);
    log.error('Linux update script spawn failed: %s (code=%s)', err.message, err.code);
    clearPrecreatedLock();
    handleApplyFailure(err.code ?? 'unknown');
  });
}

async function executeRelaunch(theme: 'light' | 'dark'): Promise<void> {
  try {
    await executeRelaunchUnguarded(theme);
  } catch (err) {
    log.error('executeRelaunch() failed: %s', err instanceof Error ? err.stack ?? err.message : String(err));
    try {
      handleApplyFailure('relaunch_failed');
    } catch (cleanupErr) {
      log.error('executeRelaunch() failure cleanup also failed: %s', String(cleanupErr));
    }
  } finally {
    // Any return from here that is not `process.exit` means the relaunch did
    // not happen, so the fence must come down — including the early returns
    // inside the guarded body.
    if (!isRelaunching) await clearSubagentLaunchFence();
  }
}

async function executeRelaunchUnguarded(theme: 'light' | 'dark'): Promise<void> {
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

  if (syncObservedUpdateChannel() || shouldAbortStagedPatchApply()) {
    const pendingHold = pendingChannelChangeHolds > 0;
    log.info(
      pendingHold || shouldAbortStagedPatchApply()
        ? 'executeRelaunch() aborted — update channel changed during eligibility check'
        : 'executeRelaunch() aborted — shared update channel changed',
    );
    isRelaunching = false;
    autoRelaunchInProgress = false;
    // 写入还没落盘,或当前已经是新渠道补丁:只拦住 apply,别把 zip 清掉。
    if (
      pendingHold
      || (deferredStagedPatch && isCurrentPatchNewerThanDeferred(deferredStagedPatch))
    ) {
      return;
    }
    // 标志先放下,否则 clearStagedPatch 会当成 apply 已提交而跳过。
    clearStagedPatch();
    return;
  }

  log.info('executeRelaunch() called, theme=%s, readyFilePath=%s', theme, maskPath(readyFilePath));
  if (!readyFilePath || !fs.existsSync(readyFilePath)) {
    log.error('No ready update file to apply');
    handleApplyFailure('no_ready_file');
    return;
  }

  const currentVersion = app.getVersion();
  const versionRelation = compareAppUpdateVersions(readyVersion, currentVersion);
  if (versionRelation !== 'newer') {
    log.error(
      'executeRelaunch() refused non-upgrade patch: current=%s patch=%s relation=%s',
      currentVersion,
      readyVersion ?? '<unknown>',
      versionRelation,
    );
    isRelaunching = false;
    autoRelaunchInProgress = false;
    discardStagedPatchFiles();
    return;
  }

  // Gate *before* the updater is spawned, not inside forceQuit: once the
  // updater script is running it polls our pid and SIGKILLs us after 120s
  // (`updateScriptMacOS.ts`), so a late decision not to exit does not keep this
  // process alive — it only delays the kill. Refusing here is the last point
  // where "do not relaunch" is still a real outcome.
  //
  // A runner we cannot confirm stopped holds direct BYOM credentials inherited
  // through its spawn env, and the relaunched app has no handle to it.
  if (!await reclaimSubagentRunnersForRelaunch()) {
    log.error(
      'executeRelaunch() cancelled — PI Subagent runners could not be confirmed stopped; '
      + 'update relaunch aborted rather than leaving them running unsupervised',
    );
    handleApplyFailure('subagent_reclaim_unconfirmed');
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
      executeUpdateLinux(readyFilePath);
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

  ipcMain.on('update-relaunch', (event, theme: 'light' | 'dark') => {
    // Linux 分支会退出应用并触发 pkexec 系统授权,属于特权操作;
    // 按仓库规则先校验 sender 是 Cindy 顶层 frame,不给未来可能拿到
    // 该 channel 的副窗口 renderer 留强制退出/弹授权的口子。
    assertTrustedAppRendererEvent(event);
    // Defensive default: if an old preload is somehow loaded (or theme is
    // missing), fall back to dark — matches the renderer's getStoredTheme()
    // default and the .env'd-out look most users have.
    const resolved = theme === 'light' || theme === 'dark' ? theme : 'dark';
    resolvedRelaunchTheme = resolved;
    void executeRelaunch(resolved);
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

  // beta 测试渠道(设备级)开关。开关本身即时落盘,但 manifest 通道只在
  // 下一次 fetchManifest(后台轮询)或重启后才会切换;设置页打开后引导用户重启。
  // 这些 handler 写本地设置 / 触发重启,按 electron-security-and-process-boundaries.md
  // §5 必须做 trusted-renderer 来源断言——utility/Ghost 等带 preload 的窗口不应能改
  // 更新设置或重启应用(旧 update-auto-settings 没断言是历史债,不构成豁免)。
  ipcMain.handle('update-channel-settings-get', (event) => {
    assertTrustedAppRendererEvent(event);
    return channelSettingsWire();
  });

  ipcMain.handle('update-channel-settings-set', async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (process.platform === 'linux') {
      throwIpcError('INVALID_PARAMS', 'Linux does not support the beta update channel');
    }
    if (!payload || typeof payload !== 'object') {
      throwIpcError('INVALID_PARAMS', 'update channel settings payload required');
    }
    const next = (payload as { enableBeta?: unknown }).enableBeta;
    if (typeof next !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'enableBeta required (boolean)');
    }
    const wasBeta = readUpdateChannelSettings().enableBeta;
    // 先拦住 apply 再等落盘:writeEnableBeta 可能卡住跨进程锁。
    // 真正写成之后再删 zip;写入失败则放开 hold,旧补丁还能用。
    // 写入前不要改 observedEnableBeta:失败路径会按磁盘对账,
    // 乐观改成目标值会把「磁盘没变」误判成别人已经切过渠道。
    if (wasBeta !== next) {
      holdStagedPatchForPendingChannelChange();
    }
    try {
      await writeEnableBeta(next);
    } catch (err) {
      if (wasBeta !== next) {
        abandonPendingChannelChangeHold();
      }
      log.error('writeEnableBeta failed:', err);
      throwIpcError('INTERNAL', 'failed to write update channel settings');
    }
    if (wasBeta !== next) {
      observedEnableBeta = next;
      commitPendingChannelChange();
      clearStagedPatch();
    }
    return channelSettingsWire();
  });

  ipcMain.handle('update-channel-settings-reset', async (event) => {
    assertTrustedAppRendererEvent(event);
    const wasBeta = readUpdateChannelSettings().enableBeta;
    if (wasBeta) {
      holdStagedPatchForPendingChannelChange();
    }
    try {
      await resetUpdateChannelSettings();
    } catch (err) {
      if (wasBeta) {
        abandonPendingChannelChangeHold();
      }
      log.error('resetUpdateChannelSettings failed:', err);
      throwIpcError('INTERNAL', 'failed to reset update channel settings');
    }
    if (wasBeta) {
      observedEnableBeta = false;
      commitPendingChannelChange();
      clearStagedPatch();
    }
    return channelSettingsWire();
  });

  // 打开 beta 前的预检:探测 manifest-{platform}-beta.json 是否可达。
  ipcMain.handle('update-channel-probe-beta', async (event) => {
    assertTrustedAppRendererEvent(event);
    const available = await probeBetaManifest();
    return { available };
  });

  // 用户主动重启:让 beta 通道切换在下次冷启动的 manifest 拉取前生效。
  // 用 app.quit() 而非 app.exit(0):切渠道重启不是 updater 替换场景,没有独立更新器
  // 进程负责收尾,必须走 before-quit 链优雅停掉 Codex/IM/后台服务、落盘本地状态。
  // app.relaunch() 只是标记「退出后重启」,真正触发重启的是 app.quit() 的退出流程。
  ipcMain.handle('update-channel-relaunch', (event) => {
    assertTrustedAppRendererEvent(event);
    log.info('relaunch requested for update channel change');
    discardUnappliedStagedPatchForChannelRelaunch();
    app.relaunch();
    app.quit();
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
        if (patchResult.action === 'relaunch' && process.platform !== 'linux') {
          currentStatus = 'ready';
          return await buildStartupReadyReply(patchResult.version);
        }
        if (patchResult.action === 'relaunch' && process.platform === 'linux') {
          // Linux 安装的信任锚是 manifest 里的 installer 摘要;断网拿不到
          // manifest 时旧补丁没有可信摘要,宁可重下也不装。
          log.info('Linux: manifest unavailable — refusing to stage local patch without a trusted digest');
          discardStagedPatchFiles();
        }
        return { hasUpdate: false, action: 'none' as const, error: 'manifest_failed' as const };
      }

      const latestVersion = manifest.app.version;
      const currentVersion = app.getVersion();
      log.info('Startup: current=%s, latest=%s', currentVersion, latestVersion);

      const startupVersionRelation = compareAppUpdateVersions(latestVersion, currentVersion);
      if (startupVersionRelation !== 'newer') {
        // The online manifest is authoritative. A local patch that is no longer
        // advertised must not survive into a later offline startup.
        const patchResult = checkExistingPatch();
        if (patchResult.action === 'relaunch') {
          log.info(
            'Discarding unadvertised local patch v%s (manifest relation=%s)',
            patchResult.version,
            startupVersionRelation,
          );
          discardStagedPatchFiles();
        }
        if (startupVersionRelation === 'invalid') {
          log.info('[diag] update-check-startup returning error=manifest_failed');
          return { hasUpdate: false, action: 'none' as const, error: 'manifest_failed' as const };
        }
        return { hasUpdate: false, action: 'none' as const };
      }

      if (!resolveUpdateAsset(manifest)) {
        const patchResult = checkExistingPatch();
        if (patchResult.action === 'relaunch') {
          log.info('Discarding local patch v%s because the manifest has no update asset', patchResult.version);
          discardStagedPatchFiles();
        }
        return { hasUpdate: false, action: 'none' as const };
      }

      // Step 2: local patch may already match latest → skip download.
      const patchResult = checkExistingPatch();
      if (patchResult.action === 'relaunch' && patchResult.version === latestVersion) {
        log.info('Local patch v%s matches latest, requesting relaunch', patchResult.version);
        if (process.platform === 'linux') {
          // 冷启动匹配旧补丁:把这份 CDN manifest 的 installer 摘要与大小
          // 重新锚进进程内存,让后续 apply 有可信锚可用。
          const installer = manifest.app.installer;
          linuxStagedDebSha256 = installer?.sha256
            ? normalizeLinuxDebSha256(installer.sha256)
            : null;
          linuxStagedDebSize = typeof installer?.size === 'number' && installer.size > 0
            ? installer.size
            : null;
          if (!linuxStagedDebSha256 || linuxStagedDebSize === null) {
            log.info('Linux: manifest has no installer digest/size — discarding local patch');
            discardStagedPatchFiles();
            return { hasUpdate: false, action: 'none' as const };
          }
        }
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
        readyChannelEpoch = undefined;
        linuxStagedDebSha256 = null;
        linuxStagedDebSize = null;
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

  observedEnableBeta = readUpdateChannelSettings().enableBeta;
  log.info('Initialized — first check in 10s, polling every 30min');
}

/**
 * 登录态落地后给尚未自定义过开关的设备打开 beta。
 * 渠道从关变开时作废已 staged 的旧渠道补丁,与设置页手动打开同一口径。
 * 不 relaunch:本次进程继续走当前通道,下次冷启动 / 用户自行重启再生效。
 */
export async function enableUncustomizedBetaChannel(
  shouldWrite: () => boolean = () => true,
): Promise<boolean> {
  // Linux 没有 beta 清单,组织默认打开只会把客户端钉在不可达渠道。
  if (process.platform === 'linux') return false;
  const wasBeta = readUpdateChannelSettings().enableBeta;
  // 先拦住 apply 再等落盘。身份守卫拒绝或写入失败时,旧补丁还得能用。
  if (!wasBeta) {
    holdStagedPatchForPendingChannelChange();
  }
  try {
    const wrote = await tryEnableUncustomizedBetaAtomic(shouldWrite);
    if (wrote && !wasBeta) {
      observedEnableBeta = true;
      commitPendingChannelChange();
      clearStagedPatch();
      broadcastChannelSettings();
      return wrote;
    }
    if (!wasBeta) {
      abandonPendingChannelChangeHold();
    }
    return wrote;
  } catch (err) {
    if (!wasBeta) {
      abandonPendingChannelChangeHold();
    }
    throw err;
  }
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
