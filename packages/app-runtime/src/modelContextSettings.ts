import type { AgentKind, Catalog } from '@cindy/model-providers';
import { resolveVerifiedContextWindow } from '@cindy/model-providers/verifiedContextWindow';
import type { createModelContextLimitStore } from './modelContextLimitStore.js';
/** Working budgets and verified capacities retain the original separate meanings. */
export function createConfiguredContextWindowResolver(host: {
  resolveDesktopModelContextProviderId(catalog: Pick<Catalog, 'providers'>, agent: AgentKind, provider: string | null | undefined, model: string): string | null;
  readModelContextLimit: ReturnType<typeof createModelContextLimitStore>['readModelContextLimit'];
}) {
const {resolveDesktopModelContextProviderId, readModelContextLimit} = host;
function resolveConfiguredContextWindow(
  catalog: Pick<Catalog, 'providers'>,
  agent: AgentKind,
  providerId: string | null | undefined,
  modelId: string,
): number | null {
  const source = resolveDesktopModelContextProviderId(catalog, agent, providerId, modelId);
  const budget = source ? readModelContextLimit(agent, source, modelId) : null;
  const verified = resolveVerifiedContextWindow(catalog, agent, source, modelId, budget);
  if (verified !== null) return verified;
  // A saved budget configures the native runtime even if catalog capacity is
  // unknown. It is a working ceiling, not evidence of physical model capacity.
  const rows = catalog.providers.filter(provider => provider.id === source && provider.routing[agent]?.disabled !== true)
    .flatMap(provider => (provider.models[agent] ?? []).filter(model => model.id === modelId));
  return rows.length === 1 && rows[0]!.contextWindowVerified !== true && typeof budget === 'number' && Number.isFinite(budget) && budget > 0
    ? budget : null;
}

return resolveConfiguredContextWindow;
}
