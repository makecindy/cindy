import { isKimiCodingProviderView } from './kimiCodingUsage';
import type { ProviderView } from '@cindy/model-providers';

/**
 * Which subscription usage reader describes a connection, or null when Cindy cannot read
 * its remaining quota. Shared by the model picker, settings and the macOS menu bar.
 */
export function providerWeeklyQuotaSource(
  provider: ProviderView,
): 'codex' | 'claude' | 'xai' | 'kimi' | null {
  if (provider.connected && !provider.suspended && !provider.removed && isKimiCodingProviderView(provider)) return 'kimi';
  if (
    !provider.connected ||
    provider.suspended ||
    provider.openAiAccount?.reconnectRequired ||
    provider.auth?.method !== 'oauth' ||
    (provider.access && provider.access.kind !== 'subscription')
  )
    return null;
  if (provider.id === 'openai' || provider.auth.native === 'codex') return 'codex';
  if (provider.auth.native === 'claude') return 'claude';
  if (provider.auth.native === 'xai') return 'xai';
  // These APIs currently describe only the built-in native account, not any
  // arbitrary same-brand API/OAuth connection a user may add.
  if (provider.source !== 'builtin') return null;
  if (provider.id === 'anthropic') return 'claude';
  if (provider.id === 'xai') return 'xai';
  return null;
}
