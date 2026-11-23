import { isKimiCodingProviderView } from './kimiCodingUsage';
import { isOpenCodeGoProviderView } from './opencodeGoUsage';
import { isOpenAiSubscriptionProvider, type ProviderView } from '@cindy/model-providers';

/**
 * Which subscription usage reader describes a connection, or null when Cindy cannot read
 * its remaining quota. Shared by the model picker, settings and the macOS menu bar.
 */
export function providerWeeklyQuotaSource(
  provider: ProviderView,
): 'codex' | 'claude' | 'xai' | 'kimi' | 'opencode-go' | null {
  if (provider.connected && !provider.suspended && !provider.removed && isKimiCodingProviderView(provider)) return 'kimi';
  if (provider.connected && !provider.suspended && !provider.removed && isOpenCodeGoProviderView(provider)) return 'opencode-go';
  if (
    !provider.connected ||
    provider.suspended ||
    provider.openAiAccount?.reconnectRequired ||
    provider.auth?.method !== 'oauth' ||
    (provider.access && provider.access.kind !== 'subscription')
  )
    return null;
  // Providers Cindy creates for subscription accounts (`openai-sub-*` / `anthropic-sub-*`) copy
  // the built-in entry without its id or a native marker; `subscriptionPool` identifies them.
  if (isOpenAiSubscriptionProvider(provider)) return 'codex';
  if (provider.auth.native === 'claude' || provider.subscriptionPool === 'anthropic') return 'claude';
  if (provider.auth.native === 'xai') return 'xai';
  // These APIs currently describe only the built-in native account, not any
  // arbitrary same-brand API/OAuth connection a user may add.
  if (provider.source !== 'builtin') return null;
  if (provider.id === 'anthropic') return 'claude';
  if (provider.id === 'xai') return 'xai';
  return null;
}
