import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Maker } from '@cindy/maker-core';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { createLogger } from '../logger.js';
import { t } from '../i18n.desktop.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import {
  formatLocalAgentConnectionCode,
  type LocalAgentConnection,
  type LocalAgentDeveloperConnection,
  type LocalAgentInstanceInfo,
} from '../../shared/localAgent.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { isCindyPersonalRuntime } from '../cindy-make/versionRuntimeIdentity.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { localAgentModels } from './catalog.js';
import { remoteLocalAgentModels } from './remoteCatalog.js';
import { createLocalAgentServer, LocalAgentError, type LocalAgentServerDeps } from './server.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { openLocalAgentRuntime } from './runtime.js';
import { localAgentMessage } from './messages.js';
import { createLocalAgentGroupRouteResolver } from './groupRoute.js';
import { listProviderGroups } from '../provider-group/store.js';

import { confirmLocalAgent, cancelLocalAgentConfirmations } from './confirmation.js';

const log = createLogger('local-agent');

/**
 * 旧实例刚退出时锁心跳仍在新窗口里（锁必须静置 `LOCK_STALE_MS` 才允许接管），所以先在锁上
 * 等过一个 stale 窗口再判占用。自动更新重启是一次真实竞态：观测到 `reason=update-relaunch`
 * 的旧实例 `disposersCompleted=no`，`host.lock` 留在磁盘，新实例 8.8s 后抢锁时仍被判占用，
 * 而它此后的整个生命周期都不会再有本机 API。
 */
const STARTUP_LOCK_WAIT_MS = 5_000;

/**
 * 本机接入是整个进程的长驻能力，而安装入口只有 getMaker() 那一次调用：一次 HOST_IN_USE 或
 * owner 还没认领就失败，此前会让进程在剩下的生命周期里完全没有本机接入（外部本机应用，例如
 * TapTap PC 的「让 Cindy 帮我排查」，只会一直看到「Cindy 本机服务还没就绪」）。失败后按指数
 * 退避重试，直到成功或 host 被退役。
 */
const STARTUP_RETRY_BASE_MS = 1_000;
const STARTUP_RETRY_MAX_MS = 30_000;
/** owner 认领通常只要几百毫秒，先快后慢更贴近实际。 */
const OWNER_PENDING_RETRY_BASE_MS = 500;
/** owner 还没认领完成不是故障：不进 startupFailure，只影响重试节奏。 */
const OWNER_PENDING = Symbol('owner-pending');

let current: Promise<Awaited<ReturnType<typeof createLocalAgentServer>>> | undefined;
let startupFailure: unknown;
let teardown = Promise.resolve();
let readyServer: Awaited<ReturnType<typeof createLocalAgentServer>> | undefined;
let currentOwner: string | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryAttempt = 0;
/** 当前在途尝试的抢锁取消句柄；dispose 时用它中断最多 STARTUP_LOCK_WAIT_MS 的等锁。 */
let leaseAbort: AbortController | undefined;
/** 退役 / 重新安装都会递增；迟到的重试因此不会复活已经换代的 host。 */
let installEpoch = 0;
/** 同一个失败码只告警一次，退避重试本身不再刷日志。 */
let reportedFailureCode: string | undefined;

function instanceInfo(): LocalAgentInstanceInfo {
  return {
    kind:
      !app.isPackaged || isCindyPersonalRuntime() || CURRENT_CINDY_REGION === 'dev'
        ? 'development'
        : 'installed',
    region: CURRENT_CINDY_REGION,
  };
}

function notifySettings(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (isTrustedAppRendererWindow(window))
      window.webContents.send('local-agent:connections-changed');
  }
}

function failureCode(failure: unknown): string {
  if (failure === OWNER_PENDING) return 'OWNER_PENDING';
  return failure instanceof LocalAgentError ? failure.code : 'LOCAL_AGENT_FAILED';
}

function cancelStartupRetry(): void {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

function startupRetryDelay(failure: unknown, attempt: number): number {
  const base = failure === OWNER_PENDING ? OWNER_PENDING_RETRY_BASE_MS : STARTUP_RETRY_BASE_MS;
  return Math.min(base * 2 ** Math.max(0, attempt - 1), STARTUP_RETRY_MAX_MS);
}

function scheduleStartupRetry(maker: Maker, failure: unknown): void {
  cancelStartupRetry();
  retryAttempt += 1;
  const epoch = installEpoch;
  const delay = startupRetryDelay(failure, retryAttempt);
  const timer = setTimeout(() => {
    if (retryTimer === timer) retryTimer = undefined;
    if (epoch !== installEpoch || current) return;
    startLocalAgentHost(maker);
  }, delay);
  // 退避中的重试不能让进程在退出时多等一个定时器。
  timer.unref?.();
  retryTimer = timer;
  log.debug('local agent API startup retry scheduled', {
    code: failureCode(failure),
    attempt: retryAttempt,
    delayMs: delay,
  });
}

/** A shared profile has one discovery endpoint and one grant writer. Reuse the
 * existing process lock so a passive/preview instance cannot resurrect revoked grants. */
async function startWithProfileLease(deps: LocalAgentServerDeps, signal?: AbortSignal) {
  const discovery = deps.discoveryDirectory ?? deps.directory;
  await fs.mkdir(discovery, { recursive: true, mode: 0o700 });
  let ready!: (server: Awaited<ReturnType<typeof createLocalAgentServer>>) => void;
  let failed!: (error: unknown) => void;
  const started = new Promise<Awaited<ReturnType<typeof createLocalAgentServer>>>(
    (resolve, reject) => {
      ready = resolve;
      failed = reject;
    },
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifetime = withCrossProcessLock(
    path.join(discovery, 'host.lock'),
    // 旧实例刚退出时锁心跳仍在新窗口里：等过一个 stale 窗口再判占用，比立刻 HOST_IN_USE
    // 更接近真实竞态。
    { label: 'local-agent-host', waitMs: STARTUP_LOCK_WAIT_MS },
    async (status) => {
      if (!status.held)
        throw new LocalAgentError(
          'HOST_IN_USE',
          '此 profile 的本机应用连接由另一个 Cindy 实例管理。',
        );
      if (!deps.scope()) throw new LocalAgentError('UNAUTHORIZED', '本机应用授权范围已更改。');
      const server = await createLocalAgentServer(deps);
      try {
        if (!deps.scope()) throw new LocalAgentError('UNAUTHORIZED', '本机应用授权范围已更改。');
        ready({
          ...server,
          async close() {
            release();
            await lifetime;
          },
        });
        await released;
      } finally {
        await server.close();
      }
    },
    // 退役时中断等锁，否则退出 / 切账号要多等这一段 waitMs。
    signal,
  );
  void lifetime.catch(failed);
  return started;
}

export function installLocalAgentHost(maker: Maker): void {
  if (current) return;
  installEpoch += 1;
  cancelStartupRetry();
  retryAttempt = 0;
  reportedFailureCode = undefined;
  startLocalAgentHost(maker);
}

function startLocalAgentHost(maker: Maker): void {
  const session = getActiveAppSession();
  if (!session.dataOwnerId || isAppSessionBoundaryPending()) {
    // 抢在 owner 认领之前调用时不能就此放弃，否则整个进程都不会再有本机接入。
    scheduleStartupRetry(maker, OWNER_PENDING);
    return;
  }
  const scope = createHash('sha256').update(`${session.mode}:${session.dataOwnerId}`).digest('hex');
  const liveOwner = activeOwnerScopeKey();
  const directory = ownerScopedUserDataPath('local-agent');
  const scopeNow = () => {
    const now = getActiveAppSession();
    return current === pending &&
      now.dataOwnerId &&
      !isAppSessionBoundaryPending() &&
      activeOwnerScopeKey() === liveOwner
      ? createHash('sha256').update(`${now.mode}:${now.dataOwnerId}`).digest('hex')
      : '';
  };
  startupFailure = undefined;
  const lease = new AbortController();
  leaseAbort = lease;
  const pending: Promise<Awaited<ReturnType<typeof createLocalAgentServer>>> = teardown.then(() =>
    startWithProfileLease({
      directory,
      discoveryDirectory: path.join(app.getPath('userData'), 'local-agent'),
      version: app.getVersion(),
      instanceInfo: Object.freeze(instanceInfo()),
      scope: scopeNow,
      async models() {
        if (scopeNow() !== scope)
          throw new LocalAgentError('UNAUTHORIZED', 'Cindy 当前账号已更改，请重新连接。');
        const providers = await getDesktopProviderService({
          allowSideEffects: false,
        }).listProviders({
          allowSideEffects: false,
        });
        if (scopeNow() !== scope) throw new LocalAgentError('UNAUTHORIZED', 'Cindy 当前账号已更改，请重新连接。');
        const localModels = localAgentModels(providers, maker.listAvailableAgents());
        const remoteModels = await remoteLocalAgentModels(() => scopeNow() === scope, listProviderGroups(), localModels);
        if (scopeNow() !== scope) throw new LocalAgentError('UNAUTHORIZED', 'Cindy 当前账号已更改，请重新连接。');
        return [...localModels, ...remoteModels]
          .map((model, index) => ({ ...model, isDefault: index === 0 }));
      },
      async approve(signal, client) {
        const approved = await confirmLocalAgent(
          {
            title: t('localAgent.connectTitle'),
            message: t('localAgent.connectMessage').replaceAll('{{app}}', () => client.name),
            detail: `${t('localAgent.connectDetail')}\n\n${t('localAgent.clientIdentity')
              .replaceAll('{{id}}', () => client.id)
              .replaceAll('{{version}}', () => client.version ?? '—')}`,
            confirmText: t('localAgent.allow'),
            cancelText: t('localAgent.cancel'),
          },
          signal,
        );
        return approved && !signal.aborted && scopeNow() === scope;
      },
      open: async (input, bridge) => {
        // Load group orchestration only when an application actually opens a
        // session; the HTTP discovery/startup path must stay lightweight.
        const [{ getProviderGroupRemoteClient, getProviderGroupApplicationLoad, getProviderGroupRouter }, { getSelfDeviceId }] = await Promise.all([
          import('../provider-group/runtime.js'), import('../device-link/index.js'),
        ]);
        const assertCurrent = () => {
          if (scopeNow() !== scope) throw new LocalAgentError('UNAUTHORIZED', 'Cindy 当前账号已更改，请重新连接。');
        };
        assertCurrent();
        const load = getProviderGroupApplicationLoad();
        return openLocalAgentRuntime(maker, directory, input, bridge, localAgentMessage, createLocalAgentGroupRouteResolver({
          remote: getProviderGroupRemoteClient(),
          local: getProviderGroupRouter(),
          localDeviceId: getSelfDeviceId,
          assertCurrent,
        }), load.track);
      },
      message: localAgentMessage,
      warn: (code) => log.warn('local agent request failed', { code }),
      changed: () => {
        if (scopeNow() !== scope) return;
        notifySettings();
      },
    }, lease.signal),
  );
  current = pending;
  currentOwner = liveOwner;
  readyServer = undefined;
  notifySettings();
  void pending.then(
    (server) => {
      if (current === pending && scopeNow() === scope) {
        readyServer = server;
        if (reportedFailureCode) {
          log.info('local agent API recovered after startup retry', {
            code: reportedFailureCode,
            attempts: retryAttempt,
          });
          reportedFailureCode = undefined;
        }
        retryAttempt = 0;
        notifySettings();
      }
    },
    () => {},
  );
  void pending.catch((error) => {
    // dispose 取消的抢锁不是启动失败：不记 startupFailure、不告警、不重试。
    if (lease.signal.aborted) return;
    // 换代（dispose / 重新安装）之后才失败的尝试不再重试，避免旧 maker 复活。
    const stillCurrent = current === pending;
    if (stillCurrent) {
      current = undefined;
      readyServer = undefined;
      startupFailure = error;
      notifySettings();
    }
    const code = failureCode(error);
    if (reportedFailureCode !== code) {
      reportedFailureCode = code;
      log.warn('local agent API startup failed', { code });
    }
    if (stillCurrent) scheduleStartupRetry(maker, error);
  });
}

/** Read only this process's held endpoint. Never borrow a shared profile's discovery file. */
export async function localAgentDeveloperConnection(
  assertCaller = () => {},
): Promise<LocalAgentDeveloperConnection | null> {
  return settingsOperation(async () => {
    assertCaller();
    if (instanceInfo().kind !== 'development') return null;
    if (
      !getActiveAppSession().dataOwnerId ||
      isAppSessionBoundaryPending() ||
      (currentOwner !== undefined && currentOwner !== activeOwnerScopeKey())
    )
      return { state: 'owner-unavailable' };
    if (startupFailure)
      return {
        state:
          startupFailure instanceof LocalAgentError && startupFailure.code === 'HOST_IN_USE'
            ? 'host-in-use'
            : 'failed',
      };
    if (!current) return { state: 'stopped' };
    if (!readyServer) return { state: 'starting' };
    return { state: 'ready', code: formatLocalAgentConnectionCode(readyServer.rpc) };
  });
}

async function settingsOperation<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isIpcError(error)) throw error;
    log.warn('local agent settings operation failed');
    if (error instanceof LocalAgentError)
      throwIpcError('PRECONDITION_FAILED', localAgentMessage(error.code));
    throwIpcError('INTERNAL', t('localAgent.operationFailed'));
  }
}

export async function localAgentConnections(
  assertCaller = () => {},
): Promise<LocalAgentConnection[]> {
  return settingsOperation(async () => {
    if (!current && startupFailure) throw startupFailure;
    const server = current ? await current : undefined;
    assertCaller();
    return server?.connections() ?? [];
  });
}

export async function revokeLocalAgentConnections(
  connectionId?: unknown,
  assertCaller = () => {},
): Promise<boolean> {
  if (
    connectionId !== undefined &&
    (typeof connectionId !== 'string' || !connectionId || connectionId.length > 128)
  ) {
    throwIpcError('INVALID_PARAMS', t('localAgent.invalidConnection'));
  }
  return settingsOperation(async () => {
    const owner = activeOwnerScopeKey();
    const pendingServer = current;
    const server = pendingServer ? await pendingServer : undefined;
    assertCaller();
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) return false;
    if (!server) return false;
    const selected =
      connectionId === undefined
        ? undefined
        : server.connections().find((connection) => connection.id === connectionId);
    if (connectionId !== undefined && !selected) return false;
    const approved = await confirmLocalAgent({
      title: t('localAgent.title'),
      message: selected
        ? t('localAgent.revokeOneMessage').replaceAll('{{app}}', () => selected.name)
        : t('localAgent.revokeMessage'),
      detail: selected ? t('localAgent.revokeOneDetail') : t('localAgent.revokeDetail'),
      cancelText: t('localAgent.cancel'),
      confirmText: t('localAgent.revoke'),
    });
    assertCaller();
    if (
      !approved ||
      owner !== activeOwnerScopeKey() ||
      isAppSessionBoundaryPending() ||
      current !== pendingServer
    )
      return false;
    if (selected) return server.revoke(selected.id);
    await server.revokeAll();
    return true;
  });
}

export async function setLocalAgentCreateVisibleSessions(
  connectionId: unknown,
  enabled: unknown,
  assertCaller = () => {},
): Promise<boolean> {
  if (
    typeof connectionId !== 'string' ||
    !connectionId ||
    connectionId.length > 128 ||
    typeof enabled !== 'boolean'
  )
    throwIpcError('INVALID_PARAMS', t('localAgent.invalidConnection'));
  return settingsOperation(async () => {
    const owner = activeOwnerScopeKey();
    const pendingServer = current;
    const server = pendingServer ? await pendingServer : undefined;
    assertCaller();
    if (
      !server ||
      current !== pendingServer ||
      owner !== activeOwnerScopeKey() ||
      isAppSessionBoundaryPending()
    )
      return false;
    return server.setCreateVisibleSessions(connectionId, enabled);
  });
}

export async function disposeLocalAgentHost(): Promise<void> {
  installEpoch += 1;
  cancelStartupRetry();
  retryAttempt = 0;
  reportedFailureCode = undefined;
  // 中断在途的抢锁：跨进程锁最长会等 STARTUP_LOCK_WAIT_MS，不能把它算进退出 / 切账号的收尾。
  leaseAbort?.abort();
  leaseAbort = undefined;
  cancelLocalAgentConfirmations();
  const previous = current;
  current = undefined;
  readyServer = undefined;
  currentOwner = undefined;
  startupFailure = undefined;
  notifySettings();
  const stopping = previous
    ? previous
        .then((server) => server.close())
        .catch(() => log.warn('local agent API shutdown failed'))
    : Promise.resolve();
  teardown = Promise.all([teardown, stopping]).then(() => {});
  await teardown;
}
