import { manageAppPreferences } from './preferences.js';
import { isModelVisible } from '@cindy/model-providers';
import type { AppModelsRequest } from '@cindy/mcps';
import type { registerProviderHandlers } from '../maker-ipc/providerHandlers.js';

type Actions = ReturnType<typeof registerProviderHandlers>;
let actions: Actions | undefined;
export function configureModelSettingsActions(value: Actions): void { actions = value; }

/** These are shared domain operations. IPC still performs its sender checks separately. */
export async function manageAppModels(input: AppModelsRequest, assertCurrent: () => Promise<void>) {
  if (!actions) throw new Error('MODEL_SETTINGS_NOT_READY');
  const api = actions;
  await assertCurrent();
  const owner = api.owner();
  const guard = async () => {
    await assertCurrent();
    const current = api.owner();
    if (current.dataOwnerId !== owner.dataOwnerId || current.ownerGeneration !== owner.ownerGeneration)
      throw new Error('OWNER_SCOPE_CHANGED');
  };
  if (input.operation === 'get') {
    const [context, imageInput, price] = await Promise.all([
      api.getContext(input.target), api.getImageInput(input.target), api.getPrice(input.target),
    ]);
    await guard();
    const catalog = await api.list(false);
    await guard();
    const model = catalog.providers.find(provider => provider.id === input.target.providerId)?.models[input.target.agent]?.find(model => model.id === input.target.modelId);
    const override = catalog.modelVisibilityOverrides[`${input.target.agent}:${input.target.providerId}:${input.target.modelId}`];
    return { scope: 'local', target: input.target, context, imageInput, price,
      visibility: { visible: isModelVisible(override, model?.defaultEnabled), customized: override !== undefined, disabled: model?.disabled === true } };

  }
  if (input.operation === 'set') {
    const { target, change } = input;
    await guard();
    let result: unknown;
    switch (change.setting) {
      case 'visible': {
        const catalog = await api.list(false);
        await guard();
        const model = catalog.providers.find(provider => provider.id === target.providerId)?.models[target.agent]?.find(model => model.id === target.modelId);
        if (!model) throw new Error('MODEL_NOT_IN_CATALOG');
        await guard();
        const receipt = await manageAppPreferences('model-visibility', undefined, { target, visible: change.value, defaultEnabled: model.defaultEnabled });
        if (!receipt.modelVisibility || (change.value !== null && receipt.modelVisibility.visible !== change.value)) throw new Error('MODEL_VISIBILITY_NOT_CONFIRMED');
        result = receipt.modelVisibility;
        break;
      }
      case 'contextLimit': result = await api.setContext(target, change.value, owner); break;
      case 'compactionPercent': result = await api.setCompaction(target, change.value, owner); break;
      case 'imageInput': result = await api.setImageInput(target, change.value, owner); break;
      case 'price': result = change.value === null ? await api.resetPrice(target) : await api.setPrice(target, change.value); break;
    }
    await guard();
    return { scope: 'local', target, setting: change.setting, result };
  }
  if (input.operation === 'provider') {
    const change = input.change;
    await guard();
    switch (change.action) {
      case 'rename': case 'remove': case 'restore': await api.presentation({ ...owner, ...change }); break;
      case 'order': await api.order({ ...owner, providerIds: change.providerIds }); break;
      case 'visibility': await api.visibility({ providerId: change.providerId, kind: change.modelIds ? 'model' : 'provider',
        disabled: change.disabled, ...(change.modelIds ? { modelIds: change.modelIds } : {}) }); break;
      case 'resetVisibility': await api.visibility({ providerId: change.providerId, kind: 'reset' }); break;
      case 'rediscover': {
        const result = await api.rediscover(change.providerId);
        await guard();
        if (!result.ok) return { scope: 'local', ...result };
        break;
      }
    }
    await guard();
  }
  const state = await api.list(false);
  await guard();
  const providerId = input.operation === 'list' ? input.providerId
    : 'providerId' in input.change ? input.change.providerId : undefined;
  return { scope: 'local', ...state,
    providers: providerId ? state.providers.filter(provider => provider.id === providerId) : state.providers };
}
