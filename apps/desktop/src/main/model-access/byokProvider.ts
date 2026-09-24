import {
  isByokImageMode,
  BUNDLED_CATALOG,
  nativeModelAgents,
  catalogModelMetadata,
  pickModelMetadata,
  resolveCatalogModelNativeApi,
  resolveModelMetadata,
  applyModelMetadata,
  isOrganizationManagedProvider,
  type AgentKind,
  type CatalogModel,
  type CustomProviderConfig,
  type Provider,
} from '@cindy/model-providers';
import type { ByokConnection } from './byokSync.js';

/** Project trusted directory metadata into the existing routing/catalog shape. No secrets. */
export function buildByokProvider({ provider, credential }: ByokConnection): Provider {
  const inferenceBase = credential.endpoint.replace(/\/+$/, '').replace(/\/v1$/, '');
  const models: Provider['models'] = {};
  const routing: Provider['routing'] = {};
  const agents: AgentKind[] = [];
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    const entries = provider.models.filter(
      (model) => !isByokImageMode(model.mode) && model.agents?.includes(agent),
    );
    if (!entries.length) continue;
    agents.push(agent);
    routing[agent] = {
      // Anthropic SDK appends /v1/messages, while Codex expects a /v1 base.
      upstream: agent === 'codex' ? `${inferenceBase}/v1` : inferenceBase,
      authStrategy: 'api-key-header',
      // Pi consumes per-model piApi; the gateway accepts all declared protocols.
      wireProtocol: agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses',
      ...(agent === 'codex' && provider.imageBinding
        ? {
            supportsImageGeneration: true,
            imageModel: {
              wireModel: provider.imageBinding.wireModel,
              litellmModel: provider.imageBinding.litellmModel,
              supportsEdit: provider.imageBinding.supportsEdit,
            },
          }
        : {}),
    };
    models[agent] = entries.map((model): CatalogModel => {
      const defaults = model.perAgent[agent]!;
      const declaredEfforts = defaults.efforts ?? model.efforts ?? [];
      const efforts =
        agent === 'pi' ? declaredEfforts.filter((effort) => effort !== 'ultra') : declaredEfforts;
      const defaultEffort =
        defaults.defaultEffort !== undefined ? defaults.defaultEffort : model.defaultEffort;
      const price = (value: number | undefined) =>
        value === undefined ? undefined : value * 1_000_000;
      const projected: CatalogModel = {
        id: model.id,
        name: model.name ?? model.id,
        mode: model.mode ?? 'chat',
        ...pickModelMetadata({ nativeApi: model.nativeApi !== undefined ? model.nativeApi
          : resolveCatalogModelNativeApi(BUNDLED_CATALOG.modelRegistry, model.id) }),
        description: model.description,
        group: model.group,
        icon: model.icon,
        sortOrder: model.sortOrder,
        modalities: model.modalities,
        newSessionDefault: model.newSessionDefault,
        contextWindow: defaults.contextWindow ?? model.contextWindow ?? 200_000,
        contextWindowMax: model.contextWindow,
        contextWindowVerified:
          defaults.contextWindow !== undefined || model.contextWindow !== undefined,
        maxOutput: model.maxOutputTokens,
        efforts: [...efforts],
        defaultEffort: defaultEffort && efforts.includes(defaultEffort) ? defaultEffort : null,
        supportsFastMode: defaults.supportsFastMode ?? model.supportsFastMode ?? false,
        defaultEnabled: defaults.defaultEnabled ?? model.defaultEnabled ?? true,
        supportsImageInput: model.modalities?.input.includes('image') ?? false,
        ...(agent === 'pi'
          ? {
              piApi: defaults.wireProtocol,
              route: {
                baseUrl:
                  defaults.wireProtocol === 'anthropic-messages'
                    ? inferenceBase
                    : `${inferenceBase}/v1`,
                wireProtocol:
                  defaults.wireProtocol === 'openai-completions'
                    ? ('openai-chat' as const)
                    : defaults.wireProtocol,
              },
            }
          : {}),
        cost: {
          input: price(model.inputCostPerToken),
          output: price(model.outputCostPerToken),
          cacheRead: price(model.cacheReadInputTokenCost),
          cacheWrite: price(model.cacheCreationInputTokenCost),
        },
      };
      const resolved = applyModelMetadata(projected, resolveModelMetadata(
        BUNDLED_CATALOG.modelRegistry, provider.id, model.id,
        { contextWindow: defaults.contextWindow ?? model.contextWindow,
          maxOutputTokens: model.maxOutputTokens, efforts: defaults.efforts ?? model.efforts,
          defaultEffort: defaults.defaultEffort ?? model.defaultEffort,
          supportsFastMode: defaults.supportsFastMode ?? model.supportsFastMode,
          modalities: model.modalities,
          supportsImageInput: model.modalities ? model.modalities.input.includes('image') : undefined }, undefined, agent,
      ));
      if (agent === 'pi') {
        resolved.efforts = resolved.efforts.filter(effort => effort !== 'ultra');
        if (resolved.defaultEffort && !resolved.efforts.includes(resolved.defaultEffort)) resolved.defaultEffort = null;
      }
      resolved.defaultEnabled = (defaults.defaultEnabled ?? model.defaultEnabled ?? true) &&
        nativeModelAgents({ id: provider.id, routing }, { [agent]: resolved }).includes(agent);
      return resolved;
    });
  }
  const imageModels = provider.models
    .filter((model) => isByokImageMode(model.mode))
    .map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      mode: 'image_generation' as const,
      nativeApi: model.nativeApi,
      description: model.description,
      modalities: model.modalities ?? { input: ['text'], output: ['image'] },
      defaultEnabled: model.defaultEnabled ?? true,
    }));
  return {
    id: provider.id,
    name: provider.name,
    source: 'organization',
    auth: { method: 'managed' },
    access: { kind: 'managed' },
    agents,
    routing,
    models,
    ...(imageModels.length ? { imageModels, imageDefaults: { standard: imageModels[0]!.id } } : {}),
  };
}

/** Ephemeral native-runtime input, never saved into the user's custom Provider table. */
export function byokNativeConfigs(providers: readonly Provider[]): CustomProviderConfig[] {
  return providers
    .filter((provider) => isOrganizationManagedProvider(provider) && provider.agents.includes('pi'))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      auth: { method: 'apiKey' },
      runtimes: {
        pi: {
          baseUrl: provider.routing.pi!.upstream,
          wireProtocol: provider.routing.pi!.wireProtocol,
          models: (provider.models.pi ?? []).map((model) => ({
            id: model.id,
            name: model.name,
            ...catalogModelMetadata(model),
            defaultEnabled: model.defaultEnabled,
            ...(model.cost ? { discoveredCost: model.cost } : {}),
            piApi: model.piApi,
            ...(model.route ? { route: model.route } : {}),
            supportsImageInput: model.supportsImageInput,
            reasoning: model.efforts.length > 0,
            reasoningEfforts: model.efforts.filter((effort) => effort !== 'ultra'),
            reasoningDefaultEffort:
              model.defaultEffort === 'ultra' ? undefined : (model.defaultEffort ?? undefined),
          })),
        },
      },
    }));
}

/** Managed connections win an id collision without mixing a personal endpoint with a member key. */
export function mergeByokNativeConfigs(
  personal: readonly CustomProviderConfig[],
  providers: readonly Provider[],
): CustomProviderConfig[] {
  const managed = byokNativeConfigs(providers);
  // The organization directory owns its ids even while a credential is pending.
  // Falling back to a same-id personal native config would combine the enterprise
  // catalog selection with a personal endpoint or a keyless local runtime.
  const managedIds = new Set(
    providers.filter(isOrganizationManagedProvider).map((provider) => provider.id),
  );
  return [...personal.filter((provider) => !managedIds.has(provider.id)), ...managed];
}
