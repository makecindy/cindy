/**
 * 被更新电脑一侧：同账号另一台电脑（或本机拓扑卡片）查询这台电脑是否有可安装的
 * Cindy 新版本，并在用户二次确认后触发内置更新链路。
 *
 * - 完全复用既有的 updateService.ts 入口（checkAppUpdateForAgent / applyConfirmedAppUpdateForAgent），
 *   不新开下载、替换或重启路径。
 * - 先回答再延迟 APPLY_DELAY_MS 触发更新，避免本地已 ready 时 macOS 在回包发出前退出进程。
 * - 捕获发起时的账号代次：下载或等待期间退出 / 切换账号，会在 beforeRelaunch / beforeSpawn
 *   拦下，绝不替后来的账号重启。
 * - 准入（同账号桌面、对方开了远程控制、未撤销）由 dispatch 在调用前完成；这里只处理业务。
 */

import {
  PEER_APP_UPDATE_VERSION,
  parsePeerAppUpdateRequest,
  type PeerAppUpdateErrorCode,
  type PeerAppUpdateInstallAccepted,
  type PeerAppUpdateStatus,
} from '@cindy/device-link';

export interface PeerAppUpdateCheckResult {
  status: string;
  currentVersion: string;
  targetVersion?: string;
  reason?: string;
}

export type PeerAppUpdateApplyResult =
  | { status: 'relaunching'; targetVersion?: string }
  | { status: 'failed'; reason: string; errorCode?: string; stagedVersion?: string };

export interface PeerAppUpdatePorts {
  platform: NodeJS.Platform;
  appVersion(): string;
  check(): Promise<PeerAppUpdateCheckResult>;
  apply(options: {
    expectedVersion?: string;
    beforeRelaunch: () => Promise<boolean>;
    beforeSpawn?: () => boolean;
  }): Promise<PeerAppUpdateApplyResult>;
  /** True when restarting would interrupt running tasks or background work; errors fail closed to true. */
  isBusy(): Promise<boolean>;
  /** Captures the active account scope; returns true only while that same account remains active. */
  captureScope(): () => boolean;
  now(): number;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

/** 回答先离开这台电脑，再触发下载 / 重启。 */
export const PEER_APP_UPDATE_APPLY_DELAY_MS = 400;
/** 短时缓存只读 manifest 查询，避免用户连续开关卡片反复请求 CDN。 */
const STATUS_CACHE_TTL_MS = 30_000;
/** 记住最近一次后台安装失败的错误码，供发起端进度观察器及时报错。 */
const FAILURE_TTL_MS = 5 * 60_000;
/** 进程重启阶段超时保护：若更新器未退出当前进程，清理内存占位允许重试。 */
const RELAUNCH_STALE_MS = 15_000;

export class PeerAppUpdateError extends Error {
  constructor(readonly code: PeerAppUpdateErrorCode, detail: string) {
    super(`[${code}] ${detail}`);
  }
}

export function createPeerAppUpdateHandler(ports: PeerAppUpdatePorts) {
  let activeInstall: { targetVersion: string; phase: 'downloading' | 'relaunching' } | null = null;
  let lastFailure: { targetVersion: string; errorCode: string; at: number } | null = null;
  let statusCache: { checked: PeerAppUpdateCheckResult; currentVersion: string; at: number } | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let relaunchStaleTimer: ReturnType<typeof setTimeout> | null = null;

  const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };

  const clearTimers = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    if (relaunchStaleTimer) clearTimeout(relaunchStaleTimer);
    pendingTimer = null;
    relaunchStaleTimer = null;
  };

  async function readBusyFailClosed(): Promise<boolean> {
    try {
      return await ports.isBusy();
    } catch {
      return true;
    }
  }

  function recentFailureCode(targetVersion: string | undefined): string | undefined {
    if (!lastFailure) return undefined;
    if (ports.now() - lastFailure.at > FAILURE_TTL_MS) {
      lastFailure = null;
      return undefined;
    }
    if (targetVersion && lastFailure.targetVersion !== targetVersion) return undefined;
    return lastFailure.errorCode;
  }

  async function runCheck(useCache: boolean): Promise<PeerAppUpdateCheckResult> {
    const currentVersion = ports.appVersion();
    if (
      useCache
      && statusCache
      && statusCache.currentVersion === currentVersion
      && ports.now() - statusCache.at < STATUS_CACHE_TTL_MS
    ) {
      return statusCache.checked;
    }
    const checked = await ports.check();
    if (checked.status === 'available' || checked.status === 'no_installable_update' || checked.status === 'unsupported') {
      statusCache = { checked, currentVersion, at: ports.now() };
    } else {
      statusCache = null;
    }
    return checked;
  }

  async function handleStatus(): Promise<PeerAppUpdateStatus> {
    if (activeInstall) {
      return {
        version: PEER_APP_UPDATE_VERSION,
        state: activeInstall.phase,
        currentVersion: ports.appVersion(),
        targetVersion: activeInstall.targetVersion,
        platform: ports.platform,
      };
    }

    const checked = await runCheck(true);
    const base = {
      version: PEER_APP_UPDATE_VERSION,
      currentVersion: checked.currentVersion || ports.appVersion(),
      platform: ports.platform,
    };
    const lastErrorCode = recentFailureCode(checked.targetVersion);

    switch (checked.status) {
      case 'unsupported':
        return { ...base, state: 'unsupported' };
      case 'downloading':
        return {
          ...base,
          state: 'downloading',
          ...(checked.targetVersion ? { targetVersion: checked.targetVersion } : {}),
        };
      case 'ready':
      case 'available':
        return {
          ...base,
          state: checked.status,
          ...(checked.targetVersion ? { targetVersion: checked.targetVersion } : {}),
          busy: await readBusyFailClosed(),
          ...(lastErrorCode ? { lastErrorCode } : {}),
        };
      case 'no_installable_update':
        return {
          ...base,
          state: 'up-to-date',
          ...(lastErrorCode ? { lastErrorCode } : {}),
        };
      default:
        return {
          ...base,
          state: 'failed',
          errorCode: 'manifest_failed',
          ...(lastErrorCode ? { lastErrorCode } : {}),
        };
    }
  }

  async function handleInstall(
    expectedVersion: string,
    controllerDeviceId: string,
    controllerName: string,
  ): Promise<PeerAppUpdateInstallAccepted> {
    if (activeInstall) {
      if (activeInstall.targetVersion === expectedVersion) {
        return {
          version: PEER_APP_UPDATE_VERSION,
          accepted: true,
          state: activeInstall.phase,
          targetVersion: activeInstall.targetVersion,
        };
      }
      throw new PeerAppUpdateError('PEER_APP_UPDATE_BUSY', 'another update is already in progress');
    }

    const isOwnerCurrent = ports.captureScope();
    if (!isOwnerCurrent()) {
      throw new PeerAppUpdateError('PEER_APP_UPDATE_UNAVAILABLE', 'no active account scope');
    }

    const checked = await runCheck(false);
    // Re-check after awaiting runCheck(false) so concurrent install requests do not overwrite activeInstall.
    if (activeInstall) {
      if (activeInstall.targetVersion === expectedVersion) {
        return {
          version: PEER_APP_UPDATE_VERSION,
          accepted: true,
          state: activeInstall.phase,
          targetVersion: activeInstall.targetVersion,
        };
      }
      throw new PeerAppUpdateError('PEER_APP_UPDATE_BUSY', 'another update is already in progress');
    }
    if (checked.status === 'unsupported') {
      throw new PeerAppUpdateError('PEER_APP_UPDATE_UNSUPPORTED', checked.reason ?? 'unsupported');
    }
    if (checked.status === 'no_installable_update') {
      throw new PeerAppUpdateError('PEER_APP_UPDATE_NO_UPDATE', checked.reason ?? 'no installable update');
    }
    if (checked.status !== 'available' && checked.status !== 'downloading' && checked.status !== 'ready') {
      throw new PeerAppUpdateError('PEER_APP_UPDATE_UNAVAILABLE', checked.reason ?? 'manifest unavailable');
    }
    if (!checked.targetVersion || checked.targetVersion !== expectedVersion) {
      throw new PeerAppUpdateError(
        'PEER_APP_UPDATE_VERSION_CHANGED',
        `expected ${expectedVersion}, got ${checked.targetVersion ?? 'none'}`,
      );
    }

    const initialPhase: 'downloading' | 'relaunching' = checked.status === 'ready' ? 'relaunching' : 'downloading';
    statusCache = null;
    lastFailure = null;
    const currentInstall = { targetVersion: expectedVersion, phase: initialPhase };
    activeInstall = currentInstall;
    ports.log.info('peer app update accepted', {
      controllerDeviceId: controllerDeviceId.slice(0, 8),
      controllerName,
      fromVersion: checked.currentVersion,
      targetVersion: expectedVersion,
      initialPhase,
    });

    pendingTimer = later(() => {
      pendingTimer = null;
      void runInstall(currentInstall, isOwnerCurrent);
    }, PEER_APP_UPDATE_APPLY_DELAY_MS);

    return {
      version: PEER_APP_UPDATE_VERSION,
      accepted: true,
      state: initialPhase,
      targetVersion: expectedVersion,
    };
  }

  async function runInstall(
    install: { targetVersion: string; phase: 'downloading' | 'relaunching' },
    isOwnerCurrent: () => boolean,
  ): Promise<void> {
    const expectedVersion = install.targetVersion;
    if (!isOwnerCurrent()) {
      if (activeInstall === install) activeInstall = null;
      lastFailure = { targetVersion: expectedVersion, errorCode: 'relaunch_cancelled', at: ports.now() };
      return;
    }
    try {
      const outcome = await ports.apply({
        expectedVersion,
        beforeRelaunch: async () => {
          if (!isOwnerCurrent()) return false;
          if (activeInstall === install) {
            install.phase = 'relaunching';
          }
          return true;
        },
        beforeSpawn: () => isOwnerCurrent(),
      });
      if (outcome.status === 'relaunching' || outcome.errorCode === 'relaunch_in_progress') {
        if (activeInstall === install) {
          install.phase = 'relaunching';
        }
        relaunchStaleTimer = later(() => {
          relaunchStaleTimer = null;
          if (activeInstall === install) {
            activeInstall = null;
          }
        }, RELAUNCH_STALE_MS);
        return;
      }
      if (activeInstall === install) activeInstall = null;
      lastFailure = {
        targetVersion: expectedVersion,
        errorCode: outcome.errorCode ?? 'relaunch_not_started',
        at: ports.now(),
      };
      ports.log.warn('peer app update failed', { targetVersion: expectedVersion, errorCode: lastFailure.errorCode });
    } catch (error) {
      if (activeInstall === install) activeInstall = null;
      lastFailure = {
        targetVersion: expectedVersion,
        errorCode: 'relaunch_not_started',
        at: ports.now(),
      };
      ports.log.warn('peer app update threw', { targetVersion: expectedVersion, error: String(error) });
    }
  }

  async function handle(raw: unknown, controllerDeviceId: string, controllerName: string): Promise<unknown> {
    const request = parsePeerAppUpdateRequest(raw);
    if (!request) {
      throw new PeerAppUpdateError('PEER_APP_UPDATE_INVALID', 'invalid peer app update request');
    }
    if (request.action === 'status') return handleStatus();
    return handleInstall(request.expectedVersion, controllerDeviceId, controllerName);
  }

  return {
    handle,
    dispose: clearTimers,
  };
}

export type PeerAppUpdateHandler = ReturnType<typeof createPeerAppUpdateHandler>;
