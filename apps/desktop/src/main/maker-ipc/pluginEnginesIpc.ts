/**
 * IPC for plugin-provided task engines (docs/plans/acp-plugin-bridge.md).
 *
 * The renderer lists engines for the model picker and is told when the list,
 * their availability or their last-seen models change. Since phase 2 (2026-11-19) the
 * list and refresh invokes are also on the device-link allowlist so a phone can pick this
 * computer's engines; the change push stays local (controllers read the list on demand).
 */

import { getDeviceLinkInvokeContext, readDeviceLinkModelSelectionOrigin } from '../device-link/invoke-context.js';
import { hostSessionIdFor } from '../remote-agent/host/sessionIdentity.js';
import type { IpcMainInvokeEvent } from 'electron';
import { ACP_PERMISSION_MODES } from '@cindy/maker-core';
import {
  getPluginHarnessRegistry,
  requestPluginHarnessRefresh,
  readPluginHarnessUsage,
  type PluginHarness,
} from '../cindy-brain/pluginHarnesses.js';
import {
  getCachedPluginHarnessModels,
  getReportedPluginEngineModelDetails,
  onPluginHarnessModelsChanged,
  onReportedPluginEngineModelDetailsChanged,
} from '../maker-host/pluginEngineModelCache.js';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  PLUGIN_ENGINE_NAME_MAX,
  PLUGIN_ENGINES_INVOKE,
  PLUGIN_ENGINES_PUSH,
  pluginEngineProviderId,
  isPluginEngineEffort,
  type PluginEnginePermissionMode,
  type PluginEnginePrefsInput,
  type PluginEngineView,
} from '../../shared/pluginEngines.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';

/**
 * The list the plugin publishes for its engine wins (like a provider's own model list); without
 * one, the models the engine reported the last time a task ran on it.
 */
function engineModels(harness: PluginHarness): PluginEngineView['models'] {
  if (harness.models?.length) {
    return harness.models.map((model) => ({
      id: model.id,
      displayName: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.group ? { group: model.group } : {}),
      ...(model.efforts?.length ? { efforts: [...model.efforts] } : {}),
      ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
    }));
  }
  return getCachedPluginHarnessModels(harness.key).map((model) => ({
    id: model.id,
    displayName: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    ...(model.group ? { group: model.group } : {}),
    ...(model.efforts?.length ? { efforts: [...model.efforts] } : {}),
  }));
}

/** The models a new task on this engine can pick from (published list, else the last-seen one). */
export function pluginEngineModelsOf(harness: PluginHarness): PluginEngineView['models'] {
  return engineModels(harness);
}

/** The engine without what only its own computer's settings page shows. */
function withoutSettingsDetails(view: PluginEngineView): PluginEngineView {
  if (view.declaredName === undefined && view.disabledModels === undefined && view.modelEfforts === undefined
    && view.reportedModelDetails === undefined) return view;
  const offered = { ...view };
  delete offered.declaredName;
  delete offered.disabledModels;
  delete offered.modelEfforts;
  delete offered.reportedModelDetails;
  return offered;
}

/** Names of the agent modes Cindy can show (the renderer localizes them by id). */
const AGENT_MODE_NAMES: Record<NonNullable<PluginHarness['modes']>[number], string> = {
  default: 'Default permissions',
  acceptEdits: 'Auto accept edits',
  auto: 'Auto-review',
  plan: 'Plan mode',
};

function toModeView(mode: (typeof ACP_PERMISSION_MODES)[number]): PluginEnginePermissionMode {
  return {
    id: mode.id as PluginEnginePermissionMode['id'],
    displayName: mode.displayName,
    ...(mode.description ? { description: mode.description } : {}),
  };
}

/**
 * The permission menu of an engine: the agent's own modes the plugin lists, then Cindy's Full
 * access (maker-core acpPermissionModes offers the same once the engine runs); else Cindy's two.
 */
function enginePermissionModes(harness: PluginHarness): Pick<PluginEngineView, 'permissionModes' | 'defaultPermissionMode'> {
  const generic = ACP_PERMISSION_MODES.map(toModeView);
  if (!harness.modes?.length) return { permissionModes: generic, defaultPermissionMode: 'ask' };
  return {
    permissionModes: [
      ...harness.modes.map((id) => ({ id, displayName: AGENT_MODE_NAMES[id] })),
      ...generic.filter((mode) => mode.id === 'bypassPermissions'),
    ],
    defaultPermissionMode: harness.defaultMode ?? harness.modes[0]!,
  };
}

/**
 * 「允许被远程调用」of plugin engines (maker-host/pluginEngineRemoteUse.ts). Supplied by the desktop
 * wiring through registerPluginEnginesIpc instead of imported here: this module is also loaded by
 * the scheduler and Agent tools for the engine list, and must not pull the account-scoped store
 * (and Electron) in with it. Until it is supplied, no engine reads as opened.
 */
export interface PluginEngineRemoteUseAccess {
  read(harness: Pick<PluginHarness, 'key' | 'remoteWorkspace' | 'guestWorkspace'>): NonNullable<PluginEngineView['remoteUse']>;
  set(key: string, enabled: boolean): Promise<NonNullable<PluginEngineView['remoteUse']>>;
  onChange(listener: () => void): () => void;
}
let remoteUseAccess: PluginEngineRemoteUseAccess | null = null;

/** What the user set for one engine in Settings → Model providers (maker-host/plugin-engine-prefs-store.ts). */
export interface PluginEngineSettings {
  name?: string;
  hidden?: true;
  suspended?: true;
  disabledModels?: readonly string[];
  modelEfforts?: PluginEngineView['modelEfforts'];
}

/**
 * The per-account store behind those settings, supplied by the desktop wiring for the same reason
 * as PluginEngineRemoteUseAccess. Until it is supplied every engine reads as the plugin declares it.
 */
export interface PluginEngineSettingsAccess {
  read(key: string): PluginEngineSettings;
  update(key: string, patch: Omit<PluginEnginePrefsInput, 'key'>): Promise<unknown>;
  onChange(listener: () => void): () => void;
}
let settingsAccess: PluginEngineSettingsAccess | null = null;

/**
 * Providers the user took accounts of an engine out into (subscription-account-pools.md
 * 插件引擎的账号), supplied by the desktop wiring for the same reason as the stores above.
 */
export interface PluginEngineAccountProvidersAccess {
  /** The engine's taken-out providers that still hold accounts, with the account they show. */
  list(engineKey: string): Array<{ suffix: string; identity?: string }>;
  onChange(listener: () => void): () => void;
}
let accountProvidersAccess: PluginEngineAccountProvidersAccess | null = null;

/** The user's settings for an engine, for admission (pluginEngineSessionAdmission.ts). */
export function pluginEngineSettingsOf(harness: Pick<PluginHarness, 'key'>): PluginEngineSettings {
  return settingsAccess?.read(harness.key) ?? {};
}

/**
 * One provider of an engine: the engine itself, or a provider taken out of it (`key` =
 * `<engine>~<suffix>`, `declared` = the name Cindy gives it). Models, modes and availability come
 * from the engine; the name, hiding, turning off and model switches from that provider's own settings.
 */
function toView(harness: PluginHarness, key = harness.key, declared = harness.name): PluginEngineView {
  const settings = pluginEngineSettingsOf({ key });
  const listed = engineModels(harness).map(model => {
    const effort = settings.modelEfforts?.[model.id];
    return effort && model.efforts?.includes(effort)
      ? { ...model, defaultEffort: effort, declaredDefaultEffort: model.defaultEffort ?? null }
      : model;
  });
  const off = settings.disabledModels?.length ? new Set(settings.disabledModels) : null;
  const disabledModels = off ? listed.filter((model) => off.has(model.id)) : [];
  return {
    key,
    providerId: pluginEngineProviderId(key),
    ghostId: harness.ghostId,
    harnessId: harness.harnessId,
    name: settings.name ?? declared,
    ...(harness.description ? { description: harness.description } : {}),
    ...(harness.iconDataUrl ? { iconDataUrl: harness.iconDataUrl } : {}),
    // Turned off by the user: reported like an engine its plugin cannot run, which every reader
    // (older phones and computers included) already keeps out of new tasks.
    availability: settings.suspended ? { state: 'unavailable', reason: 'suspended' } : harness.availability,
    ...(harness.reportsUsage ? { reportsUsage: true } : {}),
    models: off ? listed.filter((model) => !off.has(model.id)) : listed,
    ...enginePermissionModes(harness),
    remoteUse: remoteUseAccess?.read(harness) ?? {
      supported: harness.remoteWorkspace === true,
      enabled: false,
      shareSupported: harness.remoteWorkspace === true && harness.guestWorkspace === true,
    },
    ...(off ? { defaultModelAllowed: false } : {}),
    ...(settings.hidden ? { hidden: true as const } : {}),
    ...(settings.suspended ? { suspended: true as const } : {}),
    ...(settings.name ? { declaredName: declared } : {}),
    ...(disabledModels.length > 0 ? { disabledModels } : {}),
    ...(settings.modelEfforts ? { modelEfforts: settings.modelEfforts } : {}),
    ...(harness.accounts ? { accounts: { methods: harness.accounts.methods.map((method) => ({ ...method })) } } : {}),
  };
}

/**
 * A provider taken out of an engine runs that engine on its own accounts, as its own provider: it
 * has its own name, hiding, turning off and model switches (under its own key), independent of the
 * engine's provider. It is not offered to other computers or shared (taking out never widens access).
 */
function separateProviderViews(harness: PluginHarness): PluginEngineView[] {
  if (!harness.accounts?.methods.length || !accountProvidersAccess) return [];
  return accountProvidersAccess.list(harness.key).map(({ suffix, identity }, index) => ({
    ...toView(harness, `${harness.key}~${suffix}`, identity ? `${harness.name} · ${identity}` : `${harness.name} ${index + 2}`),
    accountProviderOf: harness.key,
    remoteUse: { supported: false, enabled: false, shareSupported: false },
  }));
}

export function listPluginEngineViews(): PluginEngineView[] {
  return getPluginHarnessRegistry().list().flatMap((harness) => [toView(harness), ...separateProviderViews(harness)]);
}

/** The live ACP details stay out of shared catalogues and quota refresh triggers. */
function withReportedModelDetails(view: PluginEngineView): PluginEngineView {
  if (view.availability.state === 'unavailable') return view;
  const reportedModelDetails = getReportedPluginEngineModelDetails(view.providerId);
  return reportedModelDetails.length ? { ...view, reportedModelDetails } : view;
}

const PREFS_FIELDS = new Set(['key', 'name', 'hidden', 'suspended', 'models', 'modelEffort', 'ownerStamp']);

/** Shape and size check of a settings change; null = not a valid request. */
function parsePluginEnginePrefsInput(input: unknown): PluginEnginePrefsInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((field) => !PREFS_FIELDS.has(field))) return null;
  if (typeof value.key !== 'string' || !value.key || value.key.length > 200) return null;
  const request: PluginEnginePrefsInput = { key: value.key };
  if (value.name !== undefined) {
    if (value.name !== null && (typeof value.name !== 'string' || !value.name.trim()
      || value.name.trim().length > PLUGIN_ENGINE_NAME_MAX)) return null;
    request.name = value.name === null ? null : value.name.trim();
  }
  if (value.hidden !== undefined) {
    if (typeof value.hidden !== 'boolean') return null;
    request.hidden = value.hidden;
  }
  if (value.suspended !== undefined) {
    if (typeof value.suspended !== 'boolean') return null;
    request.suspended = value.suspended;
  }
  if (value.models !== undefined) {
    const models = value.models as { ids?: unknown; disabled?: unknown } | null;
    if (!models || typeof models !== 'object' || Array.isArray(models) || typeof models.disabled !== 'boolean'
      || !Array.isArray(models.ids) || models.ids.length === 0 || models.ids.length > 200
      || models.ids.some((id) => typeof id !== 'string' || !id || id.length > 256)) return null;
    request.models = { ids: [...new Set(models.ids as string[])], disabled: models.disabled };
  }
  if (value.modelEffort !== undefined) {
    const edit = value.modelEffort as { id?: unknown; effort?: unknown } | null;
    if (!edit || typeof edit !== 'object' || Array.isArray(edit) ||
        typeof edit.id !== 'string' || !edit.id.trim() || edit.id.length > 256 ||
        (edit.effort !== null && !isPluginEngineEffort(edit.effort))) return null;
    request.modelEffort = { id: edit.id, effort: edit.effort };
    if (!isDataOwnerPushStamp(value.ownerStamp)) return null;
  }
  if (Object.keys(request).length === 1) return null;
  if (value.ownerStamp !== undefined) {
    if (!isDataOwnerPushStamp(value.ownerStamp)) return null;
    request.ownerStamp = value.ownerStamp;
  }
  return request;
}

/**
 * Largest plugin icon (data URL characters) sent to a phone or another computer. The DSH and
 * Antigravity icons are ~45 KB as data URLs; anything bigger travels without its icon (the
 * controller shows the generic engine mark) so a picker read stays small on the relay.
 */
export const REMOTE_PLUGIN_ENGINE_ICON_MAX_CHARS = 64 * 1024;
const REMOTE_PLUGIN_ENGINE_TOTAL_ICON_MAX_CHARS = 512 * 1024;

/**
 * The list a phone or another computer reads. Keeps it usable when a device has a large catalogue
 * of plugin artwork, and leaves out what only this computer's settings page shows (the declared
 * name behind a display name, the models the user turned off).
 */
export function remotePluginEngineViews(views: readonly PluginEngineView[]): PluginEngineView[] {
  let remainingIconChars = REMOTE_PLUGIN_ENGINE_TOTAL_ICON_MAX_CHARS;
  return views.map((listed) => {
    const view = withoutSettingsDetails(listed);
    if (!view.iconDataUrl) return view;
    const size = view.iconDataUrl.length;
    if (size <= REMOTE_PLUGIN_ENGINE_ICON_MAX_CHARS && size <= remainingIconChars) {
      remainingIconChars -= size;
      return view;
    }
    const { iconDataUrl: _dropped, ...rest } = view;
    return rest;
  });
}

/**
 * The engines as Agent tools list them (list_available_models / schedule_list_models `pluginEngines`):
 * each engine with its `default` entry first, then the models it reported, and whether it can run now.
 */
export function pluginEngineDescriptors(views: readonly PluginEngineView[] = listPluginEngineViews()): Array<{
  providerId: string;
  name: string;
  available: boolean;
  message?: string;
  models: Array<{ id: string; label: string; efforts?: string[] }>;
}> {
  return views.map((view) => ({
    providerId: view.providerId,
    name: view.name,
    available: view.availability.state !== 'unavailable'
      && (view.defaultModelAllowed !== false || view.models.length > 0),
    ...(view.availability.state === 'unavailable' && view.availability.message
      ? { message: view.availability.message } : {}),
    models: [
      ...(view.defaultModelAllowed === false
        ? [] : [{ id: PLUGIN_ENGINE_DEFAULT_MODEL, label: 'Default (the engine chooses)' }]),
      ...view.models.map((model) => ({
        id: model.id,
        label: model.displayName,
        ...(model.efforts?.length ? { efforts: [...model.efforts] } : {}),
      })),
    ],
  }));
}

export interface RegisterPluginEnginesIpcOpts {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, key?: unknown, extra?: unknown) => unknown): void;
  assertTrusted(event: IpcMainInvokeEvent): void;
  broadcast(channel: string, payload: unknown): void;
  /**
   * True while serving a device-link invoke (a phone or another computer controlling this one). The
   * same-account channels read this computer’s engines or account usage and can request model
   * discovery. They have no sender-dependent side effects.
   */
  isDeviceLinkInvoke?(): boolean;
  /** The per-engine remote-use switch; absent = engines cannot be opened to other computers here. */
  remoteUse?: PluginEngineRemoteUseAccess;
  /** The user's per-engine settings; absent = engines are listed as declared and cannot be changed here. */
  settings?: PluginEngineSettingsAccess;
  /** Providers taken out of engines; absent = only the engines themselves are listed. */
  accountProviders?: PluginEngineAccountProvidersAccess;
  /**
   * The usage of the account a local task of an engine with accounts runs on; null = the task has
   * no account yet (or the engine keeps none). Absent = every read is the engine's original login.
   */
  readTaskUsage?(key: string, sessionId: string, options: { fallbackToOriginal: boolean }): Promise<unknown>;
  isCurrentOwner?(stamp: DataOwnerPushStamp): boolean;
}

const viewListeners = new Set<() => void>();
let activeIpcPublishers = 0;

/**
 * Subscribe to any change in the local plugin engine view list (registry, availability,
 * models, remote-use toggle or Settings prefs). Safe to call before registerPluginEnginesIpc.
 */
export function onPluginEnginesChanged(listener: () => void): () => void {
  viewListeners.add(listener);
  // Before registerPluginEnginesIpc mounts (or in isolated tests), fall back to the registry directly.
  const offRegistry = getPluginHarnessRegistry().onChange(() => {
    if (activeIpcPublishers === 0) listener();
  });
  return () => {
    viewListeners.delete(listener);
    offRegistry();
  };
}

/** Returns a disposer for the change subscriptions. */
export function registerPluginEnginesIpc(opts: RegisterPluginEnginesIpcOpts): () => void {
  activeIpcPublishers += 1;
  const remote = () => opts.isDeviceLinkInvoke?.() === true;
  remoteUseAccess = opts.remoteUse ?? null;
  settingsAccess = opts.settings ?? null;
  accountProvidersAccess = opts.accountProviders ?? null;
  opts.handle(PLUGIN_ENGINES_INVOKE.LIST, (event) => {
    if (remote()) return remotePluginEngineViews(listPluginEngineViews());
    opts.assertTrusted(event);
    return listPluginEngineViews().map(withReportedModelDetails);
  });
  // Picker opened: ask engine plugins to republish their models (cooldown per plugin in the registry).
  opts.handle(PLUGIN_ENGINES_INVOKE.REFRESH, (event, targetGhostId) => {
    if (remote()) {
      requestPluginHarnessRefresh();
      return;
    }
    opts.assertTrusted(event);
    if (targetGhostId !== undefined && (typeof targetGhostId !== 'string' || !targetGhostId)) {
      throwIpcError('INVALID_PARAMS', 'Invalid plugin refresh target');
    }
    requestPluginHarnessRefresh(Date.now(), targetGhostId);
  });
  opts.handle(PLUGIN_ENGINES_INVOKE.USAGE, (event, key, task) => {
    const isRemote = remote();
    if (!isRemote) opts.assertTrusted(event);
    if (typeof key !== 'string') return null;
    // A task of this computer names itself (2026-11-23): its account's usage, not the original
    // login's. A phone or another computer may name a task this computer does not know (its Agent
    // runs elsewhere); that keeps the engine-level read. Older hosts ignore the argument.
    const request = task && typeof task === 'object' ? task as { sessionId?: unknown; hosted?: unknown } : undefined;
    const sessionId = request?.sessionId;
    if (typeof sessionId === 'string' && sessionId && sessionId.length <= 256 && opts.readTaskUsage) {
      const engine = getPluginHarnessRegistry().list().find((item) => item.key === key.replace(/~[a-z0-9]{8}$/, ''));
      if (engine?.accounts?.methods.length) {
        if (request?.hosted === true) {
          const caller = getDeviceLinkInvokeContext();
          if (!isRemote || !caller || readDeviceLinkModelSelectionOrigin() !== 'owner') return null;
          return opts.readTaskUsage(key, hostSessionIdFor(caller.controllerDeviceId, sessionId), { fallbackToOriginal: true });
        }
        return opts.readTaskUsage(key, sessionId, { fallbackToOriginal: isRemote });
      }
    }
    return readPluginHarnessUsage(key, undefined, { reportWorkerFailure: isRemote });
  });
  // Opening this computer to the owner's other computers is decided at this computer only.
  opts.handle(PLUGIN_ENGINES_INVOKE.SET_REMOTE_USE, async (event, input) => {
    if (remote()) throw new Error('Remote use of a plugin engine can only be changed on the computer that has the plugin');
    opts.assertTrusted(event);
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (typeof value.key !== 'string' || !value.key || value.key.length > 200 || typeof value.enabled !== 'boolean') {
      throw new Error('Invalid plugin engine remote use request');
    }
    if (!remoteUseAccess) throw new Error('Remote use of plugin engines is not available here');
    const remoteUse = await remoteUseAccess.set(value.key, value.enabled);
    publish();
    return remoteUse;
  });
  // Renaming, hiding or turning off an engine (or its models) is decided at this computer only.
  opts.handle(PLUGIN_ENGINES_INVOKE.SET_PREFS, async (event, input) => {
    if (remote()) {
      throwIpcError('PERMISSION_DENIED', 'Plugin engine settings can only be changed on the computer that has the plugin');
    }
    opts.assertTrusted(event);
    const request = parsePluginEnginePrefsInput(input);
    if (!request) throwIpcError('INVALID_PARAMS', 'Invalid plugin engine settings request');
    const access = settingsAccess;
    if (!access) throwIpcError('UNSUPPORTED_CAPABILITY', 'Plugin engine settings are not available here');
    const { key, ownerStamp, ...patch } = request;
    if (ownerStamp && !opts.isCurrentOwner?.(ownerStamp)) {
      throwIpcError('PERMISSION_DENIED', 'The account changed while editing the plugin engine');
    }
    // A taken-out provider's settings live under its own key; it lists its engine's models.
    const engineKey = key.replace(/~[a-z0-9]{8}$/, '');
    const harness = getPluginHarnessRegistry().list().find((item) => item.key === engineKey);
    // Setting something needs an engine this computer lists (and models it lists); undoing always
    // works, also for an engine whose plugin was turned off meanwhile.
    const sets = typeof patch.name === 'string' || patch.hidden === true || patch.suspended === true
      || patch.models?.disabled === true || Boolean(patch.modelEffort?.effort);
    if (sets && !harness) throwIpcError('NOT_FOUND', 'The plugin that provides this engine is disabled or removed');
    if (harness && patch.models?.disabled) {
      const listed = new Set(engineModels(harness).map((model) => model.id));
      if (patch.models.ids.some((id) => !listed.has(id))) throwIpcError('INVALID_PARAMS', 'Unknown plugin engine model');
    }
    if (harness && patch.modelEffort?.effort) {
      const { id, effort } = patch.modelEffort;
      if (!engineModels(harness).find(model => model.id === id)?.efforts?.includes(effort)) {
        throwIpcError('INVALID_PARAMS', 'The plugin does not offer this level for the model');
      }
    }
    // The plugin's own name is the default, not a display name to remember.
    if (harness && engineKey === key && patch.name === harness.name) patch.name = null;
    try {
      await access.update(key, patch);
    } catch {
      // The store's own errors can name files of this computer; they stay in main's log.
      throwIpcError('INTERNAL', 'Plugin engine settings could not be saved');
    }
    publish();
    const updated = harness ? listPluginEngineViews().find((view) => view.key === key) : undefined;
    return updated ? withReportedModelDetails(updated) : null;
  });
  let lastWindowPayload = '';
  const publishToWindows = (engines: PluginEngineView[]): void => {
    const views = engines.map(withReportedModelDetails);
    const payload = JSON.stringify(views);
    if (payload === lastWindowPayload) return;
    lastWindowPayload = payload;
    opts.broadcast(PLUGIN_ENGINES_PUSH.CHANGED, views);
  };
  let lastPayload = '';
  const publish = (): void => {
    const engines = listPluginEngineViews();
    const payload = JSON.stringify(engines);
    if (payload === lastPayload) return;
    lastPayload = payload;
    publishToWindows(engines);
    for (const listener of [...viewListeners]) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors from the IPC broadcast.
      }
    }
  };
  const offRegistry = getPluginHarnessRegistry().onChange(publish);
  const offModels = onPluginHarnessModelsChanged(publish);
  const offDetails = onReportedPluginEngineModelDetailsChanged(() => publishToWindows(listPluginEngineViews()));
  const offRemoteUse = remoteUseAccess?.onChange(publish);
  const offSettings = settingsAccess?.onChange(publish);
  const offAccountProviders = accountProvidersAccess?.onChange(publish);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    activeIpcPublishers = Math.max(0, activeIpcPublishers - 1);
    offRegistry();
    offModels();
    offDetails();
    offRemoteUse?.();
    offSettings?.();
    offAccountProviders?.();
    remoteUseAccess = null;
    settingsAccess = null;
    accountProvidersAccess = null;
  };
}
