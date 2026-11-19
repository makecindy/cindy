/**
 * Plugin engine choices in the renderer (docs/plans/acp-plugin-bridge.md).
 *
 * A plugin engine is not a provider and not one of the built-in Harnesses: the new-task draft
 * keeps it as its own small selection next to the built-in model choice, and a task created
 * from it is stored as `agent_kind = 'acp'` with the engine's `providerId`. Everything that
 * decides what such a task looks like or sends lives here, so the built-in paths stay as they
 * were and callers only branch once.
 */
import {
  PLUGIN_ENGINE_AGENT_KIND,
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineEffort,
  pluginEngineKeyFromProviderId,
  type PluginEngineEffort,
  type PluginEngineModel,
  type PluginEnginePermissionMode,
  type PluginEngineView,
} from '../../shared/pluginEngines';
import type { PermissionMode } from '@/lib/userPreferences.types';

export { PLUGIN_ENGINE_DEFAULT_MODEL };

/** What the new-task draft remembers: which engine, which of its models and its permission mode. */
export interface PluginEngineSelection {
  providerId: string;
  modelId: string;
  /**
   * Kept with the engine choice, apart from the built-in Harness preferences: an engine offers only
   * 'ask' / 'bypassPermissions', and picking one must not rewrite what Claude Code / Codex / Pi use.
   */
  permissionMode?: PluginEnginePermissionMode['id'];
  /** Reasoning level chosen for the engine; kept across models that offer it (like built-in effort). */
  effort?: PluginEngineEffort;
}

/** A draft selection that can be used right now. */
export interface ActivePluginEngine {
  engine: PluginEngineView;
  modelId: string;
  permissionMode: PluginEnginePermissionMode['id'];
  /** The level the task starts with; null = the model has none (or the engine keeps its own). */
  effort: PluginEngineEffort | null;
}

/** One row of an engine's model list; `isDefault` is the 「默认模型」 entry. */
export interface PluginEngineModelRow {
  id: string;
  /** Display name from the engine; absent for the default entry (caller localizes it). */
  name?: string;
  description?: string;
  isDefault: boolean;
  /** Levels the engine offers for this model, low → high; empty = none to choose. */
  efforts: readonly PluginEngineEffort[];
  defaultEffort?: PluginEngineEffort;
}

export function isPluginEngineSelectable(engine: PluginEngineView): boolean {
  // 'unknown' = the plugin never published a status: allowed, the entry process reports failures.
  return engine.availability.state !== 'unavailable';
}

/**
 * The draft's remembered engine, if it can still start a task. A removed or unavailable engine
 * reads as "not selected", so the draft falls back to its built-in model like a removed plugin model.
 */
export function resolveActivePluginEngine(
  engines: readonly PluginEngineView[],
  selection: PluginEngineSelection | null | undefined,
): ActivePluginEngine | null {
  if (!selection || !pluginEngineKeyFromProviderId(selection.providerId)) return null;
  const engine = engines.find((item) => item.providerId === selection.providerId);
  if (!engine || !isPluginEngineSelectable(engine)) return null;
  const known = engine.models.some((model) => model.id === selection.modelId);
  // A model the engine no longer lists falls back to the engine's own default, never to another model.
  const modelId = known ? selection.modelId : PLUGIN_ENGINE_DEFAULT_MODEL;
  return {
    engine,
    modelId,
    permissionMode: pluginEnginePermissionMode(selection.permissionMode, engine),
    effort: resolvePluginEngineEffort(engine, modelId, selection.effort),
  };
}

/**
 * The level a model of this engine runs with: the chosen one when the model offers it, else the
 * model's own default; null when the model offers none (the default entry, or no levels listed).
 */
export function resolvePluginEngineEffort(
  engine: Pick<PluginEngineView, 'models'> | null | undefined,
  modelId: string | null | undefined,
  requested: unknown,
): PluginEngineEffort | null {
  const model = engine?.models.find((item) => item.id === modelId);
  const offered = model?.efforts ?? [];
  if (isPluginEngineEffort(requested) && offered.includes(requested)) return requested;
  return model?.defaultEffort && offered.includes(model.defaultEffort) ? model.defaultEffort : null;
}

/**
 * Rows offered under an engine: its last-seen models, or a single default entry until a task ran.
 * When the current choice is the default but models are known, the default entry stays visible
 * so the current choice is shown and can be picked again.
 */
export function pluginEngineModelRows(
  engine: Pick<PluginEngineView, 'models'>,
  activeModelId?: string | null,
): PluginEngineModelRow[] {
  const models: PluginEngineModelRow[] = engine.models.map((model: PluginEngineModel) => ({
    id: model.id,
    name: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    isDefault: false,
    efforts: model.efforts ?? [],
    ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
  }));
  const defaultRow: PluginEngineModelRow = { id: PLUGIN_ENGINE_DEFAULT_MODEL, isDefault: true, efforts: [] };
  if (models.length === 0) return [defaultRow];
  return activeModelId === PLUGIN_ENGINE_DEFAULT_MODEL ? [defaultRow, ...models] : models;
}

/** Display name of a model of this engine; undefined for the default entry or an unknown id. */
export function pluginEngineModelName(
  engine: Pick<PluginEngineView, 'models'> | null | undefined,
  modelId: string | null | undefined,
): string | undefined {
  if (!engine || !modelId || modelId === PLUGIN_ENGINE_DEFAULT_MODEL) return undefined;
  return engine.models.find((model) => model.id === modelId)?.displayName;
}

/**
 * Cindy's two modes for plugin engines (main's ACP_PERMISSION_MODES), used when a task's engine
 * is no longer listed. The picker localizes them through `newChat.permissionSelector.modes.acp.*`.
 */
export const PLUGIN_ENGINE_FALLBACK_PERMISSION_MODES: readonly PluginEnginePermissionMode[] = [
  { id: 'ask', displayName: 'Ask' },
  { id: 'bypassPermissions', displayName: 'Allow all' },
];

/**
 * The permission mode a plugin engine task uses: the requested one when the engine offers it (its
 * own modes or Cindy's two), else the engine's default. Without the engine (plugin removed) only
 * Full access is kept; anything else asks for each request.
 */
export function pluginEnginePermissionMode(
  mode: PermissionMode | string | null | undefined,
  engine?: Pick<PluginEngineView, 'permissionModes' | 'defaultPermissionMode'> | null,
): PluginEnginePermissionMode['id'] {
  if (engine) {
    const offered = engine.permissionModes.find((option) => option.id === mode);
    return offered ? offered.id : engine.defaultPermissionMode;
  }
  return mode === 'bypassPermissions' ? 'bypassPermissions' : 'ask';
}

/**
 * Engine fields of the session row created for a plugin engine task (local-db sessions:create).
 * Main accepts `agentKind: 'acp'` only with an `acp-plugin:` providerId and without remote fields.
 */
export function pluginEngineSessionCreateFields(selection: ActivePluginEngine): {
  agentKind: typeof PLUGIN_ENGINE_AGENT_KIND;
  providerId: string;
  model: string;
  /** '' = the engine keeps its own level; main keeps a level only if the engine lists it. */
  effort: PluginEngineEffort | '';
} {
  return {
    agentKind: PLUGIN_ENGINE_AGENT_KIND,
    providerId: selection.engine.providerId,
    model: selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL,
    effort: selection.effort ?? '',
  };
}
