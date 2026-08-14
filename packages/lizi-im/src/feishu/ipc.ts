/**
 * feishu/ipc.ts
 * ---------------------------------------------------------------------------
 * IPC handlers for the Settings UI (renderer ↔ main). Channel names preserved
 * verbatim from the legacy `feishuBot:*` shape so renderer code is unchanged.
 *
 * Push channels:
 *   - feishuBot:status-change   每次状态变化都广播
 *   - feishuBot:conflict        判定冲突时广播一次
 *
 * Invoke channels:
 *   - feishuBot:get-state       一次性拉取当前状态
 *   - feishuBot:save            保存凭证 + 启动连接
 *   - feishuBot:clear           断开 + 清除所有
 */

import { getHost, getLog } from './moduleScope.js';
import { feishuEvents } from './events.js';
import * as wsClient from './wsClient.js';
import * as storage from './storage.js';
import * as ownerGuard from './ownerGuard.js';
import * as outbound from './outbound.js';
import {
  pollAppRegistration,
  requestAppRegistration,
  type AppRegistrationPollResult,
  type LarkBrand,
} from './appRegistration.js';
import type { FeishuPublicState } from './internal-types.js';

let registered = false;
let registrationRunId = 0;

interface CapturedAccountScope {
  guarded: boolean;
  token: unknown | null;
}

function captureAccountScope(): CapturedAccountScope {
  const accountScope = getHost().accountScope;
  return accountScope
    ? { guarded: true, token: accountScope.capture() }
    : { guarded: false, token: null };
}

function isAccountScopeCurrent(scope: CapturedAccountScope): boolean {
  if (!scope.guarded) return true;
  return scope.token !== null && Boolean(getHost().accountScope?.isCurrent(scope.token));
}

async function runInAccountScope<T>(
  scope: CapturedAccountScope,
  operation: () => Promise<T>,
): Promise<T> {
  if (!scope.guarded) return operation();
  const accountScope = getHost().accountScope;
  if (!accountScope || scope.token === null) {
    throw new Error('[IM_NOT_READY] IM account is not active');
  }
  return accountScope.run(scope.token, operation);
}

/** Invalidate any background registration before account transport shutdown. */
export function cancelAppRegistration(): void {
  registrationRunId += 1;
}

export function registerFeishuIpc(): void {
  if (registered) return;
  registered = true;

  const log = getLog();
  const host = getHost();

  host.ipc.handle('feishuBot:get-state', async () => getPublicState());

  host.ipc.handle('feishuBot:save', async (payload) => {
    const p = payload as { appId?: unknown; appSecret?: unknown; service?: unknown } | undefined;
    if (
      !p ||
      typeof p.appId !== 'string' ||
      typeof p.appSecret !== 'string' ||
      (p.service !== 'feishu' && p.service !== 'lark') ||
      p.appId.length === 0 ||
      p.appSecret.length === 0
    ) {
      throw new Error('[INVALID_PAYLOAD] appId, appSecret and service required');
    }
    const appId = p.appId.trim();
    const appSecret = p.appSecret.trim();
    const accountScope = captureAccountScope();
    return runInAccountScope(accountScope, () =>
      saveAndConnect(appId, appSecret, p.service as LarkBrand),
    );
  });

  host.ipc.handle('feishuBot:clear', async () => {
    await clearAndDisconnect();
    return { ok: true };
  });

  host.ipc.handle('feishuBot:set-lifecycle-announcement', async (payload) => {
    const p = payload as { enabled?: unknown } | undefined;
    const enabled = typeof p?.enabled === 'boolean' ? p.enabled : true;
    storage.writeLifecycleAnnouncement(enabled);
    wsClient.setLifecycleAnnouncement(enabled);
    return { ok: true };
  });

  host.ipc.handle('feishuBot:registration-begin', async (payload) => {
    const p = payload as { service?: unknown } | undefined;
    if (p?.service !== 'feishu' && p?.service !== 'lark') {
      return { ok: false, error: '[INVALID_PAYLOAD] service required' };
    }
    const service = p.service;
    registrationRunId++;
    const runId = registrationRunId;
    const accountScope = captureAccountScope();
    if (!isAccountScopeCurrent(accountScope)) {
      return { ok: false, error: '[IM_NOT_READY] IM account is not active' };
    }
    try {
      const begin = await requestAppRegistration(host.httpPostForm, service);
      if (runId !== registrationRunId || !isAccountScopeCurrent(accountScope)) {
        return {
          ok: false,
          error: '[IM_NOT_READY] IM account changed during registration',
        };
      }
      pollRegistrationInBackground(
        runId,
        begin.deviceCode,
        begin.interval,
        begin.expiresIn,
        accountScope,
      );
      return { ok: true, ...begin };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn(`[feishu/ipc] registration begin failed: ${error}`);
      return { ok: false, error };
    }
  });

  host.ipc.handle('feishuBot:registration-cancel', async () => {
    cancelAppRegistration();
    host.ipc.broadcast('feishuBot:registration-status', {
      status: 'cancelled',
    });
    return { ok: true };
  });

  feishuEvents.on('status', (update) => {
    host.ipc.broadcast('feishuBot:status-change', update);
  });

  feishuEvents.on('conflict', (payload) => {
    host.ipc.broadcast('feishuBot:conflict', payload);
  });

  log.info('[feishu/ipc] handlers registered');
}

// ── public state shape (preserved for renderer compatibility) ─────────────────

export function getPublicState(): FeishuPublicState {
  const creds = storage.readCredentials();
  // Read owner directly from disk — renderer may query this before
  // FeishuIM.init has populated the in-memory cache (no ordering guarantee
  // across get-state ↔ init). storage.readOwnerOpenId is the source of truth.
  return {
    status: wsClient.getCurrentStatus(),
    appId: creds?.appId ?? null,
    appSecret: creds?.appSecret ?? null,
    hasSecret: creds != null,
    ownerOpenId: storage.readOwnerOpenId(),
    lifecycleAnnouncement: storage.readLifecycleAnnouncement(),
    service: creds?.service ?? 'feishu',
  };
}

interface SaveAndConnectOptions {
  /** Owner returned by app registration for the replacement app. */
  replacementOwnerOpenId?: string | null;
}

export async function saveAndConnect(
  appId: string,
  appSecret: string,
  service: LarkBrand = 'feishu',
  options: SaveAndConnectOptions = {},
): Promise<{ verdict: 'connected' | 'conflict' | 'error' | 'pending' }> {
  const saved = storage.readCredentials();
  const credentialsUnchanged =
    saved?.appId === appId && saved.appSecret === appSecret && saved.service === service;
  if (credentialsUnchanged && options.replacementOwnerOpenId) {
    persistReplacementOwner(options.replacementOwnerOpenId);
  }
  if (credentialsUnchanged) {
    const status = wsClient.getCurrentStatus();
    if (status === 'connected') {
      getLog().info('[feishu/ipc] saveAndConnect skipped: same credentials already connected');
      return { verdict: 'connected' };
    }
    if (status === 'testing' || status === 'reconnecting') {
      getLog().info(`[feishu/ipc] saveAndConnect skipped: same credentials already ${status}`);
      return { verdict: 'pending' };
    }
    return reconnectSavedCredentials();
  }

  const ok = storage.writeCredentials({ appId, appSecret, service });
  if (!ok) return { verdict: 'error' };
  await wsClient.stop({
    reason: 'credentials-replaced',
    clearOwnerBeforeIdle: saved?.appId !== appId || saved.service !== service,
  });
  if (options.replacementOwnerOpenId) {
    persistReplacementOwner(options.replacementOwnerOpenId);
  }
  const verdict = await wsClient.start(
    { appId, appSecret, service },
    { reason: 'credentials-replaced' },
  );
  return { verdict };
}

function persistReplacementOwner(ownerOpenId: string): void {
  const ownerWritten = storage.writeOwnerOpenId(ownerOpenId);
  if (!ownerWritten) {
    throw new Error('[OWNER_PERSIST_FAILED] Failed to persist IM bot owner');
  }
  ownerGuard.loadFromDisk();
}

/** Restart the saved WebSocket connection without changing credentials or owner binding. */
export async function reconnectSavedCredentials(): Promise<{
  verdict: 'connected' | 'conflict' | 'error';
}> {
  const creds = storage.readCredentials();
  if (!creds) {
    throw new Error('[NO_CREDENTIALS] IM bot credentials are not configured');
  }
  await wsClient.stop({ announceOffline: false, reason: 'manual-reconnect' });
  const verdict = await wsClient.start(creds, {
    announceLifecycle: false,
    reason: 'manual-reconnect',
  });
  return { verdict };
}

async function pollRegistrationInBackground(
  runId: number,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  accountScope: CapturedAccountScope,
): Promise<void> {
  const host = getHost();
  const log = getLog();
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = Math.max(interval, 1);
  let pollBrand: LarkBrand = 'feishu';
  let pollWithoutDelay = false;

  while (
    Date.now() < deadline &&
    runId === registrationRunId &&
    isAccountScopeCurrent(accountScope)
  ) {
    if (!pollWithoutDelay) {
      await delay(currentInterval * 1000);
      if (runId !== registrationRunId || !isAccountScopeCurrent(accountScope)) return;
    }
    pollWithoutDelay = false;

    let result: AppRegistrationPollResult;
    try {
      result = await pollAppRegistration(
        host.httpPostForm,
        pollBrand,
        deviceCode,
        currentInterval,
      );
    } catch (err) {
      if (runId !== registrationRunId || !isAccountScopeCurrent(accountScope)) return;
      const error = err instanceof Error ? err.message : String(err);
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'error',
        error,
      });
      return;
    }
    if (runId !== registrationRunId || !isAccountScopeCurrent(accountScope)) return;

    const discoveredBrand =
      result.status === 'success' ? result.result.tenantBrand : result.tenantBrand;
    if (pollBrand === 'feishu' && discoveredBrand === 'lark') {
      pollBrand = 'lark';
      pollWithoutDelay = true;
      continue;
    }

    if (result.status === 'pending') {
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'pending',
      });
      continue;
    }

    if (result.status === 'slow_down') {
      currentInterval = result.interval;
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'pending',
      });
      continue;
    }

    if (result.status === 'success') {
      const success = result.result;
      if (!success.clientId || !success.clientSecret) {
        host.ipc.broadcast('feishuBot:registration-status', {
          status: 'pending',
        });
        continue;
      }

      let verdict: 'connected' | 'conflict' | 'error' | 'pending';
      try {
        ({ verdict } = await runInAccountScope(accountScope, async () => {
          return saveAndConnect(
            success.clientId,
            success.clientSecret,
            success.tenantBrand ?? pollBrand,
            {
              replacementOwnerOpenId: success.ownerOpenId,
            },
          );
        }));
      } catch (err) {
        if (!isAccountScopeCurrent(accountScope)) return;
        const error = err instanceof Error ? err.message : String(err);
        host.ipc.broadcast('feishuBot:registration-status', {
          status: 'error',
          error,
        });
        return;
      }
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'success',
        appId: success.clientId,
        ownerOpenId: success.ownerOpenId,
        verdict,
      });
      return;
    }

    if (result.status === 'expired') {
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'expired',
        error: result.message,
      });
      return;
    }

    if (result.status === 'denied' || result.status === 'error') {
      host.ipc.broadcast('feishuBot:registration-status', {
        status: 'error',
        error: result.message,
      });
      return;
    }
  }

  if (runId === registrationRunId && isAccountScopeCurrent(accountScope)) {
    log.info('[feishu/ipc] registration expired');
    host.ipc.broadcast('feishuBot:registration-status', { status: 'expired' });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function clearAndDisconnect(): Promise<void> {
  cancelAppRegistration();
  await wsClient.stop({
    reason: 'credentials-cleared',
    clearOwnerBeforeIdle: true,
  });
  // 逻辑凭证清除(而非 transport 重连): 清掉账号态并重置 lastBoundCreds —
  // 之后重新保存相同 appId/service 不会被误判为同账号重连, 登出前的
  // opener/锚点不会被新一轮会话认领; 挂起的孤儿提示重试同样丢弃。
  outbound.forgetBoundAccount();
  wsClient.clearOrphanRetriesForCredentialClear();
  storage.clearAll();
}
