import {
  getModel,
  clampEffortToSupported,
  defaultEffortForCapabilities,
  type ProviderView,
} from '@cindy/model-providers';
import { resolveNewMakerDefaultTuple } from './newMakerDefaultTuple.js';
import { resolveNewTaskDefaultRoute } from './draftModelCalibration.js';
import {
  isImDefaultEffort,
  type ImDefaultAgentKind,
  type ImDefaultSettings,
} from './imDefaultSettings.js';

export function usesAutomaticImModel(settings: ImDefaultSettings): boolean {
  return !settings.agents[settings.agentKind].model.trim();
}

/** Shared by personal bots, official hooks and settings. No draft/last-used preference is read. */
export function resolveAutomaticImSettings<T extends ImDefaultSettings>(
  settings: T,
  providers: readonly ProviderView[],
  options: {
    agentKind?: ImDefaultAgentKind;
    providerId?: string | null;
    allowAgent?: (agent: ImDefaultAgentKind) => boolean;
    isModelEnabled?: Parameters<typeof resolveNewMakerDefaultTuple>[0]['isModelEnabled'];
  } = {},
): T | null {
  const agents = (['claude-code', 'codex', 'pi'] as const).filter(
    (agent) =>
      (!options.agentKind || options.agentKind === agent) && (options.allowAgent?.(agent) ?? true),
  );
  const selectedProviders = options.providerId
    ? providers.filter((p) => p.id === options.providerId)
    : providers;
  // Filter both recommendation and fallback; the latter permits catalog-hidden models
  // when an entire provider is hidden, which must not override explicit visibility here.
  const scoped = options.isModelEnabled
    ? selectedProviders.map((provider) => ({
        ...provider,
        models: {
          ...provider.models,
          ...Object.fromEntries(
            agents.map((agent) => [
              agent,
              (provider.models[agent] ?? [])
                .filter((model) => options.isModelEnabled!(agent, provider.id, model))
                .map((model) => ({ ...model, defaultEnabled: true })),
            ]),
          ),
        },
      }))
    : selectedProviders;
  const tuple = resolveNewMakerDefaultTuple({
    providers: scoped,
    providersLoading: false,
    availableAgentsLoaded: true,
    availableAgents: new Set(agents.map((agent) => (agent === 'claude-code' ? 'cc' : agent))),
    isModelEnabled: options.isModelEnabled,
  });
  let route = tuple
    ? {
        agentKind: tuple.vendor === 'cc' ? ('claude-code' as const) : tuple.vendor,
        model: tuple.model,
        providerId: tuple.providerId,
      }
    : null;
  // Custom providers and catalogs without a factory recommendation use the same fallback as new tasks.
  if (!route) {
    for (const agentKind of agents) {
      const candidate = resolveNewTaskDefaultRoute({ providers: scoped, agent: agentKind });
      if (candidate) {
        route = { agentKind, ...candidate };
        break;
      }
    }
  }
  if (!route) return null;
  const provider = scoped.find((p) => p.id === route.providerId)!;
  const model = getModel(provider, route.model, route.agentKind);
  const effort = model?.efforts.length
    ? (clampEffortToSupported(model.defaultEffort, model.efforts) ??
      defaultEffortForCapabilities(model.efforts))
    : null;
  return {
    ...settings,
    agentKind: route.agentKind,
    agents: {
      ...settings.agents,
      [route.agentKind]: {
        model: route.model,
        providerId: route.providerId,
        effort: isImDefaultEffort(effort) ? effort : 'high',
      },
    },
  };
}

/** Automatic defaults depend on the catalog too. A raw settings fingerprint must trigger re-resolution. */
export function resolvedImDefaultFingerprint(
  rawFingerprint: string,
  resolved: ImDefaultSettings,
): string {
  const selected = resolved.agents[resolved.agentKind];
  return JSON.stringify([
    rawFingerprint,
    resolved.agentKind,
    selected.model,
    selected.providerId,
    selected.effort,
  ]);
}
