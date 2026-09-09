import type { AgentKind, ProviderView } from '@cindy/model-providers';

import { extractIpcError } from '@/utils/ipcError';

export interface ModelWindowRecoveryToast {
  message: string;
  actionLabel: string;
  settingsPath: string;
}

type Translate = (key: string, values?: Record<string, string>) => string;

function modelDisplayName(
  provider: ProviderView,
  modelId: string,
  agent: AgentKind | null,
): string {
  const agents = agent ? [agent] : provider.agents;
  for (const candidateAgent of agents) {
    const model = provider.models[candidateAgent]?.find((candidate) => candidate.id === modelId);
    if (model?.name) return model.name;
  }
  return modelId;
}

/** Build the provider-aware recovery path for an unknown target context window. */
export function buildModelWindowRecoveryToast(input: {
  error: unknown;
  providerId: string | null | undefined;
  modelId: string;
  agent: AgentKind | null;
  providers: ProviderView[];
  t: Translate;
}): ModelWindowRecoveryToast | null {
  if (extractIpcError(input.error)?.code !== 'MODEL_WINDOW_TARGET_CONTEXT_UNKNOWN') return null;
  const providerId = input.providerId?.trim();
  if (!providerId) return null;
  const provider = input.providers.find((candidate) => candidate.id === providerId);
  if (!provider) return null;

  const model = modelDisplayName(provider, input.modelId, input.agent);
  const messageKey =
    provider.source === 'user'
      ? 'newChat.chatInput.modelWindowUnknown.custom'
      : 'newChat.chatInput.modelWindowUnknown.builtin';
  const params = new URLSearchParams({
    tab: 'providers',
    connect: provider.id,
    model: input.modelId,
  });
  if (input.agent) params.set('agent', input.agent);

  return {
    message: input.t(messageKey, { model, provider: provider.name }),
    actionLabel: input.t('newChat.chatInput.modelWindowUnknown.openSettings'),
    settingsPath: `/settings?${params.toString()}`,
  };
}
