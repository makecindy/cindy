import { classifyVisionCapability, isModelVisible } from '@cindy/model-providers';
import { parseTeammateMediaModels, type TeammateMediaCatalog } from '@cindy/maker-shared/teammate-media-models';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getModelVisibilityOverride } from '../maker-host/model-visibility-mirror.js';
import { resolveVisionBackendRoute } from '../maker-host/provider-route.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { listAvailableMediaModels } from '../model-access/mediaModels.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Reuse the execution-owner catalogs; return labels and references only, never connection secrets. */
export async function listTeammateMediaModels(): Promise<TeammateMediaCatalog> {
  const owner = activeOwnerScopeKey();
  const vision = new Map<string, { providerId: string; modelId: string; label: string }>();
  const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
  for (const provider of providers) {
    if (!provider.connected || provider.suspended || provider.modelDiscoveryFailure) continue;
    for (const agent of ['claude-code', 'codex', 'pi'] as const) for (const model of provider.models[agent] ?? []) {
      if (model.mode && model.mode !== 'chat') continue;
      if (!isModelVisible(getModelVisibilityOverride(agent, provider.id, model.id), model.defaultEnabled)) continue;
      if (!resolveVisionBackendRoute(provider.id, model.id, effectiveXdGatewayBaseUrl() || null)) continue;
      const supportsImage = model.supportsImageInput ?? (model.modalities ? model.modalities.input.includes('image') : undefined);
      if (supportsImage === false || (supportsImage === undefined && classifyVisionCapability(model.id) === 'no-vision')) continue;
      const key = JSON.stringify([provider.id, model.id]);
      vision.set(key, { providerId: provider.id, modelId: model.id, label: `${model.name ?? model.id} · ${provider.name}` });
    }
  }
  const [result] = await Promise.allSettled([listAvailableMediaModels(undefined, { skipGateway: !getAppCapabilities().canUseCindyGateway })]);
  const media = result.status === 'fulfilled' ? result.value : [];
  if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
  const rows = (mode: string) => media.filter(model => model.mode === mode).map(model => ({
    providerId: model.providerId, modelId: model.id, label: `${model.name ?? model.id} · ${model.providerId}`,
  }));
  return { vision: [...vision.values()], image: rows('image_generation'), video: rows('video_generation'),
    ...(result.status === 'rejected' ? { unavailable: ['image', 'video'] as Array<'image' | 'video'> } : {}) };
}

export async function validateTeammateMediaModels(value: unknown, previous?: unknown) {
  let parsed;
  try { parsed = parseTeammateMediaModels(value); }
  catch { return throwIpcError('INVALID_PARAMS', 'Invalid media model selection'); }
  if (!parsed) return null;
  const before = parseTeammateMediaModels(previous);
  const available = await listTeammateMediaModels();
  for (const kind of ['vision', 'image', 'video'] as const) {
    if (JSON.stringify(parsed[kind] ?? null) === JSON.stringify(before?.[kind] ?? null)) continue;
    const refs = kind === 'vision' ? [parsed.vision?.primary, parsed.vision?.fallback] : [parsed[kind]];
    for (const ref of refs) if (ref && !available[kind].some(model => model.providerId === ref.providerId && model.modelId === ref.modelId)) {
      throwIpcError('INVALID_PARAMS', 'Selected media model is unavailable on this computer');
    }
  }
  return parsed;
}

