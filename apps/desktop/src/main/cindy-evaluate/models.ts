import { isCatalogMediaModelVisible } from '../cindy-brain/mediaDisplayVisibility.js';
import { isModelDisabledWithUniqueLegacyBasename, isProviderDisabled } from '@cindy/model-providers';
import { getAppCapabilities } from '../appCapabilities.js';
import { getXdGatewayModels } from '../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
export function listEvaluationModels(api: 'decisions' | 'rerank', options: { includeHidden?: boolean } = {}) {
  const access = readModelDisableOverrides();
  if (!getAppCapabilities().canUseCindyGateway || isProviderDisabled(access, 'xd')) return [];
  const models = getXdGatewayModels();
  const ids = models.map(model => model.id);
  return models.filter(model => model.mode === (api === 'decisions' ? 'evaluation' : 'rerank')
    && model.availability !== 'requires_payment'
    && (options.includeHidden || isCatalogMediaModelVisible('xd', model.id, model.defaultEnabled))
    && !isModelDisabledWithUniqueLegacyBasename(access, 'xd', model.id, ids))
    .map(model => ({ id: model.id, provider_id: 'xd', name: model.name ?? model.id }));
}
