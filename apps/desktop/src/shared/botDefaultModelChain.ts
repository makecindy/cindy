import { effectiveSourceIdForModel } from '@cindy/model-providers';
import type { resolveNewMakerDefaultTuples } from './newMakerDefaultTuple.js';
import type { BotModelRoute } from './botModelChain.js';

/** Adapt the client's ordered defaults to Bot routes without another selection policy. */
export function defaultBotModelChain(
  args: Parameters<typeof resolveNewMakerDefaultTuples>[0] & { preferredRoute?: BotModelRoute | null },
): BotModelRoute[] {
  const preferred = args.preferredRoute;
  if (preferred && !args.providersLoading && args.availableAgentsLoaded) {
    const agent = preferred.harness === 'claude' ? 'claude-code' : preferred.harness;
    const vendor = agent === 'claude-code' ? 'cc' : agent;
    if (!args.availableAgents.has(vendor)) return [];
    // Legacy drafts may leave the source implicit. Resolve only the selected
    // model through the ordinary task resolver, after applying user availability.
    const providers = args.providers.filter(p => p.connected && !p.suspended && !p.modelDiscoveryFailure)
      .map(p => ({ ...p, models: { ...p.models, [agent]: (p.models[agent] ?? []).filter(m =>
        args.isModelEnabled?.(agent, p.id, m) ?? m.defaultEnabled !== false) } }));
    const providerId = effectiveSourceIdForModel(providers, preferred.providerId, preferred.model, agent);
    if (providerId) {
      // A selected app default is not consent to add factory fallback models.
      return [{ ...preferred, providerId }];
    }
  }
  // Missing, stale or unavailable Cindy defaults are not permission to choose a replacement.
  return [];
}
