import type { AgentKind, ProviderView } from '@cindy/model-providers';
import type { ModelPriceOverrideTarget } from './modelPriceOverride.js';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
const VALID_AGENTS = ['claude-code', 'codex', 'pi'];
const MAX_DISABLE_ID_LENGTH = 256;
export function createModelPreferenceTargets(deps: {listProviders(options: {allowSideEffects: false}): Promise<ProviderView[]>}) {
  const parsePriceTarget = (value: unknown): ModelPriceOverrideTarget => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throwIpcError('INVALID_PARAMS', 'price override target must be an object');
    }
    const target = value as Record<string, unknown>;
    if (
      typeof target.providerId !== 'string' ||
      target.providerId.length === 0 ||
      target.providerId.length > MAX_DISABLE_ID_LENGTH ||
      !VALID_AGENTS.includes(String(target.agent)) ||
      typeof target.modelId !== 'string' ||
      target.modelId.length === 0 ||
      target.modelId.length > MAX_DISABLE_ID_LENGTH
    ) {
      throwIpcError('INVALID_PARAMS', 'invalid price override target');
    }
    return {
      providerId: target.providerId,
      agent: target.agent as AgentKind,
      modelId: target.modelId,
    };
  };
  const requirePriceTargetModel = async (
    target: ModelPriceOverrideTarget,
  ): Promise<ProviderView> => {
    const provider = (await deps.listProviders({ allowSideEffects: false })).find(
      (candidate) => candidate.id === target.providerId,
    );
    const known = provider?.models[target.agent]?.some((model) => model.id === target.modelId);
    if (!provider || !known) {
      throwIpcError('INVALID_PARAMS', 'price override target is not in the active catalog');
    }
    return provider;
  };
return {parsePriceTarget, requirePriceTargetModel};
}
export function createModelPreferenceQueue() {
  let priceMutationTail: Promise<unknown> = Promise.resolve();
  const enqueuePriceMutation = <T>(run: () => T | Promise<T>): Promise<T> => {
    const result = priceMutationTail.catch(() => undefined).then(run);
    priceMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

return enqueuePriceMutation;
}
