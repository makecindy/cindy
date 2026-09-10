import type { CatalogModel } from './types.js';
import { clampEffortToSupported } from './effortResolution.js';
import type {
  ModelAgent,
  ModelEffort,
  ModelRegistry,
} from './modelAccessBean.js';

/** Product choices, independent of vendor capabilities and user overrides. */
export interface ModelProductDefaults {
  visible?: boolean;
  preferredAgent?: ModelAgent;
  contextWindow?: number;
  effort?: ModelEffort | null;
  fast?: boolean;
  perAgent?: Partial<
    Record<
      ModelAgent,
      Omit<ModelProductDefaults, 'perAgent' | 'preferredAgent'>
    >
  >;
}

export function validModelProductDefaults(
  value: unknown,
  nested = false,
): value is ModelProductDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const agents = ['claude-code', 'codex', 'pi'];
  const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const fields = [
    'visible',
    'contextWindow',
    'effort',
    'fast',
    ...(nested ? [] : ['preferredAgent', 'perAgent']),
  ];
  if (Object.keys(v).some((key) => !fields.includes(key))) return false;
  if (
    ['visible', 'fast'].some(
      (key) => v[key] !== undefined && typeof v[key] !== 'boolean',
    )
  )
    return false;
  if (
    v.contextWindow !== undefined &&
    (!Number.isSafeInteger(v.contextWindow) || (v.contextWindow as number) <= 0)
  )
    return false;
  if (
    v.effort !== undefined &&
    v.effort !== null &&
    !efforts.includes(v.effort as string)
  )
    return false;
  if (
    v.preferredAgent !== undefined &&
    !agents.includes(v.preferredAgent as string)
  )
    return false;
  if (v.perAgent !== undefined) {
    if (
      !v.perAgent ||
      typeof v.perAgent !== 'object' ||
      Array.isArray(v.perAgent)
    )
      return false;
    if (
      Object.entries(v.perAgent).some(
        ([key, item]) =>
          !agents.includes(key) || !validModelProductDefaults(item, true),
      )
    )
      return false;
  }
  return true;
}

export function resolveModelProductDefaults(
  registry: ModelRegistry | undefined,
  providerId: string,
  modelId: string,
  agent: ModelAgent,
): ModelProductDefaults | undefined {
  if (registry?.schemaVersion !== 5) return undefined;
  const id =
    providerId === 'openai'
      ? modelId.replace(/^chatgpt\//, '').replace(/\[1m\]$/, '')
      : providerId === 'xai' && !modelId.startsWith('xai/')
        ? `xai/${modelId}`
        : modelId;
  const entries = registry.models.filter((entry) =>
    entry.routes.some(
      (route) => route.providerId === providerId && route.modelId === id,
    ),
  );
  // Legacy [1m] profiles can share one upstream route. Prefer the exact product identity.
  const exact =
    entries.find(
      (entry) =>
        entry.id === `${providerId}/${modelId.replace(/^chatgpt\//, '')}`,
    ) ?? entries.find((entry) => entry.id === `${providerId}/${id}`);
  const entry = exact ?? (entries.length === 1 ? entries[0] : undefined);
  const defaults = entry?.productDefaults;
  return defaults
    ? { ...defaults, ...defaults.perAgent?.[agent], perAgent: undefined }
    : undefined;
}

/** Applied before personal overrides. Never persists resolved defaults as user choices. */
export function applyModelProductDefaults(
  model: CatalogModel,
  defaults: ModelProductDefaults | undefined,
  revision?: string,
): CatalogModel {
  if (!defaults) return model;
  const capacity = model.contextWindowMax ?? model.contextWindow;
  return {
    ...model,
    ...(defaults.contextWindow !== undefined
      ? {
          contextWindow: Math.min(defaults.contextWindow, capacity),
          contextWindowMax: capacity,
        }
      : {}),
    ...(defaults.visible !== undefined
      ? { defaultEnabled: defaults.visible }
      : {}),
    ...(defaults.effort !== undefined
      ? {
          defaultEffort:
            defaults.effort === null || !model.efforts.length
              ? null
              : (clampEffortToSupported(
                  defaults.effort,
                  model.efforts,
                ) as CatalogModel['defaultEffort']),
        }
      : {}),
    ...(defaults.fast !== undefined
      ? { defaultFast: defaults.fast && model.supportsFastMode === true }
      : {}),
    ...(defaults.preferredAgent !== undefined
      ? { preferredAgent: defaults.preferredAgent }
      : {}),
    catalogDefaults: {
      revision,
      contextWindow: defaults.contextWindow,
      effort: defaults.effort,
      fast: defaults.fast,
      visible: defaults.visible,
    },
  };
}
