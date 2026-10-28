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
import { t } from '../i18n.js';
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
import { createLocalAgentServer, LocalAgentError, type LocalAgentServerDeps } from './server.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { openLocalAgentRuntime } from './runtime.js';
import { localAgentMessage } from './messages.js';

import { confirmLocalAgent, cancelLocalAgentConfirmations } from './confirmation.js';

const log = createLogger('local-agent');
let current: Promise<Awaited<ReturnType<typeof createLocalAgentServer>>> | undefined;
let startupFailure: unknown;
let teardown = Promise.resolve();
let readyServer: Awaited<ReturnType<typeof createLocalAgentServer>> | undefined;
let currentOwner: string | undefined;

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

/** A shared profile has one discovery endpoint and one grant writer. Reuse the
 * existing process lock so a passive/preview instance cannot resurrect revoked grants. */
async function startWithProfileLease(deps: LocalAgentServerDeps) {
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
    { label: 'local-agent-host', waitMs: 0 },
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
  );
  void lifetime.catch(failed);
  return started;
}

export function installLocalAgentHost(maker: Maker): void {
  if (current) return;
  const session = getActiveAppSession();
  if (!session.dataOwnerId || isAppSessionBoundaryPending()) return;
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
        return localAgentModels(providers, maker.listAvailableAgents());
      },
      async approve(signal, client) {
        const approved = await confirmLocalAgent({
          title: t('localAgent.connectTitle'),
          message: t('localAgent.connectMessage').replaceAll('{{app}}', () => client.name),
          detail: `${t('localAgent.connectDetail')}\n\n${t('localAgent.clientIdentity')
            .replaceAll('{{id}}', () => client.id)
            .replaceAll('{{version}}', () => client.version ?? '—')}`,
          confirmText: t('localAgent.allow'),
          cancelText: t('localAgent.cancel'),
        }, signal);
        return approved && !signal.aborted && scopeNow() === scope;
      },
      open: (input, bridge) =>
        openLocalAgentRuntime(maker, directory, input, bridge, localAgentMessage),
      message: localAgentMessage,
      warn: (code) => log.warn('local agent request failed', { code }),
      changed: () => {
        if (scopeNow() !== scope) return;
        notifySettings();
      },
    }),
  );
  current = pending;
  currentOwner = liveOwner;
  readyServer = undefined;
  notifySettings();
  void pending.then(
    (server) => {
      if (current === pending && scopeNow() === scope) {
        readyServer = server;
        notifySettings();
      }
    },
    () => {},
  );
  void pending.catch((error) => {
    if (current === pending) {
      current = undefined;
      readyServer = undefined;
      startupFailure = error;
      notifySettings();
    }
    log.warn('local agent API startup failed', {
      code: error instanceof LocalAgentError ? error.code : 'LOCAL_AGENT_FAILED',
    });
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

export async function disposeLocalAgentHost(): Promise<void> {
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
