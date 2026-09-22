import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  isOpenAiSubscriptionProvider,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';
import { deriveModelsFromProviders, filterChatBridgedCodexProviders } from '@/lib/providerModels';
import type { Effort } from '@/lib/userPreferences.types';
import { isSubscriptionDirectModel } from '../../../shared/subscriptionModels';
import { resolveNewMakerDraftEffort } from './newMakerDraftModelPrefs';

export const sshModelSelectionErrorKeys = {
  'catalog-loading': 'settings.remote.startSession.modelCatalogLoading',
  'catalog-error': 'settings.remote.startSession.modelCatalogFailed',
  'no-route': 'settings.remote.startSession.noCompatibleModel',
  'unsupported-codex-source': 'settings.remote.startSession.unsupportedCodexSource',
} as const;

/** Preserve a local creation failure across the remote-folder dialog callback. */
export class SshModelSelectionError extends Error {
  constructor(readonly reason: keyof typeof sshModelSelectionErrorKeys) {
    super(reason);
    this.name = 'SshModelSelectionError';
  }
}

/** Resolve catalog models within the SSH adapter's implemented routing boundary.
 * Codex uses the remote default login: controller gateway/custom/account routes
 * are not forwarded by maker-host, and thread/start sends the model unchanged.
 * This does not discover remote credentials or prove remote network connectivity. */
export function resolveSshSessionModelSelection(args: {
  providers: ProviderView[];
  loading: boolean;
  loadFailed: boolean;
  agentKind: AgentKind;
  preferred: { model: string; providerId?: string | null; effort: Effort; fastMode: boolean };
  getPresetEffort?: (agent: AgentKind, providerId: string, model: string) => Effort | undefined;
  getPresetFast?: (agent: AgentKind, providerId: string, model: string) => boolean | undefined;
}):
  | { ok: false; reason: keyof typeof sshModelSelectionErrorKeys }
  | { ok: true; model: string; providerId: string; effort: Effort; fastMode: boolean } {
  if (args.loadFailed) return { ok: false, reason: 'catalog-error' };
  if (args.loading) return { ok: false, reason: 'catalog-loading' };
  const { agentKind, preferred } = args;
  // Do not silently move an explicitly selected connection to another account.
  if (agentKind === 'codex' && preferred.providerId && preferred.providerId !== 'openai') {
    return { ok: false, reason: 'unsupported-codex-source' };
  }
  const routeProviders =
    agentKind === 'codex'
      ? args.providers.filter(
          (provider) => provider.id === 'openai' && isOpenAiSubscriptionProvider(provider),
        )
      : args.providers;
  if (agentKind === 'codex' && routeProviders.length === 0) {
    return { ok: false, reason: 'unsupported-codex-source' };
  }
  const providers = filterChatBridgedCodexProviders(
    connectedProvidersForAgent(routeProviders, agentKind),
    agentKind,
    true,
  ).filter((provider) => !provider.modelDiscoveryFailure);
  const models = deriveModelsFromProviders(providers, agentKind, {
    admissionFiltered: true,
  }).filter((model) => !isSubscriptionDirectModel(model.id));
  const model = models.some((candidate) => candidate.id === preferred.model)
    ? preferred.model
    : models[0]?.id;
  if (!model) return { ok: false, reason: 'no-route' };

  // A stale preference may be replaced only while creating a new task. Pin the
  // selected source so runtime defaults cannot return to a local-only account.
  const providerId =
    effectiveSourceIdForModel(providers, preferred.providerId, model, agentKind) ??
    effectiveSourceIdForModel(providers, null, model, agentKind);
  const provider = providers.find((candidate) => candidate.id === providerId);
  const descriptor = provider && getModel(provider, model, agentKind);
  if (!providerId || !descriptor) return { ok: false, reason: 'no-route' };
  return {
    ok: true,
    model,
    providerId,
    effort: resolveNewMakerDraftEffort({
      currentEffort: preferred.effort,
      presetEffort: args.getPresetEffort?.(agentKind, providerId, model),
      efforts: descriptor.efforts,
      defaultEffort: descriptor.defaultEffort,
    }),
    fastMode:
      descriptor.supportsFastMode === true &&
      (args.getPresetFast?.(agentKind, providerId, model) ?? preferred.fastMode),
  };
}
