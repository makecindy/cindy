import { isOpenAiSubscriptionProvider } from '@cindy/model-providers';
import { parseClaudeOAuthUsageResponse } from '@cindy/remote-agent/shared/claudeSubscriptionUsage';
import type { XaiSubscriptionUsageSnapshot } from '@cindy/maker-shared/subscription-usage';
import type { ModelAccessStatus } from '@cindy/model-providers/modelAccess';
import { createClaudeSubscriptionUsageReader } from '@cindy/app-runtime/claudeSubscriptionUsageRefresh';
import { createCodexAccountUsageSnapshotReader } from '@cindy/app-runtime/codexAccountUsageRefresh';
import { createCodexWebUsage } from '@cindy/app-runtime/codexWebUsage';
import { createXaiSubscriptionUsageReader } from '@cindy/app-runtime/xaiSubscriptionUsageRefresh';
import { createXaiSubscriptionUsage } from '@cindy/app-runtime/xaiSubscriptionUsage';
import { createQuotaCredentialState, type QuotaAuthState } from '@cindy/app-runtime/quotaCredentialState';
import { createOrganizationAccountUsage } from '@cindy/app-runtime/organizationAccountUsage';
import { createClaudeAccountUsage } from '@cindy/app-runtime/claudeAccountUsage';
import { createClaudeUsageEventRecorder } from '@cindy/app-runtime/claudeUsageEvents';
import type { createUsageBroadcaster } from '@cindy/app-runtime/usageBroadcaster';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { TerminalPricing } from './pricing.js';
import type { TerminalModelConfig } from './config.js';

export function createTerminalAccountUsage(options: {
  models: TerminalModelConfig;
  pricing: TerminalPricing;
  usage: ReturnType<typeof createUsageBroadcaster>;
  logger: DbLogger;
  assertCurrent(): void;
  emit(channel: string, payload: unknown): void;
  fetch?: typeof fetch;
}) {
  let closed = false;
  const abort = new AbortController();
  const current = () => { if (closed) throw new Error('TASK_OWNER_CHANGED'); options.assertCurrent(); };
  const isCurrent = () => { try { current(); return true; } catch { return false; } };
  const fetchOwned: typeof fetch = async (url, init) => {
    current();
    const result = await (options.fetch ?? fetch)(url, { ...init,
      signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]) });
    current(); return result;
  };
  const createLogger = () => options.logger;
  const publish = (channel: string, payload: unknown) => { if (isCurrent()) options.emit(channel, payload); };
  let cloud: { auth(): QuotaAuthState; status(): ModelAccessStatus; fetchQuota(): Promise<unknown> } | undefined;
  const guest: QuotaAuthState = { mode: 'guest', dataOwnerId: null, ownerGeneration: 0 };
  const quota = createQuotaCredentialState();
  quota.setQuotaCredentialStatusReader(() => isCurrent() ? cloud?.status() ?? null : null);
  const organization = createOrganizationAccountUsage({
    fetchQuota: () => { current(); if (!cloud) throw new Error('ACCOUNT_NOT_CONNECTED'); return cloud.fetchQuota(); },
    isLegacyQuotaError: error => {
      const failure = error as { statusCode?: number; code?: string } | null;
      return failure?.statusCode === 404 || failure?.statusCode === 501 && failure?.code === 'MODEL_ACCESS_QUOTA_NOT_SUPPORTED';
    },
  });
  const gateway = createClaudeAccountUsage({ ...quota, ...organization, ...options.pricing, createLogger,
    getAuthState: () => isCurrent() ? cloud?.auth() ?? guest : guest,
    readClaudeApiKey: () => isCurrent() ? options.models.gatewayCredentials()?.apiKey ?? null : null,
    reportCindyGatewayKeyRejected: key => { if (isCurrent()) options.models.reportGatewayRejection(key); },
    outboundFetch: fetchOwned, claudeUpstreamEndpoint: () => options.models.gatewayCredentials()?.endpoint ?? '',
    broadcastLocal: publish, tapWindowBroadcast() {},
  });
  const claude = createClaudeSubscriptionUsageReader({
    readAccount: () => isCurrent() ? options.models.nativeClaude?.usageAccountFingerprint() ?? null : null,
    fetchSnapshot: async () => {
      current();
      const native = options.models.nativeClaude;
      if (!native) throw new Error('NATIVE_SUBSCRIPTION_LOGIN_REQUIRED');
      const usage = await native.readPlanUsage();
      current();
      if (!usage) return 'empty';
      const snapshot = parseClaudeOAuthUsageResponse(usage.rateLimits, Date.now());
      if (!snapshot) throw new Error('claude get_usage returned unrecognized rate_limits');
      return usage.subscriptionType ? { ...snapshot, subscriptionType: usage.subscriptionType } : snapshot;
    },
    recordSnapshot: async value => { if (isCurrent()) await options.usage.recordClaudeSubscriptionUsageSnapshot(value); },
    clearSnapshot: async () => { if (isCurrent()) await options.usage.clearClaudeSubscriptionUsageSnapshot(); },
    readCachedSnapshot: () => isCurrent() ? options.usage.readClaudeSubscriptionUsageSnapshot() : Promise.resolve(null),
    now: Date.now, onRefreshError: () => options.logger.warn('CLAUDE_USAGE_REFRESH_FAILED'),
  });
  const web = createCodexWebUsage({ createLogger, fetch: fetchOwned });
  const codex = new Map<string, ReturnType<typeof createCodexAccountUsageSnapshotReader>>();
  function codexReader(providerId = 'openai') {
    current();
    let reader = codex.get(providerId);
    if (!reader) {
      const account = () => options.models.openAiAccount(providerId);
      reader = createCodexAccountUsageSnapshotReader({
        readAccessToken: async () => { current(); const selected = account(); return selected?.connected() ? (await selected.credential()).accessToken : null; },
        readAccountId: async () => { current(); const selected = account(); return selected?.connected() ? (await selected.credential()).accountId : null; },
        fetchWebUsageSnapshot: web.fetchCodexWebUsageSnapshot,
        recordSnapshot: async value => { if (isCurrent()) await options.usage.recordCodexAccountUsageSnapshot(value, providerId); },
        clearSnapshot: async () => { if (isCurrent()) await options.usage.clearCodexAccountUsageSnapshot(providerId); },
        readCachedSnapshot: () => isCurrent() ? options.usage.readCodexAccountUsageSnapshot(providerId) : Promise.resolve(null),
        now: Date.now, isUnauthorizedError: error => error instanceof web.CodexWebUsageUnauthorizedError,
        onRefreshError: () => options.logger.warn('CODEX_USAGE_REFRESH_FAILED'),
      });
      codex.set(providerId, reader);
    }
    return reader;
  }
  const xai = new Map<string, ReturnType<typeof createXaiSubscriptionUsageReader>>();
  function xaiReader(providerId = 'xai') {
    current();
    let reader = xai.get(providerId);
    if (!reader) {
      const account = () => options.models.grokAccount(providerId);
      let snapshot: XaiSubscriptionUsageSnapshot | null = null;
      const fetcher = createXaiSubscriptionUsage({ createLogger,
        get XAI_ACCOUNT_USER_URL() { const selected = account(); if (!selected) throw new Error('PROVIDER_NOT_FOUND'); return selected.usageAccountUrl(); },
        buildXaiCliProxyHeaders: token => { const selected = account(); if (!selected) throw new Error('PROVIDER_NOT_FOUND'); return selected.usageRequestHeaders(token); },
      });
      reader = createXaiSubscriptionUsageReader({
        readCredentials: async () => { if (!isCurrent()) return null; const selected = account(); return selected?.connected() ? selected.credential() : null; },
        fetchSnapshot: credentials => fetcher.fetchXaiSubscriptionUsageSnapshot({ ...credentials, fetchFn: fetchOwned }),
        recordSnapshot: async value => { if (!isCurrent()) return; if (providerId === 'xai') await options.usage.recordXaiSubscriptionUsageSnapshot(value);
          else { snapshot = value; options.usage.broadcastSubscriptionAccountUsage(providerId, value); } },
        clearSnapshot: async () => { if (!isCurrent()) return; if (providerId === 'xai') await options.usage.clearXaiSubscriptionUsageSnapshot();
          else { snapshot = null; options.usage.broadcastSubscriptionAccountUsage(providerId, null); } },
        readCachedSnapshot: () => !isCurrent() ? Promise.resolve(null) : providerId === 'xai' ? options.usage.readXaiSubscriptionUsageSnapshot() : Promise.resolve(snapshot),
        now: Date.now,
        isUnauthorizedError: error => error instanceof fetcher.XaiSubscriptionUsageUnauthorizedError,
        isRateLimitedError: error => error instanceof fetcher.XaiSubscriptionUsageRateLimitedError,
        onRefreshError: () => options.logger.warn('XAI_USAGE_REFRESH_FAILED'),
      });
      xai.set(providerId, reader);
    }
    return reader;
  }
  function isOpenAiSubscriptionProviderId(id?: string | null) {
    return isOpenAiSubscriptionProvider(options.models.catalogRuntime.getActiveCatalog().providers.find(provider => provider.id === (id ?? 'openai')));
  }
  const nativeKind = (id?: string | null) => options.models.catalogRuntime.getActiveCatalog().providers.find(provider => provider.id === id)?.auth.native;
  function isClaudeSubscriptionProviderId(id?: string | null) { return id === 'anthropic' || nativeKind(id) === 'claude'; }
  function isXaiSubscriptionProviderId(id?: string | null) { return id === 'xai' || nativeKind(id) === 'xai'; }
  return { ...gateway, isOpenAiSubscriptionProviderId, isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId,
    onClaudeRateLimitInfo: createClaudeUsageEventRecorder({
      readConnectedAccount: () => isCurrent() ? options.models.nativeClaude?.usageAccount() ?? null : null,
      recordSnapshot: async value => { if (isCurrent()) await options.usage.recordClaudeSubscriptionUsageSnapshot(value); },
    }),
    bindCloudAccount(host: NonNullable<typeof cloud>) { current(); cloud = host; },
    noteGatewayStatus(status: ModelAccessStatus) { if (isCurrent()) quota.noteQuotaCredentialStatus(quota.cloudQuotaOwnerKey(cloud?.auth() ?? guest), status); },
    readClaudeSubscriptionUsage: (id?: string, opts?: { fresh?: boolean }) => !id || id === 'anthropic' ? claude.read(opts) : Promise.resolve(null),
    readCodexAccountUsage: (id?: string, opts?: { fresh?: boolean }) => codexReader(id)(opts),
    readXaiSubscriptionUsage: (id?: string) => xaiReader(id).read(),
    triggerClaudeSubscriptionUsageRefresh(id?: string) { if (!id || id === 'anthropic') claude.triggerRefresh(); },
    triggerCodexAccountUsageRefresh(id?: string) { if (isCurrent()) void codexReader(id)().catch(() => {}); },
    triggerXaiSubscriptionUsageRefresh(id?: string) { if (isCurrent() && options.models.grokAccount(id ?? 'xai')) xaiReader(id).triggerRefresh(); },
    async syncCredentialChanges(providerId?: string) {
      if (!isCurrent()) return;
      if (!providerId || providerId === 'anthropic') await claude.syncForCredentialChange();
      if (providerId && isOpenAiSubscriptionProviderId(providerId)) {
        if (options.models.openAiAccount(providerId)?.connected()) await codexReader(providerId)({ fresh: true });
        else await options.usage.clearCodexAccountUsageSnapshot(providerId);
      }
      if (providerId && isXaiSubscriptionProviderId(providerId)) await xaiReader(providerId).syncForCredentialChange();
      else if (!providerId) for (const reader of xai.values()) await reader.syncForCredentialChange();
    },
    close() { closed = true; abort.abort(); gateway.close(); codex.clear(); xai.clear(); },
  };
}
