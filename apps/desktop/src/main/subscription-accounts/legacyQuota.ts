import { DEFAULT_ACCOUNT_USAGE_SCOPE, type SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { providerGroupUsageSnapshot, PROVIDER_GROUP_USAGE_MAX_AGE_MS, type ProviderGroupCodexUsageSnapshot } from '../provider-group/usage.js';
import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage.js';

type PoolUsage = {
  claudeUsage?: ClaudeSubscriptionUsageSnapshot | null;
  codexUsage?: ProviderGroupCodexUsageSnapshot | null;
  codexPlan?: string;
};
type ReadPoolUsage = (provider: SubscriptionProvider, providerId?: string) => Promise<PoolUsage | null | undefined>;

const CREATED_ANTHROPIC_PROVIDER_ID = /^anthropic-sub-[a-f0-9]{8}$/;
const CREATED_OPENAI_PROVIDER_ID = /^openai-sub-[a-f0-9]{8}$/;

function matchSubscriptionProviderId(
  value: unknown,
  provider: SubscriptionProvider,
): string | null {
  if (value === undefined || value === provider) return provider;
  if (typeof value !== 'string') return null;
  const pattern = provider === 'anthropic' ? CREATED_ANTHROPIC_PROVIDER_ID : CREATED_OPENAI_PROVIDER_ID;
  return pattern.test(value) ? value : null;
}

/** Old controllers read these provider-level channels without knowing about account pools.
 * undefined means the existing handler must answer; null is an authoritative empty pool.
 * Default-account cards opt out using an appended argument that older hosts already ignore.
 */
export async function readLegacySubscriptionQuota(
  read: ReadPoolUsage,
  channel: string,
  args: unknown[],
  readSession?: (provider: SubscriptionProvider, nativeSessionId: string) => Promise<PoolUsage | null | undefined>,
): Promise<unknown | undefined> {
  let provider: SubscriptionProvider;
  let providerId: string;
  let scope: unknown;
  if (channel === 'maker:usage:claude-subscription') {
    const matched = matchSubscriptionProviderId(args[0], 'anthropic');
    if (!matched) return undefined;
    provider = 'anthropic';
    providerId = matched;
    scope = args[2];
  } else if (channel === 'maker:usage:account') {
    if (args[0] !== 'codex') return undefined;
    const matched = matchSubscriptionProviderId(args[1], 'openai');
    if (!matched) return undefined;
    provider = 'openai';
    providerId = matched;
    scope = args[2];
  } else if (channel === 'maker:usage:codex-rate-limits') {
    const matched = matchSubscriptionProviderId(args[0], 'openai');
    if (!matched) return undefined;
    provider = 'openai';
    providerId = matched;
    scope = args[1];
  } else return undefined;

  // Built-in default-account cards opt out of pool aggregation; created subscription
  // providers (`anthropic-sub-*` / `openai-sub-*`) have no legacy CLI default slot.
  if (providerId === provider && scope === DEFAULT_ACCOUNT_USAGE_SCOPE) return undefined;

  const sessionId = scope && typeof scope === 'object' && !Array.isArray(scope)
    ? (scope as { subscriptionSessionId?: unknown }).subscriptionSessionId : undefined;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256))
    throw new Error('Invalid subscription session');
  const pool = typeof sessionId === 'string'
    ? await readSession?.(provider, sessionId) : await read(provider, providerId);
  if (pool === undefined) return providerId === provider ? undefined : null;
  if (!pool) return null;
  if (provider === 'anthropic') {
    const usage = providerGroupUsageSnapshot(pool.claudeUsage, Date.now());
    return usage ? { ...usage, providerId,
      subscriptionType: pool.claudeUsage?.subscriptionType,
      planTier: pool.claudeUsage?.planTier,
      planDisplayName: pool.claudeUsage?.planDisplayName,
    } : null;
  }
  const usage = pool.codexUsage;
  if (!usage) return null;
  const buckets = usage.appServerBuckets ?? {};
  // Keep a general bucket at the legacy top level; a model-only bucket must never
  // become another model's quota. Every returned bucket retains its own timestamp.
  const general = buckets.codex ?? buckets.__default__ ?? usage.webSnapshot;
  if (channel === 'maker:usage:codex-rate-limits') {
    const now = Date.now();
    const freshBuckets = Object.fromEntries(Object.entries(buckets).filter(([, bucket]) =>
      bucket.updatedAt !== null && bucket.updatedAt > 0
      && now - bucket.updatedAt <= PROVIDER_GROUP_USAGE_MAX_AGE_MS && bucket.updatedAt - now <= 60_000,
    ));
    if (!Object.keys(freshBuckets).length) return null;
    return {
      providerId,
      account: { email: null, accountId: null, planType: general?.planType ?? pool.codexPlan ?? null },
      rateLimits: freshBuckets.codex ?? freshBuckets.__default__ ?? { primary: null, secondary: null },
      rateLimitsByLimitId: freshBuckets,
      rateLimitResetCredits: null,
      resetOffer: null,
    };
  }
  return {
    ...general,
    planType: general?.planType ?? pool.codexPlan,
    providerId,
    source: 'codex-app-server',
    appServerBuckets: buckets,
    ...(typeof sessionId === 'string' || providerId !== provider ? { nativeAccountPool: true } : {}),
    // Old bridge consumers cannot express model-specific native pool buckets.
    // Unknown lets the execution host select/check the real account; relabeling
    // a native bucket as WHAM could incorrectly exclude a usable bridge model.
    webSnapshot: null,
  };
}
