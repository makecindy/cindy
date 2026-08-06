/**
 * 客户端日志上报的 **electron 接线层** —— 本目录里唯一 import electron 的文件。
 *
 * 职责：
 *  - 把注入依赖（文件系统、时钟、fetch、授权读取、随机数）接到纯逻辑管道上；
 *  - 注册 `log-upload:*` IPC 与设置变更广播；
 *  - 接线三条自动路径：崩溃即时（`lifecycle.onFatalShutdown`）、启动补传、原生崩溃兜底
 *    （`startup-diagnostics.getPreviousRunReports`）。
 *
 * 时序约束（需求 §4.5）：
 *  - **不阻塞启动**：`scheduleStartupBackfill()` 由 bootstrap 在主窗口 `ready-to-show`
 *    之后延迟调用，采集本身是 async 流式读 + 定期让出事件循环。
 *  - **不拖慢退出**：崩溃即时路径只同步写一个 <400B 的标记文件，随后 fire-and-forget 发起
 *    上传；它注册在 `onFatalShutdown`（不是 `onQuit`），因此不占 disposer 超时预算。
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion';
import {
  LOG_UPLOAD_SETTINGS_CHANGE_CHANNEL,
  type LogUploadReason,
  type LogUploadResult,
  type LogUploadSettingsPayload,
} from '../../shared/logUpload';
import * as authManager from '../authManager';
import {
  isAnalyticsConsentRecordReadable,
  readAnalyticsSettings,
  refreshAnalyticsSettingsFromDisk,
} from '../analytics-settings-store';
import { isFatalShutdownReason, onFatalShutdown, onQuit } from '../lifecycle';
import { createLogger, getLogDir } from '../logger';
import { outboundFetch } from '../maker-host/outbound-fetch';
import { getPreviousRunReports } from '../startup-diagnostics';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { collectLogs, type CollectDeps } from './collect';
import {
  crashAtFromMarker,
  selectBackfillGrouping,
  shouldBackfillForReportKind,
} from './crashTriggers';
import type { ConsentGateDeps } from './consentGate';
import { evaluateGate } from './consentGate';
import { sendLogs } from './logSink';
import { resolveLogUploadTarget } from './logUploadTarget';
import {
  clearCrashAutoUploadOverride,
  isCrashAutoUploadCustomized,
  isCrashAutoUploadEnabled,
  isLogUploadSettingsReadable,
  refreshLogUploadSettingsFromDisk,
  setCrashAutoUploadEnabled,
} from './logUploadSettingsStore';
import type { RandomAccessFile } from './mainLogReader';
import { PendingMarkerStore, type MarkerFs } from './pendingMarkers';
import type { LogUploadMeta, LogUploadTarget } from './types';
import { generateUploadCode } from './uploadCode';
import { runUpload, type UploadOutcome } from './uploadRunner';

const log = createLogger('log-upload');

/** 启动补传的延迟：让主窗口先出来、首帧的 IO 争用先过去。 */
const STARTUP_BACKFILL_DELAY_MS = 15_000;

let ipcRegistered = false;
let markerStore: PendingMarkerStore | null = null;
/** 手动上传的并发闸：同一时刻只允许一次（采集会读几 MB，重入没有意义）。 */
let manualUploadInFlight = false;
let startupBackfillTimer: ReturnType<typeof setTimeout> | null = null;

// ── 依赖装配 ────────────────────────────────────────────────────────────────

function markerDir(): string {
  return path.join(app.getPath('userData'), 'diagnostics', 'log-upload');
}

const markerFs: MarkerFs = {
  mkdirSync: (dir) => fs.mkdirSync(dir, { recursive: true }),
  readdirSync: (dir) => fs.readdirSync(dir),
  readFileSync: (file) => fs.readFileSync(file, 'utf-8'),
  writeFileSync: (file, data) => fs.writeFileSync(file, data),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (file) => fs.unlinkSync(file),
  statMtimeMs: (file) => fs.statSync(file).mtimeMs,
};

function ensureMarkerStore(): PendingMarkerStore {
  if (!markerStore) {
    markerStore = new PendingMarkerStore({
      dir: markerDir(),
      fs: markerFs,
      now: () => Date.now(),
      pid: process.pid,
      appVersion: app.getVersion(),
      randomToken: () => crypto.randomBytes(6).toString('hex'),
      joinPath: (...parts) => path.join(...parts),
      warn: (message, err) => log.warn(message, err),
    });
  }
  return markerStore;
}

/**
 * 本构建的上报目标。值由打包期注入（见 `logUploadTarget.ts`），这里只做区域交叉校验后取用。
 *
 * 不再看 `app.isPackaged`：目标是打包脚本按构建区域注入的，dev server 与本地 `pnpm dev`
 * 根本拿不到注入值 ⇒ 天然关闭。开发者要联调时显式设 `XDT_LOG_UPLOAD_TARGET`（且其中的
 * region 必须与本构建区域一致），那是一次明确的动作，不是意外。
 */
function currentTarget(): LogUploadTarget | null {
  return resolveLogUploadTarget({ region: CURRENT_CINDY_REGION });
}

/**
 * 授权闸的依赖。`refreshFromDisk` 同时刷两份 store —— 同意事实在 analytics 那份，
 * 崩溃开关在本功能自己那份，两者都可能被另一个实例改过。
 */
const gateDeps: ConsentGateDeps = {
  isTargetConfigured: () => currentTarget() !== null,
  refreshFromDisk: () => {
    refreshAnalyticsSettingsFromDisk();
    refreshLogUploadSettingsFromDisk();
  },
  // ⚠️ 读不出来必须**抛**,不能返回 false(2026-08-04 review P2)。
  // 两个 store 都基于 createOverrideSettingsFile,它读到坏 JSON 会吞掉异常并返回默认值
  // ——于是「文件损坏」和「用户明确没同意 / 明确关掉开关」在返回值上完全一样。闸把前者
  // 判成「明确拒绝」的后果是 runUpload 走 denied 分支**清空待补传标记**:一次设置文件
  // 读取故障就永久丢掉一个崩溃现场。抛出来才能让闸判 `unknown`(不传、也不清、留给下次启动)。
  readPrivacyConsentAccepted: () => {
    if (!isAnalyticsConsentRecordReadable()) {
      throw new Error('analytics settings record is present but unreadable');
    }
    return readAnalyticsSettings().privacyConsentAccepted;
  },
  readCrashAutoUploadEnabled: () => {
    if (!isLogUploadSettingsReadable()) {
      throw new Error('log-upload settings record is present but unreadable');
    }
    return isCrashAutoUploadEnabled();
  },
};

/** 打开一个只能随机读的文件句柄。不存在 / 不可读返回 null（跳过，不算失败）。 */
async function openReadOnly(
  filePath: string,
): Promise<(RandomAccessFile & { close(): Promise<void> }) | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch {
    return null;
  }
  return {
    async size() {
      const stat = await handle.stat();
      return stat.size;
    },
    async read(offset: number, length: number) {
      if (length <= 0) return Buffer.alloc(0);
      const buffer = Buffer.alloc(length);
      let read = 0;
      // 网络盘 / FUSE 上单次 read 不保证填满请求区间,读满循环避免把内容截断。
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buffer.subarray(0, read);
    },
    async close() {
      await handle.close();
    },
  };
}

function collectDeps(): CollectDeps {
  return {
    logDir: getLogDir(),
    listDir: (dir) => fs.promises.readdir(dir),
    openFile: openReadOnly,
    now: () => Date.now(),
    homeDir: os.homedir(),
    // setImmediate 让出一次:采集跑在 main 上,连续同步解析几 MB 会造成可感知的卡顿。
    yieldToEventLoop: () => new Promise<void>((resolve) => setImmediate(resolve)),
    joinPath: (...parts) => path.join(...parts),
  };
}

function buildMeta(args: {
  uploadCode: string;
  reason: LogUploadReason;
  crashToken?: string;
  crashAtMs?: number;
}): LogUploadMeta {
  const authState = authManager.getAuthState();
  return {
    uploadCode: args.uploadCode,
    userId: authState.user?.id ?? '',
    deviceId: authManager.getDeviceId(),
    appVersion: app.getVersion(),
    region: CURRENT_CINDY_REGION,
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    uiLanguage: app.getLocale(),
    reason: args.reason,
    crashToken: args.crashToken,
    crashAtMs: args.crashAtMs,
  };
}

function runnerDeps() {
  return {
    gate: gateDeps,
    resolveTarget: currentTarget,
    collect: (request: { reason: LogUploadReason; anchors: number[] }) =>
      collectLogs(collectDeps(), request),
    send: (target: LogUploadTarget, meta: LogUploadMeta, records: Parameters<typeof sendLogs>[3]) =>
      sendLogs({ fetchImpl: outboundFetch }, target, meta, records),
    buildMeta,
    generateUploadCode: () => generateUploadCode((size) => crypto.randomBytes(size)),
    markers: ensureMarkerStore(),
    now: () => Date.now(),
    log: {
      info: (message: string, ...rest: unknown[]) => log.info(message, ...rest),
      warn: (message: string, ...rest: unknown[]) => log.warn(message, ...rest),
    },
  };
}

// ── 设置 payload 与广播 ─────────────────────────────────────────────────────

export function logUploadSettingsPayload(): LogUploadSettingsPayload {
  const targetConfigured = currentTarget() !== null;
  // 展示用的读取不强制现读盘:设置页由广播驱动,自己这一侧的写入会立刻广播。
  const privacyConsentAccepted = readAnalyticsSettings().privacyConsentAccepted;
  return {
    targetConfigured,
    privacyConsentAccepted,
    crashAutoUploadEnabled: isCrashAutoUploadEnabled(),
    crashAutoUploadCustomized: isCrashAutoUploadCustomized(),
    manualUploadAvailable: targetConfigured && privacyConsentAccepted,
  };
}

function broadcastSettingsChange(): void {
  const payload = logUploadSettingsPayload();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(LOG_UPLOAD_SETTINGS_CHANGE_CHANNEL, payload);
    } catch (err) {
      log.warn(`broadcast '${LOG_UPLOAD_SETTINGS_CHANGE_CHANNEL}' failed (non-fatal)`, err);
    }
  }
}

// ── 三条自动路径 ────────────────────────────────────────────────────────────

/**
 * 崩溃即时：`lifecycle` 判定为致命 shutdown 的那一刻。
 *
 * 先**同步**写标记（进程可能马上就没了），再 fire-and-forget 发起一次尽最大努力的上传。
 * 即时上传拿不到崩溃后的收尾日志，所以**成功也不清标记**——完整现场靠下次启动补传
 * （需求 §4.1）。这里刻意不认领任何标记，`claimed` 传空数组即表达了这一点。
 */
function handleFatalShutdown(reason: string): void {
  try {
    const target = currentTarget();
    if (!target) return; // 功能整体关闭:不写标记、不发字节
    // 授权判定要现读盘(用户可能刚在另一个实例里关掉)。denied 时连标记都不写。
    const verdict = evaluateGate(gateDeps, 'crash-immediate');
    if (verdict.kind === 'denied') {
      // 明确拒绝 ⇒ 顺手清掉存量标记(授权已关闭,不得在下次启动补传)。
      ensureMarkerStore().clearAll();
      return;
    }
    const crashAtMs = Date.now();
    // unknown(读不出授权)也要写标记:把最终判定留给下次启动的可靠读取。
    const marker = ensureMarkerStore().write('crash', crashAtMs);
    if (verdict.kind !== 'allowed') return;
    log.warn(`fatal shutdown (${reason}) — attempting immediate log upload (best effort)`);
    // 不 await:退出链不等它,进程没了就没了。
    void runUpload(runnerDeps(), {
      reason: 'crash-immediate',
      anchors: [crashAtMs],
      claimed: [],
      crashToken: marker?.token,
      crashAtMs,
    }).catch(() => undefined);
  } catch (err) {
    // 崩溃处理链上绝不能抛第二个异常。
    log.warn('fatal-shutdown log upload hook failed (non-fatal)', err);
  }
}

/**
 * 原生崩溃兜底：启动尸检判定上次运行「异常退出且无任何退出记录」时补写标记。
 *
 * segfault / 被系统 kill / 主线程 hang 这类崩溃 JS 层根本没机会反应，只有 run marker 的
 * 尸检能发现。补写的标记会被同一次启动的补传路径捡走。
 */
function backfillMarkersFromPostmortem(): void {
  const store = ensureMarkerStore();
  for (const report of getPreviousRunReports()) {
    if (!shouldBackfillForReportKind(report.kind)) continue;
    const crashAtMs = crashAtFromMarker(report.marker) ?? Date.now();
    const written = store.write('native-crash', crashAtMs);
    log.warn(
      `postmortem kind=${report.kind} → pending log-upload marker ` +
        `${written ? `token=${written.token}` : '(write failed)'} crashAt=${new Date(crashAtMs).toISOString()}`,
    );
  }
}

/**
 * 启动补传 —— **崩溃场景的主力**。崩溃当时的收尾日志此刻已完整落盘。
 *
 * 一次处理所有已认领的标记：窗口按最早一次未传崩溃放宽，裁剪以「离任一崩溃时刻最近」为准，
 * 所以多次未传崩溃能在同一次上报里都被覆盖（需求 §4.5）。
 */
async function runStartupBackfill(): Promise<void> {
  const store = ensureMarkerStore();
  const claimed = store.claimAll();
  if (claimed.length === 0) return;
  const anchors = claimed.map((c) => c.marker.crashAtMs);
  log.info(`startup log-upload backfill: ${claimed.length} pending crash marker(s)`);
  // 归组令牌与崩溃时刻都取**最早那次崩溃**的同一个标记(claimAll 按 readdir 顺序返回,
  // claimed[0] 不一定是最早那次——token 与 crashAtMs 取自不同标记会归错组,见 selectBackfillGrouping)。
  const grouping = selectBackfillGrouping(claimed);
  const outcome = await runUpload(runnerDeps(), {
    reason: 'crash-backfill',
    anchors,
    claimed,
    crashToken: grouping.crashToken,
    crashAtMs: grouping.crashAtMs,
  });
  log.info(`startup log-upload backfill outcome=${outcome.kind}`);
}

/** 由 bootstrap 在主窗口 ready-to-show 之后调用。幂等。 */
export function scheduleStartupBackfill(): void {
  if (startupBackfillTimer) return;
  startupBackfillTimer = setTimeout(() => {
    startupBackfillTimer = null;
    // 尸检补标记排在补传之前:同一次启动就能把原生崩溃的现场传上来。
    try {
      backfillMarkersFromPostmortem();
    } catch (err) {
      log.warn('postmortem marker backfill failed (non-fatal)', err);
    }
    void runStartupBackfill().catch((err) => {
      log.warn('startup log-upload backfill failed (non-fatal)', err);
    });
  }, STARTUP_BACKFILL_DELAY_MS);
  // 不阻止进程退出。
  startupBackfillTimer.unref?.();
}

// ── IPC ─────────────────────────────────────────────────────────────────────

/** outcome → IPC 错误码。renderer 据此给出可区分的本地化文案。 */
function throwForOutcome(outcome: UploadOutcome): never {
  switch (outcome.kind) {
    case 'skipped-not-configured':
      return throwIpcError('LOG_UPLOAD_UNAVAILABLE', 'log upload target is not configured');
    case 'skipped-no-consent':
    case 'skipped-consent-unknown':
      return throwIpcError('PRIVACY_CONSENT_REQUIRED', 'privacy policy consent is required');
    case 'empty':
      return throwIpcError('LOG_UPLOAD_EMPTY', 'no uploadable log records were collected');
    case 'failed':
      return throwIpcError('LOG_UPLOAD_FAILED', `log upload failed with status ${outcome.status}`);
    default:
      return throwIpcError('LOG_UPLOAD_FAILED', `log upload failed (${outcome.kind})`);
  }
}

export function initLogUploadService(): void {
  if (ipcRegistered) {
    log.warn('initLogUploadService called twice, ignoring');
    return;
  }
  ipcRegistered = true;

  const target = currentTarget();
  log.info(
    `log upload ${target ? 'enabled' : 'DISABLED (no target configured for this build)'} ` +
      `region=${CURRENT_CINDY_REGION} packaged=${app.isPackaged === true}`,
  );

  // 崩溃即时路径。注册在 onFatalShutdown 而不是 onQuit:见 lifecycle.onFatalShutdown 注释。
  onFatalShutdown(handleFatalShutdown);

  ipcMain.handle('log-upload:settings-get', (event) => {
    assertTrustedAppRendererEvent(event);
    return logUploadSettingsPayload();
  });

  ipcMain.handle('log-upload:set-crash-auto', (event, rawEnabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    // 非布尔一律当关闭处理(fail closed)。
    const enabled = rawEnabled === true;
    try {
      setCrashAutoUploadEnabled(enabled);
    } catch (err) {
      log.error('write log-upload setting failed', err);
      return throwIpcError('INTERNAL', 'failed to persist log upload settings');
    }
    // 关掉开关 ⇒ 立刻清掉待补传标记(需求 §4.3 末条:不得在下次启动补传)。
    if (!enabled) {
      const removed = ensureMarkerStore().clearAll();
      if (removed > 0) {
        log.info(`crash auto-upload disabled — cleared ${removed} pending marker(s)`);
      }
    }
    broadcastSettingsChange();
    return logUploadSettingsPayload();
  });

  ipcMain.handle('log-upload:reset-crash-auto', (event) => {
    assertTrustedAppRendererEvent(event);
    try {
      clearCrashAutoUploadOverride();
    } catch (err) {
      log.error('clear log-upload override failed', err);
      return throwIpcError('INTERNAL', 'failed to reset log upload settings');
    }
    // 恢复默认 = 回到默认关闭,同样要清标记(此刻自动上传已不再被授权)。
    if (!isCrashAutoUploadEnabled()) ensureMarkerStore().clearAll();
    broadcastSettingsChange();
    return logUploadSettingsPayload();
  });

  ipcMain.handle('log-upload:upload-now', async (event): Promise<LogUploadResult> => {
    assertTrustedAppRendererEvent(event);
    if (manualUploadInFlight) {
      return throwIpcError('LOG_UPLOAD_BUSY', 'a log upload is already in progress');
    }
    manualUploadInFlight = true;
    try {
      const outcome = await runUpload(runnerDeps(), {
        reason: 'manual',
        anchors: [],
        claimed: [],
      });
      if (outcome.kind !== 'uploaded') return throwForOutcome(outcome);
      return { uploadCode: outcome.uploadCode, recordCount: outcome.recordCount };
    } finally {
      manualUploadInFlight = false;
    }
  });

  onQuit('log-upload', () => {
    ipcRegistered = false;
    if (startupBackfillTimer) {
      clearTimeout(startupBackfillTimer);
      startupBackfillTimer = null;
    }
  });
}

export const __testing = {
  handleFatalShutdown,
  backfillMarkersFromPostmortem,
  runStartupBackfill,
  isFatalShutdownReason,
  resetForTests(): void {
    ipcRegistered = false;
    markerStore = null;
    manualUploadInFlight = false;
    if (startupBackfillTimer) {
      clearTimeout(startupBackfillTimer);
      startupBackfillTimer = null;
    }
  },
};
