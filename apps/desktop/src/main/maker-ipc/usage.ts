/**
 * apps/desktop/src/main/maker-ipc/usage.ts
 *
 * maker:usage:* IPC 的 Electron adapter。
 * handler body 在 usageHandlers.ts；host-level usage 依赖在这里注入，避免测试 import
 * handler 时拉起 Electron / runtime config 副作用。
 */

import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage.js';
import { createHash } from 'node:crypto';
import { readSubscriptionAccountUsage, triggerSubscriptionAccountUsage, syncSubscriptionAccountUsage, setSubscriptionAccountUsageBroadcaster } from '../usage/subscriptionAccountUsage.js';
import { broadcastSubscriptionAccountUsage, clearXaiRateLimitSnapshot } from '../usageBroadcaster.js';
import { subscriptionAccountKind } from '../maker-host/subscription-account-auth.js';
import { setClaudeRateLimitInfoListener, type Maker } from '@cindy/maker-core';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import {
  readClaudeAccountUsageSnapshot,
  triggerClaudeAccountUsageRefresh,
} from '../usage/claudeAccountUsage.js';
import {
  parseClaudeSdkRateLimitInfo,
  type ClaudeSubscriptionUsageSnapshot,
} from '../../shared/claudeSubscriptionUsage.js';
import {
  XaiSubscriptionUsageRateLimitedError,
  XaiSubscriptionUsageUnauthorizedError,
  fetchXaiSubscriptionUsageSnapshot,
} from '../usage/xaiSubscriptionUsage.js';
import { createXaiSubscriptionUsageReader } from '../usage/xaiSubscriptionUsageRefresh.js';
import { createCodexAccountUsageSnapshotReader } from '../usage/codexAccountUsageRefresh.js';
import { getGatewayModelPricing } from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import {
  CodexWebUsageUnauthorizedError,
  fetchCodexWebUsageSnapshot,
} from '../usage/codexWebUsage.js';
import { emptyUsageHistoryPayload, readUsageHistory } from '../usage/usageHistory.js';
import {
  clearClaudeSubscriptionUsageSnapshot,
  clearCodexAccountUsageSnapshot,
  clearXaiSubscriptionUsageSnapshot,
  readAgentTodayUsage,
  readClaudeSubscriptionUsageSnapshot,
  readCodexAccountUsageSnapshot,
  readXaiSubscriptionUsageSnapshot,
  recordClaudeSubscriptionUsageSnapshot,
  recordCodexAccountUsageSnapshot,
  recordXaiSubscriptionUsageSnapshot,
} from '../usageBroadcaster.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { isOpenAiSubscriptionProviderId } from '../maker-host/codex-account-auth.js';
import { desktopCodexAuthAdapter } from '../maker-host/auth-adapters.js';
import { hasClaudeNativeLogin } from '../maker-host/claude-native-auth.js';
import { peekClaudeCliLoginStatus } from '../maker-host/claude-native-cli-status.js';
import { getGrokAccessToken, hasGrokOAuthLogin } from '../maker-host/grok-oauth-login.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { createCodexRateLimitResetService } from '../usage/codexRateLimitReset.js';

import { createElectronIpcHandlerRegistry } from './electronIpcRegistry.js';
import { registerMakerUsageHandlers } from './usageHandlers.js';

const log = createLogger('maker-ipc:usage');

/**
 * 当前 Claude 账号的快照归属指纹(CLI 登录邮箱的 sha256 截断,不含邮箱原文)。同机在
 * CLI 里换号时据此丢弃上一个账号的持久化快照。未登录 / CLI 没报邮箱时为 null。
 */
function currentClaudeAccountFingerprint(): string | null {
  const email = peekClaudeCliLoginStatus()?.email;
  return email ? createHash('sha256').update(`claude-usage:${email}`).digest('hex').slice(0, 16) : null;
}

/**
 * 内置 Claude 订阅的余量 reader。订阅会话由内置 CLI 用自己的登录直连 Anthropic,Cindy
 * 不持有订阅 token,也不去查用量端点;快照只来自 CLI 在会话里上报的 SDK
 * `rate_limit_event`(见 registerMakerUsageIpc 的 setClaudeRateLimitInfoListener),
 * 按 headers 源同口径增量合并、持久化。这里只负责读缓存与凭证变化后的清理。
 */
interface ClaudeSubscriptionUsageReader {
  /** IPC / device-link 读:缓存快照(未连接时 null)。 */
  read(): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  /** turn-done 钩子:没有可主动拉取的端点,保留接口形状。 */
  triggerRefresh(): void;
  /** 登录态变化后的强制同步:未连接时无条件清快照并广播。 */
  syncForCredentialChange(): Promise<void>;
}

const claudeSubscriptionUsageReader: ClaudeSubscriptionUsageReader = {
  async read(): Promise<ClaudeSubscriptionUsageSnapshot | null> {
    if (!hasClaudeNativeLogin()) return null;
    const snapshot = await readClaudeSubscriptionUsageSnapshot();
    const fingerprint = currentClaudeAccountFingerprint();
    if (snapshot?.accountFingerprint && fingerprint && snapshot.accountFingerprint !== fingerprint) {
      await clearClaudeSubscriptionUsageSnapshot();
      return null;
    }
    return snapshot;
  },
  // 没有可主动拉取的余量端点:余量随会话里的 rate_limit_event 更新。
  triggerRefresh(): void {},
  async syncForCredentialChange(): Promise<void> {
    if (!hasClaudeNativeLogin()) {
      await clearClaudeSubscriptionUsageSnapshot();
      return;
    }
    await claudeSubscriptionUsageReader.read();
  },
};

/**
 * Claude turn done 后的订阅余量刷新钩子 (register.ts 消费) —— fire-and-forget,
 * 节流 / 429 退避在 reader 内部。未连订阅时 no-op。
 */
export function triggerClaudeSubscriptionUsageRefresh(providerId?: string): void {
  if (providerId && providerId !== 'anthropic') { triggerSubscriptionAccountUsage(providerId); return; }
  claudeSubscriptionUsageReader.triggerRefresh();
}

/**
 * Claude 订阅登录态变化(CLI 登录 / 登出 / 换号 / Cindy 断开)后的余量同步钩子(bootstrap
 * 的 CLAUDE_OAUTH_LOGIN / LOGOUT handler 与 CLI 登录态监听消费):
 *   - 未连接 → 清快照并广播 null(chip 立即回占位态);
 *   - 换号 → 指纹校验清掉旧账号快照,新余量等下一次会话上报。
 * renderer 不需要感知 auth 事件, 全靠既有 usage:claude-subscription-changed push。
 */
export function syncClaudeSubscriptionUsageForAuthChange(providerId?: string): void {
  if (providerId && providerId !== 'anthropic') { void syncSubscriptionAccountUsage(providerId); return; }
  void claudeSubscriptionUsageReader.syncForCredentialChange().catch(() => {
    /* reader 内部已把错误交给 onRefreshError, 这里只兜底 promise 拒绝。 */
  });
}

async function readXaiCredentialsInfo(): Promise<{ accessToken: string } | null> {
  if (!hasGrokOAuthLogin()) return null;
  try {
    const accessToken = await getGrokAccessToken();
    return accessToken ? { accessToken } : null;
  } catch {
    return null;
  }
}

const xaiSubscriptionUsageReader = createXaiSubscriptionUsageReader({
  readCredentials: readXaiCredentialsInfo,
  fetchSnapshot: (credentials) =>
    fetchXaiSubscriptionUsageSnapshot({
      accessToken: credentials.accessToken,
      fetchFn: outboundFetch,
    }),
  recordSnapshot: recordXaiSubscriptionUsageSnapshot,
  clearSnapshot: clearXaiSubscriptionUsageSnapshot,
  readCachedSnapshot: readXaiSubscriptionUsageSnapshot,
  now: () => Date.now(),
  isUnauthorizedError: (err) => err instanceof XaiSubscriptionUsageUnauthorizedError,
  isRateLimitedError: (err) => err instanceof XaiSubscriptionUsageRateLimitedError,
  onRefreshError: (err) => {
    log.warn(
      'xAI subscription usage refresh failed:',
      err instanceof Error ? err.message : String(err),
    );
  },
});

/** SuperGrok 周用量:turn-done 钩子,节流 / 退避 / 未登录 no-op 都在 reader 内。 */
export function triggerXaiSubscriptionUsageRefresh(providerId?: string): void {
  if (providerId && providerId !== 'xai') { triggerSubscriptionAccountUsage(providerId); return; }
  xaiSubscriptionUsageReader.triggerRefresh();
}

/**
 * device-link dispatch 专用的 xAI 订阅余量读取出口。ipcMain 面的
 * USAGE_XAI_SUBSCRIPTION 挂了 assertTrustedSender(合成 event 必然不可信,那道闸
 * 不为远程放宽)—— 与 device-link:telegram:* 同先例,被控端 dispatch 过三道 gate
 * (被控开关 + 撤销黑名单 + allowlist)后直读本函数,不进 ipcMain。cached-first,
 * 与本机 renderer 读到的快照同形。
 */
export async function readXaiSubscriptionUsageSnapshotForDeviceLink(providerId?: string): Promise<XaiSubscriptionUsageSnapshot | null> {
  if (!providerId || providerId === 'xai') return xaiSubscriptionUsageReader.read();
  if (subscriptionAccountKind(providerId) !== 'xai') return null;
  return await readSubscriptionAccountUsage(providerId) as XaiSubscriptionUsageSnapshot | null;
}

export async function readClaudeSubscriptionUsageSnapshotForDeviceLink(providerId?: string): Promise<import('../../shared/claudeSubscriptionUsage.js').ClaudeSubscriptionUsageSnapshot | null> {
  if (!providerId || providerId === 'anthropic') return claudeSubscriptionUsageReader.read();
  if (subscriptionAccountKind(providerId) !== 'claude') return null;
  return await readSubscriptionAccountUsage(providerId) as import('../../shared/claudeSubscriptionUsage.js').ClaudeSubscriptionUsageSnapshot | null;
}

/** SuperGrok 登录 / 登出 / 换号后强制同步(先清再拉)。调用方应 await 后再广播连接态。 */
export function syncXaiSubscriptionUsageForAuthChange(providerId?: string): Promise<void> {
  if (providerId && providerId !== 'xai') return syncSubscriptionAccountUsage(providerId);
  return xaiSubscriptionUsageReader.syncForCredentialChange().catch(() => {
    /* reader 内部已把错误交给 onRefreshError */
  });
}

function normalizeCodexUsageProvider(providerId?: string): string | undefined {
  if (providerId === undefined || providerId === 'openai') return undefined;
  if (!isOpenAiSubscriptionProviderId(providerId)) throw new Error('Unknown OpenAI account provider');
  return providerId;
}
let codexReadersOwner = '';
const codexUsageReaders = new Map<string, ReturnType<typeof createCodexAccountUsageSnapshotReader>>();
function readCodexAccountUsageSnapshotWithWebRefresh(requestedProviderId?: string) {
  const providerId = normalizeCodexUsageProvider(requestedProviderId);
  const scope = activeOwnerScopeKey();
  if (scope !== codexReadersOwner) { codexUsageReaders.clear(); codexReadersOwner = scope; }
  const key = providerId ?? 'openai';
  const existing = codexUsageReaders.get(key);
  if (existing) return existing();
const reader = createCodexAccountUsageSnapshotReader({
  readAccessToken: () => scope === activeOwnerScopeKey() ? desktopCodexAuthAdapter.getAccessToken(providerId) : Promise.reject(new Error('Account scope changed')),
  readAccountId: () => desktopCodexAuthAdapter.getAccountId(providerId),
  fetchWebUsageSnapshot: fetchCodexWebUsageSnapshot,
  recordSnapshot: (snapshot) => scope === activeOwnerScopeKey() ? recordCodexAccountUsageSnapshot(snapshot, providerId) : Promise.resolve(),
  clearSnapshot: () => scope === activeOwnerScopeKey() ? clearCodexAccountUsageSnapshot(providerId) : Promise.resolve(),
  readCachedSnapshot: () => scope === activeOwnerScopeKey() ? readCodexAccountUsageSnapshot(providerId) : Promise.resolve(null),
  now: () => Date.now(),
  isUnauthorizedError: (err) => err instanceof CodexWebUsageUnauthorizedError,
  onRefreshError: (err) => {
    log.warn('codex web usage refresh failed:', err instanceof Error ? err.message : String(err));
  },
});

  codexUsageReaders.set(key, reader);
  return reader();
}

/**
 * 触发 ChatGPT 订阅额度(wham/usage)后台刷新 —— 复用带 web-refresh 的 reader:拉到新快照即
 * recordSnapshot → 广播 usage:codex-account-changed(reader 内部 10s 节流 + in-flight 去重)。
 * 供 claude-code 框架下 `chatgpt/` bridge 轮结束后调用,让底部 chip 的 ChatGPT 额度实时更新
 * (bridge 轮不产生 codex account_usage 事件,需主动触发)。fire-and-forget。
 */
export function triggerCodexAccountUsageRefresh(providerId?: string): void {
  void readCodexAccountUsageSnapshotWithWebRefresh(providerId).catch(() => {
    /* best-effort: 失败保留上一次快照, 不影响 turn 收尾 */
  });
}

export function registerMakerUsageIpc(maker: Maker): void {
  log.info('registering maker:usage:* IPC handlers');

  const resetServices = new Map<string, ReturnType<typeof createCodexRateLimitResetService>>();
  let resetServicesOwner = '';
  function getResetService(providerId?: string) {
    providerId = normalizeCodexUsageProvider(providerId);
    const scope = activeOwnerScopeKey();
    if (scope !== resetServicesOwner) { resetServices.clear(); resetServicesOwner = scope; }
    const key = providerId ?? 'openai';
    const existing = resetServices.get(key);
    if (existing) return existing;
    const assertScope = () => {
      if (isAppSessionBoundaryPending() || scope !== activeOwnerScopeKey()) throw new Error('PRECONDITION_FAILED: Account scope changed');
    };
  const service = createCodexRateLimitResetService({
    readRateLimits: async () => { assertScope(); const result = await maker.readAgentAccountRateLimits('codex', providerId); assertScope(); return result; },
    consumeResetCredit: async (params) => { assertScope(); const result = await maker.consumeAgentAccountRateLimitResetCredit('codex', params, providerId); assertScope(); return result; },
    readAccountIdentity: async () => {
      assertScope();
      const state = await desktopCodexAuthAdapter.getState({ providerId });
      assertScope();
      const accountId =
        state.authSource === 'oauth' ? await desktopCodexAuthAdapter.getAccountId(providerId) : null;
      const identity =
        state.authSource === 'oauth' && state.identity?.includes('@') ? state.identity : null;
      assertScope();
      return { email: identity, accountId };
    },
    recordRateLimitSnapshot: (snapshot) => scope === activeOwnerScopeKey() ? recordCodexAccountUsageSnapshot(snapshot, providerId) : Promise.resolve(),
  });

    resetServices.set(key, service);
    return service;
  }

  setSubscriptionAccountUsageBroadcaster(broadcastSubscriptionAccountUsage, clearXaiRateLimitSnapshot);
  registerMakerUsageHandlers(createElectronIpcHandlerRegistry(), {
    readAgentTodayUsage,
    readCodexAccountUsageSnapshot: readCodexAccountUsageSnapshotWithWebRefresh,
    // Bind recovery confirmation to the exact owner, marker and OAuth credential observed before
    // this account-level RPC. A stale response still returns its usage payload but cannot consume a
    // newer recovery state.
    readCodexRateLimits: async (providerId) => {
      const scope = activeOwnerScopeKey();
      const service = getResetService(providerId);
      const result = providerId && providerId !== 'openai'
        ? await service.read()
        : await desktopCodexAuthAdapter.verifyRecoveryWithAccountRpc(() => service.read());
      if (scope !== activeOwnerScopeKey()) throw new Error('PRECONDITION_FAILED: Account scope changed');
      return { ...result, providerId: providerId ?? 'openai' };
    },
    consumeCodexRateLimitReset: async (key, providerId) => {
      const scope = activeOwnerScopeKey();
      const result = await getResetService(providerId).consume(key);
      if (scope !== activeOwnerScopeKey()) throw new Error('PRECONDITION_FAILED: Account scope changed');
      return { ...result, providerId: providerId ?? 'openai',
        rateLimits: result.rateLimits ? { ...result.rateLimits, providerId: providerId ?? 'openai' } : null };
    },
    readClaudeSubscriptionUsageSnapshot: readClaudeSubscriptionUsageSnapshotForDeviceLink,
    readXaiSubscriptionUsageSnapshot: readXaiSubscriptionUsageSnapshotForDeviceLink,
    assertTrustedSender: (event) => {
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    },
    readClaudeAccountUsageSnapshot,
    triggerClaudeAccountUsageRefresh,
    readModelPricing: getGatewayModelPricing,
    readReferenceModelPricing: getReferenceModelPricing,
    readUsageHistory,
    emptyUsageHistory: emptyUsageHistoryPayload,
  });

  // 订阅会话的 CLI 在会话里上报 SDK rate_limit_event → 落库 + 广播(maker-core 只对本机
  // Claude 订阅会话转发)。事件晚于登出 / 断开到达时丢弃,不复活刚清掉的快照。
  setClaudeRateLimitInfoListener((info) => {
    if (!hasClaudeNativeLogin()) return;
    const snapshot = parseClaudeSdkRateLimitInfo(info, Date.now());
    if (!snapshot) return;
    const fingerprint = currentClaudeAccountFingerprint();
    const subscriptionType = peekClaudeCliLoginStatus()?.subscriptionType;
    void recordClaudeSubscriptionUsageSnapshot({
      ...snapshot,
      ...(fingerprint ? { accountFingerprint: fingerprint } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
    });
  });

  log.info('maker usage IPC handlers registered');
}
