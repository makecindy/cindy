/** Owner-scoped, in-memory ACP discovery; no invented models, account credentials, or disk cache. */
import { cursorDefaultModel, type ModelDescriptor } from '@cindy/maker-core';
import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';
import { activeOwnerScopeKey } from '../appSessionState.js';

let snapshot: { owner: string; models: ModelDescriptor[] } | null = null;
export function setCursorDiscoveredModels(models: ModelDescriptor[], owner: string): void {
  if (activeOwnerScopeKey() !== owner) return;
  snapshot = { owner, models };
}
export function clearCursorDiscoveredModels(): void { snapshot = null; }
export function getCursorDiscoveredModel(modelId: string): ModelDescriptor | undefined {
  return snapshot?.owner === activeOwnerScopeKey() ? snapshot.models.find(model => model.id === modelId) : undefined;
}
export function hasCursorDiscoveredModels(): boolean {
  return snapshot?.owner === activeOwnerScopeKey() && snapshot.models.length > 0;
}
export function withCursorDiscoveredModels(catalog: Catalog, options: { includeLegacyDefault?: boolean } = {}): Catalog {
  const models = snapshot?.owner === activeOwnerScopeKey() ? snapshot.models : [];
  // Only admission checks need the old alias. Pickers and settings advertise native membership.
  const offers = options.includeLegacyDefault && models.length ? [...models, cursorDefaultModel] : models;
  const builtin = BUNDLED_CATALOG.providers.find(provider => provider.id === 'cursor');
  const providers = catalog.providers.some(provider => provider.id === 'cursor') || !builtin
    ? catalog.providers : [...catalog.providers, builtin];
  return { ...catalog, providers: providers.map(provider => provider.id !== 'cursor' ? provider : {
    ...provider,
    models: { ...provider.models, cursor: offers.map(model => ({
      id: model.id, name: model.displayName, contextWindow: model.contextWindow,
      efforts: [...model.efforts], defaultEffort: model.defaultEffort,
      ...(model.group !== undefined ? { group: model.group } : {}),
      ...(model.sortOrder !== undefined ? { sortOrder: model.sortOrder } : {}),
      ...(model.defaultEnabled !== undefined ? { defaultEnabled: model.defaultEnabled } : {}),
      ...(model.supportsFastMode !== undefined ? { supportsFastMode: model.supportsFastMode } : {}),
      ...(model.newSessionDefault ? { newSessionDefault: model.newSessionDefault } : {}),
      ...(model.description ? { description: model.description } : {}),
      ...(model.supportsImageInput !== undefined ? { supportsImageInput: model.supportsImageInput } : {}),
    })) },
  }) };
}
