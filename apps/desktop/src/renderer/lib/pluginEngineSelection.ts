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
  isPluginEngineOfferedRemotely,
  pluginEngineKeyFromProviderId,
  type PluginEngineEffort,
  type PluginEngineModel,
  type PluginEnginePermissionMode,
  type PluginEngineView,
} from '../../shared/pluginEngines';
import { modelCatalogKey } from '../../shared/controlledModelCatalog';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare';
import { isOrganizationPluginNamespace, parsePluginStoragePart } from '../../shared/pluginIdentity';
import type { PermissionMode } from '@/lib/userPreferences.types';

export { PLUGIN_ENGINE_DEFAULT_MODEL };

/**
 * An engine a picker offers. `deviceId` is set for an engine that belongs to another computer of
 * the same account (opened there for remote use): the agent runs on that computer while the task,
 * its files and its commands stay on this one. The same plugin can be installed on several
 * computers with the same `providerId`, so an engine is identified by both fields.
 */
export interface PluginEngineChoice extends PluginEngineView {
  deviceId?: string;
  /** Display name of that computer; shown next to the engine name. */
  deviceName?: string;
}

/** Identity of a choice inside one picker (rail tab, list block, React key). */
export function pluginEngineChoiceKey(choice: { providerId: string; deviceId?: string | null }): string {
  return choice.deviceId ? `${choice.deviceId}\n${choice.providerId}` : choice.providerId;
}

/** Whether a selection (or rail tab) names this engine: same engine id on the same computer. */
export function isSamePluginEngineChoice(
  a: { providerId: string; deviceId?: string | null } | null | undefined,
  b: { providerId: string; deviceId?: string | null } | null | undefined,
): boolean {
  return !!a && !!b && a.providerId === b.providerId && (a.deviceId ?? null) === (b.deviceId ?? null);
}

/** What the new-task draft remembers: which engine, which of its models and its permission mode. */
export interface PluginEngineSelection {
  providerId: string;
  /** The other computer of this account that has the engine; absent = the computer the task is on. */
  deviceId?: string;
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
  engine: PluginEngineChoice;
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
 * Engines shown in a model picker: engines reported unavailable (for example, plugin installed
 * locally without signing in, or turned off in Settings → Model providers) and engines the user
 * hid there stay out of the picker unless one is already the active choice.
 */
export function visiblePluginEngineChoices<T extends PluginEngineChoice>(
  engines: readonly T[],
  active?: { providerId: string; deviceId?: string | null } | null,
): T[] {
  return engines.filter((engine) =>
    (isPluginEngineSelectable(engine) && engine.hidden !== true) || isSamePluginEngineChoice(active, engine));
}

function parseHarnessIdentity(providerId: string): { storagePart: string; harnessId: string } | null {
  const key = pluginEngineKeyFromProviderId(providerId);
  if (!key) return null;
  const separator = key.lastIndexOf(':');
  if (separator <= 0 || separator >= key.length - 1) return null;
  return { storagePart: key.slice(0, separator), harnessId: key.slice(separator + 1) };
}

/**
 * Whether two engine entries come from the same plugin harness across computers of the same
 * account. Public/root (`foo` / `_root__foo`) and local (`.cindy` / GitHub release `_ns__local__foo`)
 * installs of the same plugin id match; organization-scoped plugins match only the same org.
 */
export function sameInstalledPluginHarness(
  a: Pick<PluginEngineView, 'providerId'>,
  b: Pick<PluginEngineView, 'providerId'>,
): boolean {
  const left = parseHarnessIdentity(a.providerId);
  const right = parseHarnessIdentity(b.providerId);
  if (!left || !right || left.harnessId !== right.harnessId) return false;
  if (left.storagePart === right.storagePart) return true;
  const leftIdentity = parsePluginStoragePart(left.storagePart);
  const rightIdentity = parsePluginStoragePart(right.storagePart);
  if (!leftIdentity || !rightIdentity || leftIdentity.ghostId !== rightIdentity.ghostId) return false;
  if (isOrganizationPluginNamespace(leftIdentity.namespace) || isOrganizationPluginNamespace(rightIdentity.namespace)) {
    return leftIdentity.namespace === rightIdentity.namespace;
  }
  return true;
}

/**
 * The draft's remembered engine, if it can still start a task. A removed or unavailable engine
 * reads as "not selected", so the draft falls back to its built-in model like a removed plugin model.
 */
export function resolveActivePluginEngine(
  engines: readonly PluginEngineChoice[],
  selection: PluginEngineSelection | null | undefined,
): ActivePluginEngine | null {
  if (!selection || !pluginEngineKeyFromProviderId(selection.providerId)) return null;
  // An engine of another computer never falls back to this computer's engine of the same plugin.
  const engine = engines.find((item) => isSamePluginEngineChoice(item, selection));
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
 * Effort for an in-session plugin engine pick: carries over the active effort only when staying on
 * the same plugin engine (and computer); switching to another engine uses the target model's own
 * default level, matching what the picker rows display.
 */
export function resolvePluginEngineSessionSwitchEffort(
  selection: PluginEngineSelection,
  targetEngine: Pick<PluginEngineView, 'models'> | null | undefined,
  currentActive?: { providerId: string; deviceId?: string | null; effort?: unknown } | null,
): PluginEngineEffort | undefined {
  if (selection.effort) return selection.effort;
  const carriedEffort = currentActive && isSamePluginEngineChoice(selection, currentActive)
    ? currentActive.effort
    : undefined;
  return resolvePluginEngineEffort(targetEngine, selection.modelId, carriedEffort) ?? undefined;
}

/**
 * Rows offered under an engine: its last-seen models, or a single default entry until a task ran.
 * When the current choice is the default but models are known, the default entry stays visible
 * so the current choice is shown and can be picked again.
 */
export function pluginEngineModelRows(
  engine: Pick<PluginEngineView, 'models' | 'defaultModelAllowed'>,
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
  if (models.length === 0) return engine.defaultModelAllowed === false ? [] : [defaultRow];
  return activeModelId === PLUGIN_ENGINE_DEFAULT_MODEL && engine.defaultModelAllowed !== false
    ? [defaultRow, ...models]
    : models;
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
 * Main accepts `agentKind: 'acp'` only with an `acp-plugin:` providerId; `agentDeviceId` names the
 * other computer of this account or received provider share that has the engine (never SSH).
 */
export function pluginEngineSessionCreateFields(selection: ActivePluginEngine): {
  agentKind: typeof PLUGIN_ENGINE_AGENT_KIND;
  providerId: string;
  model: string;
  /** '' = the engine keeps its own level; main keeps a level only if the engine lists it. */
  effort: PluginEngineEffort | '';
  agentDeviceId?: string;
} {
  return {
    agentKind: PLUGIN_ENGINE_AGENT_KIND,
    providerId: selection.engine.providerId,
    model: selection.modelId || PLUGIN_ENGINE_DEFAULT_MODEL,
    effort: selection.effort ?? '',
    ...(selection.engine.deviceId ? { agentDeviceId: selection.engine.deviceId } : {}),
  };
}

/**
 * A computer or received share whose engines a picker offers. `catalogueKey` is where its engine
 * list is cached when that differs from `deviceId` (read through the task computer under remote
 * control); the choice still runs on `deviceId`.
 */
export interface PluginEngineSource {
  deviceId: string;
  name?: string | null;
  catalogueKey?: string;
}

/**
 * Under remote control the task computer (`hostDeviceId`) decides where its task's Agent may run,
 * as for built-in models (provider-sharing.md §5.1): its other computers of this account (this one
 * included) and the shares it received. Only shares of a plugin engine are kept; a built-in
 * provider share offers no engine. Engine lists are read through the task computer.
 * Nothing is offered while the task computer has not listed its sources (or cannot).
 */
export function controlledPluginEngineSources(
  hostDeviceId: string | undefined,
  locations: readonly { deviceId: string; name?: string | null; favoriteSource?: { providerId: string } }[] | undefined,
  shareName: (deviceId: string) => string | null | undefined,
): PluginEngineSource[] {
  if (!hostDeviceId || !locations) return [];
  return locations.flatMap((location) => {
    if (location.deviceId === hostDeviceId) return [];
    const share = isProviderShareAgentDeviceId(location.deviceId);
    if (share && !pluginEngineKeyFromProviderId(location.favoriteSource?.providerId)) return [];
    return [{
      deviceId: location.deviceId,
      // Shares read 「来自 X 的分享」 like this computer's own picker; the task computer's label is the fallback.
      name: (share ? shareName(location.deviceId) : null) || location.name || null,
      catalogueKey: modelCatalogKey(location.deviceId, hostDeviceId)!,
    }];
  });
}

/**
 * The engines other computers of this account or received provider shares offer, as picker choices.
 * `catalogues` holds what each computer/share last answered (null = not read yet or unreachable: it
 * offers nothing for now); only engines opened there for remote use and with at least one permitted
 * model are kept. The consumer computer does not need the plugin installed locally.
 */
export function remotePluginEngineChoices(
  devices: readonly PluginEngineSource[],
  catalogues: ReadonlyMap<string, readonly PluginEngineView[] | null>,
  displayName: (deviceId: string, name?: string | null) => string,
  _installedEngines?: readonly Pick<PluginEngineView, 'providerId'>[],
): PluginEngineChoice[] {
  return devices.flatMap((device) =>
    (catalogues.get(device.catalogueKey ?? device.deviceId) ?? [])
      .filter((engine) =>
        !!pluginEngineKeyFromProviderId(engine.providerId)
        && isPluginEngineOfferedRemotely(engine)
        && (engine.models.length > 0 || engine.defaultModelAllowed !== false))
      .map((engine) => {
        const choice: PluginEngineChoice = {
          ...engine, deviceId: device.deviceId, deviceName: displayName(device.deviceId, device.name),
        };
        // Hiding an engine is its owner's choice for the pickers of tasks on that computer; an
        // engine offered to this computer's tasks is listed here either way.
        delete choice.hidden;
        return choice;
      }));
}
