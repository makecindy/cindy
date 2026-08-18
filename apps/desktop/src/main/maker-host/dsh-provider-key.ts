/** Resolve DSH credentials from the selected user provider without crossing provider boundaries. */
import {
  storedCustomProviderId,
  type AgentKind,
  type Provider,
} from '@cindy/model-providers';

import { providerCredentialTargetsMatch } from '../../shared/providerCredentialTarget.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';

type CustomKeyReader = (providerId: string, agent: AgentKind) => string | null;
type DshCredentialProvider = Pick<Provider, 'id' | 'source' | 'auth' | 'routing'>;

const SAME_ENDPOINT_FALLBACKS: readonly AgentKind[] = ['codex', 'pi', 'claude-code'];

/**
 * A DSH-specific key wins. Older DeepSeek preset rows may reuse a key from another runtime of
 * that same provider only when both runtime endpoints are exactly the same credential target.
 */
export function readDshProviderApiKey(
  provider: DshCredentialProvider,
  readKey: CustomKeyReader = readCustomProviderKey,
): string | null {
  const dshRoute = provider.routing.dsh;
  if (
    provider.source !== 'user' ||
    provider.auth.method !== 'apiKey' ||
    !dshRoute ||
    dshRoute.disabled
  ) {
    return null;
  }

  const storageId = storedCustomProviderId(provider.id);
  const direct = readKey(storageId, 'dsh')?.trim();
  if (direct) return direct;

  for (const agent of SAME_ENDPOINT_FALLBACKS) {
    const route = provider.routing[agent];
    if (
      !route ||
      route.disabled ||
      !providerCredentialTargetsMatch(dshRoute.upstream, route.upstream)
    ) {
      continue;
    }
    const key = readKey(storageId, agent)?.trim();
    if (key) return key;
  }
  return null;
}
