import type { ProviderView } from '@cindy/model-providers';
import { isXdOrgUser, type XdOrgIdentity } from '../shared/xdOrg.js';

const XD_CODEX_MODEL_PREFIX = 'byok-openai-codex/';

/** Match the immutable enterprise slug encoded in model IDs, never display names.
 * Auto model groups have a different prefix, so any matching model is sufficient.
 */
export function organizationProviderLogoKind(
  provider: ProviderView,
  user: XdOrgIdentity | null | undefined,
): ProviderView['logoKind'] {
  if (provider.source !== 'organization' || !isXdOrgUser(user)) return undefined;
  return Object.values(provider.models).some(models =>
    models?.some(model => model.id.startsWith(XD_CODEX_MODEL_PREFIX)))
    ? 'openai-spectrum' : undefined;
}
