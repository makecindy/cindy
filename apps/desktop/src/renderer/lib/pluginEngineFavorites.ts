/**
 * Plugin engine favorites (pure logic, zero IO).
 *
 * Plugin engine models share the existing `modelFavorites` store (`xdt:modelFavorites:v1`) and
 * Device Link `MODEL_FAVORITES_*` sync channel without changing wire schemas:
 * - `providerId`: `acp-plugin:<ghostId>:<harnessId>` for the task computer, or wrapped with
 *   `agent-device-favorite:` (same-account remote computer) / `provider-share-favorite:` (received share).
 * - `modelId`: the engine's model id, or `'default'` (`PLUGIN_ENGINE_DEFAULT_MODEL`).
 * - `agent`: `PLUGIN_ENGINE_FAVORITE_WIRE_AGENT` (`'cc'`) so older Desktop/Mobile clients parse the
 *   list cleanly and silently hide the unknown `acp-plugin:` provider instead of rejecting the table.
 * - `effort`: optional canonical reasoning effort offered by the model.
 *
 * Resolution checks the full engine list (including `hidden: true` engines, like hidden built-in
 * providers), rejects unavailable engines or models no longer listed, and never deletes stored
 * entries when an engine is temporarily absent.
 */
import {
  agentDeviceFavoriteSource,
  isNonLocalModelFavoriteSource,
  MODEL_FAVORITE_TEXT_MAX_LENGTH,
  parseAgentDeviceFavoriteSource,
  parseProviderShareFavoriteSource,
  PLUGIN_ENGINE_FAVORITE_WIRE_AGENT,
} from '@cindy/device-link';

import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  pluginEngineKeyFromProviderId,
  type PluginEngineEffort,
} from '../../shared/pluginEngines';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';
import type { ModelFavoriteConfig, ModelFavoriteItem } from '@/state/modelFavorites';
import {
  isPluginEngineSelectable,
  isSamePluginEngineChoice,
  pluginEngineChoiceKey,
  pluginEngineModelRows,
  resolvePluginEngineEffort,
  type PluginEngineChoice,
  type PluginEngineModelRow,
  type PluginEngineSelection,
} from './pluginEngineSelection';

export interface ResolvedPluginEngineFavorite {
  favorite: ModelFavoriteItem;
  engine: PluginEngineChoice;
  row: PluginEngineModelRow;
  /** Resolved reasoning effort for this favorite copy, or null when the model has no levels. */
  effort: PluginEngineEffort | null;
}

export interface PluginEngineFavoriteEncodeOptions {
  homeDeviceId?: string | null;
  shareFavoriteKeys?: ReadonlyMap<string, { providerId: string; sourceKey: string }>;
  /** True when writing over Device Link (enforces the 512-char wire bound). */
  wireLimit?: boolean;
}

export interface PluginEngineFavoriteResolveOptions {
  homeDeviceId?: string | null;
  sharedFavoriteSources?: ReadonlyMap<string, string>;
  running?: PluginEngineSelection | null;
}

/** Stable flash/animation key for the source model row's ☆ star feedback. */
export function pluginEngineModelFlashKey(
  engine: Pick<PluginEngineChoice, 'providerId' | 'deviceId'>,
  modelId: string,
): string {
  return `plugin-model::${pluginEngineChoiceKey(engine)}::${modelId}`;
}

/** Encodes a plugin engine's storage `providerId` for `modelFavorites`, or null if it cannot be saved. */
export function pluginEngineFavoriteProviderId(
  engine: Pick<PluginEngineChoice, 'providerId' | 'deviceId'>,
  options?: PluginEngineFavoriteEncodeOptions,
): string | null {
  if (!pluginEngineKeyFromProviderId(engine.providerId)) return null;
  const homeDeviceId = options?.homeDeviceId ?? null;
  if (!engine.deviceId || (homeDeviceId && engine.deviceId === homeDeviceId)) {
    if (options?.wireLimit && engine.providerId.length > MODEL_FAVORITE_TEXT_MAX_LENGTH) return null;
    return engine.providerId;
  }
  if (isProviderShareAgentDeviceId(engine.deviceId)) {
    const share = options?.shareFavoriteKeys?.get(engine.deviceId);
    if (!share || share.providerId !== engine.providerId) return null;
    if (options?.wireLimit && share.sourceKey.length > MODEL_FAVORITE_TEXT_MAX_LENGTH) return null;
    return share.sourceKey;
  }
  try {
    return agentDeviceFavoriteSource({ deviceId: engine.deviceId, providerId: engine.providerId });
  } catch {
    return null;
  }
}

/** Builds a wire-compatible `ModelFavoriteConfig` for a plugin engine model (+ optional effort). */
export function pluginEngineFavoriteConfig(
  engine: Pick<PluginEngineChoice, 'providerId' | 'deviceId'>,
  modelId: string,
  effort: PluginEngineEffort | null | undefined,
  options?: PluginEngineFavoriteEncodeOptions,
): ModelFavoriteConfig | null {
  if (!modelId || (options?.wireLimit && modelId.length > MODEL_FAVORITE_TEXT_MAX_LENGTH)) return null;
  const providerId = pluginEngineFavoriteProviderId(engine, options);
  if (!providerId) return null;
  return {
    providerId,
    modelId,
    agent: PLUGIN_ENGINE_FAVORITE_WIRE_AGENT,
    ...(effort ? { effort } : {}),
  };
}

/**
 * Unwraps a stored favorite's `providerId` when it refers to a plugin engine (local, remote
 * computer, or active received share). Returns null for built-in providers or revoked/unknown shares.
 */
function unwrapPluginEngineTarget(
  storedProviderId: string,
  options?: PluginEngineFavoriteResolveOptions,
): { providerId: string; deviceId?: string } | null {
  const shareDeviceId = options?.sharedFavoriteSources?.get(storedProviderId);
  const share = shareDeviceId ? parseProviderShareFavoriteSource(storedProviderId) : null;
  if (share && shareDeviceId) {
    return pluginEngineKeyFromProviderId(share.providerId)
      ? { providerId: share.providerId, deviceId: shareDeviceId }
      : null;
  }
  if (parseProviderShareFavoriteSource(storedProviderId)) return null;
  const remote = parseAgentDeviceFavoriteSource(storedProviderId);
  if (remote) {
    if (isProviderShareAgentDeviceId(remote.deviceId)) return null;
    if (!pluginEngineKeyFromProviderId(remote.providerId)) return null;
    const homeDeviceId = options?.homeDeviceId ?? null;
    return homeDeviceId && remote.deviceId === homeDeviceId
      ? { providerId: remote.providerId }
      : { providerId: remote.providerId, deviceId: remote.deviceId };
  }
  if (isNonLocalModelFavoriteSource(storedProviderId)) return null;
  return pluginEngineKeyFromProviderId(storedProviderId) ? { providerId: storedProviderId } : null;
}

/**
 * Resolves a stored `ModelFavoriteItem` against the available plugin engines.
 * Hidden engines (`hidden: true`) still resolve when selectable; unavailable engines or models no
 * longer offered return null without deleting the stored entry.
 */
export function resolvePluginEngineFavorite(
  item: ModelFavoriteItem,
  engines: readonly PluginEngineChoice[],
  options?: PluginEngineFavoriteResolveOptions,
): ResolvedPluginEngineFavorite | null {
  const target = unwrapPluginEngineTarget(item.providerId, options);
  if (!target) return null;
  const engine = engines.find((candidate) => isSamePluginEngineChoice(candidate, target));
  if (!engine || !isPluginEngineSelectable(engine)) return null;
  const purpose = isSamePluginEngineChoice(options?.running, engine) ? 'session' as const : 'new-task' as const;
  let row: PluginEngineModelRow | undefined;
  if (item.modelId === PLUGIN_ENGINE_DEFAULT_MODEL) {
    if (engine.defaultModelAllowed === false) return null;
    row = { id: PLUGIN_ENGINE_DEFAULT_MODEL, isDefault: true, efforts: [] };
  } else {
    const model = engine.models.find((candidate) => candidate.id === item.modelId);
    if (!model) return null;
    row = pluginEngineModelRows({ models: [model], defaultModelAllowed: false }, null, purpose)[0];
  }
  if (!row) return null;
  const effort = resolvePluginEngineEffort(engine, row.id, item.effort, purpose);
  return { favorite: item, engine, row, effort };
}

/** Whether a resolved plugin engine favorite matches the picker search box. */
export function matchesPluginEngineFavoriteQuery(
  resolved: ResolvedPluginEngineFavorite,
  query: string,
  defaultLabel: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const modelName = resolved.row.isDefault ? defaultLabel : resolved.row.name;
  return [
    resolved.engine.name,
    resolved.engine.deviceName,
    modelName,
    resolved.row.description,
    resolved.row.id,
  ].some((value) => value?.toLowerCase().includes(needle));
}

/** Whether a resolved plugin engine favorite matches the picker's currently active plugin engine selection. */
export function isPluginEngineFavoriteActive(
  resolved: ResolvedPluginEngineFavorite,
  active: PluginEngineSelection | null | undefined,
  running?: PluginEngineSelection | null,
): boolean {
  if (!active || !isSamePluginEngineChoice(active, resolved.engine) || active.modelId !== resolved.row.id) {
    return false;
  }
  const purpose = isSamePluginEngineChoice(running, resolved.engine) ? 'session' as const : 'new-task' as const;
  const activeEffort = resolvePluginEngineEffort(resolved.engine, resolved.row.id, active.effort, purpose);
  return activeEffort === resolved.effort;
}
