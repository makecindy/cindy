import path from 'node:path';
import { createRequire } from 'node:module';
import { createCodexUsageControl } from '@cindy/app-runtime/codexUsageControl';
import { createCodexResetAutoUseStore } from '@cindy/app-runtime/codexResetAutoUseStore';
import { registerMakerUsageHandlers } from '@cindy/app-runtime/usageHandlers';
import { createUsageHistory } from '@cindy/app-runtime/usageHistory';
import { createPeerUsageRuntime, type PeerUsageSyncDeps } from '@cindy/app-runtime/peerUsageSync';
import { createBotRemoteSessionAccess } from '@cindy/app-runtime/botRemoteSessionAccess';
import { readUsageDeviceRows } from '@cindy/app-runtime/usageDeviceRows';
import type { IpcHandler } from '@cindy/app-runtime/ipcHandlerRegistry';
import type { TerminalUsage } from '../tasks/usage.js';
import type { TerminalConversations } from '../tasks/conversations.js';
import type { TerminalModelConfig } from './config.js';
import type { InvocationContext } from '../contracts.js';
import type { Logger } from '@cindy/maker-core';

const semver = createRequire(import.meta.url)('semver') as { valid(value: string): string | null; compare(a: string, b: string): number };

/** Original usage reads, account controls and cross-computer history, with only
 * the owner's storage, native account and device transport supplied by Node. */
export function createTerminalUsageApi(options: {
  usage: TerminalUsage; conversations: TerminalConversations; models: TerminalModelConfig;
  root: string; logger: Logger; deviceId?: string; ownerId(): string | null;
  assertCurrent(): void; restored(providerId: string): Promise<void>;
}) {
  const { usage, models, conversations } = options;
  let closed = false;
  let peers: Pick<PeerUsageSyncDeps, 'listDevices' | 'invoke'> | undefined;
  const current = () => { if (closed) throw new Error('OWNER_CHANGED'); options.assertCurrent(); };
  const scope = () => { current(); return options.ownerId() ?? 'local'; };
  const pending = () => { try { current(); return false; } catch { return true; } };
  const account = (id = 'openai') => { current(); const result = models.openAiAccount(id); if (!result?.connected()) throw new Error('PROVIDER_LOGIN_REQUIRED'); return result; };
  const reset = createCodexUsageControl({
    maker: {
      readAgentAccountRateLimits: (_kind, id) => account(id).withAccountControl(options.logger, agent => agent.readAccountRateLimits()),
      consumeAgentAccountRateLimitResetCredit: (_kind, input, id) => account(id).withAccountControl(options.logger, agent => agent.consumeAccountRateLimitResetCredit(input)),
    }, activeOwnerScopeKey: scope, isAppSessionBoundaryPending: pending,
    normalizeCodexUsageProvider: id => { if (!id || id === 'openai') return undefined; if (!usage.accounts.isOpenAiSubscriptionProviderId(id)) throw new Error('Unknown OpenAI account provider'); return id; },
    desktopCodexAuthAdapter: {
      getState: async ({ providerId }) => { const selected = models.openAiAccount(providerId); return selected?.connected() ? { authenticated: true, authSource: 'oauth', identity: selected.accountIdentity().email ?? undefined } : { authenticated: false }; },
      getAccountId: async id => account(id).accountIdentity().accountId,
      // This host's encrypted vault does not use Desktop's legacy CLI-home
      // reconciliation marker. Credential refresh and owner fences live in the
      // selected account's native control operation above.
      verifyRecoveryWithAccountRpc: operation => operation(),
    }, recordCodexAccountUsageSnapshot: usage.recordCodexAccountUsageSnapshot,
    readCodexAccountUsageSnapshotWithWebRefresh: usage.accounts.readCodexAccountUsage,
    codexResetAutoUseStore: createCodexResetAutoUseStore(() => path.join(options.root, 'codex-reset-auto-use.json'), scope, options.logger),
    resetRestoredListeners: new Set([options.restored]), observeUsageChanges: usage.observeUsageChanges, log: options.logger,
  });
  const createLogger = () => ({ debug: (message: string, ...details: unknown[]) => options.logger.debug(message, { details }) });
  const peerRuntime = createPeerUsageRuntime({ createLogger,
    compareAppUpdateVersions: (target, previous) => {
      if (typeof target !== 'string' || typeof previous !== 'string' || !semver.valid(target) || !semver.valid(previous)) return 'invalid';
      const result = semver.compare(target, previous); return result > 0 ? 'newer' : result < 0 ? 'older' : 'same';
    },
  });
  const requirePeers = () => { current(); if (!peers) throw new Error('AUTH_REQUIRED'); return peers; };
  peerRuntime.configurePeerUsageSync(peerRuntime.withPeerUsageAccessGate(requirePeers, {
    userId: options.ownerId, selfDeviceId: () => options.deviceId ?? null,
    listDevices: () => requirePeers().listDevices(), invoke: (...args) => requirePeers().invoke(...args),
    readCache: id => peerRuntime.readPeerUsageCacheFile(peerRuntime.peerUsageCacheFilePath(options.root, id)),
    writeCache: async (id, value) => { current(); await peerRuntime.writePeerUsageCacheFile(peerRuntime.peerUsageCacheFilePath(options.root, id), value); }, now: Date.now,
  }));
  const history = createUsageHistory({ ...usage, ...usage.dailySpend, ...usage.dailyModel, ...usage.dailySession,
    getCurrentDbClientUserId: options.ownerId, createLogger,
    userDataPath: () => { current(); return options.root; }, getPeerUsageSync: peerRuntime.getPeerUsageSync,
  });
  const access = createBotRemoteSessionAccess({ getDbClient: usage.getDbClient, ...conversations.broadcastTap });
  const handlers = new Map<string, IpcHandler>();
  registerMakerUsageHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, {
    ...reset, ...usage,
    readCodexAccountUsageSnapshot: usage.accounts.readCodexAccountUsage,
    readClaudeSubscriptionUsageSnapshot: usage.accounts.readClaudeSubscriptionUsage,
    readXaiSubscriptionUsageSnapshot: usage.accounts.readXaiSubscriptionUsage,
    assertTrustedSender: event => { current(); const context = event as InvocationContext; if (context.sharedTask || context.source === 'remote' && !context.deviceId) throw new Error('OWNER_REQUIRED'); context.assertCurrent?.(); },
    readModelPricing: usage.pricing.getGatewayModelPricing, readReferenceModelPricing: usage.pricing.getReferenceModelPricing,
    readUsageHistory: history.readUsageHistory, emptyUsageHistory: history.emptyUsageHistoryPayload,
    readUsageDeviceRows: request => readUsageDeviceRows({ ...usage.dailySpend, ...usage.dailyModel, ...usage.dailySession,
      todayKey: () => usage.dailySpend.localDayKey(),
      remoteVisibleTaskIds: async ids => { const visibility = await access.readRemoteBotSessionAccessBatch(ids); return new Set(ids.filter(id => (visibility.get(id) ?? 'hidden') !== 'hidden')); },
    }, request),
  });
  return { channels: [...handlers.keys()], ...reset,mayServeBackgroundRead:peerRuntime.mayServeBackgroundRead,
    has: (channel: string) => handlers.has(channel),
    async invoke(channel: string, args: unknown[], context: InvocationContext) {
      current(); context.assertCurrent?.(); if (context.sharedTask) throw new Error('OWNER_REQUIRED');
      const result = await handlers.get(channel)!(context, ...args); current(); context.assertCurrent?.(); return result;
    },
    bindPeers(value: NonNullable<typeof peers>) { current(); peers = value; },
    close() { closed = true; reset.close(); peers = undefined; },
  };
}
