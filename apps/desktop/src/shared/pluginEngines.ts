/**
 * Plugin-provided task engines as the Desktop renderer sees them
 * (docs/plans/acp-plugin-bridge.md). The engines run on the computer that has the plugin; a
 * phone controlling it reads the same list through the LIST invoke on the device-link allowlist.
 */

export const PLUGIN_ENGINE_AGENT_KIND = 'acp' as const;
export const PLUGIN_ENGINE_PROVIDER_PREFIX = 'acp-plugin:';
/** Model value that lets the engine keep its own default (used until it reported its models). */
export const PLUGIN_ENGINE_DEFAULT_MODEL = 'default';

/** A harness-controlled default can resolve to any model, including one the user turned off. */
export function isPluginEngineModelDisabled(model: string, disabledModels?: readonly string[]): boolean {
  return !!disabledModels?.length
    && (model === PLUGIN_ENGINE_DEFAULT_MODEL || disabledModels.includes(model));
}

export const PLUGIN_ENGINES_INVOKE = {
  LIST: 'maker:list-plugin-engines',
  USAGE: 'maker:get-plugin-engine-usage',
  /** Ask engine plugins to republish their models (per-plugin cooldown in main). */
  REFRESH: 'maker:refresh-plugin-engines',
  /**
   * Opens or closes one engine of this computer for the owner's other computers. Local window
   * only: it is not on the device-link allowlist, another computer cannot flip it.
   */
  SET_REMOTE_USE: 'maker:set-plugin-engine-remote-use',
  /**
   * Renames, hides or turns off one engine of this computer, or turns some of its models off
   * (Settings → Model providers). Local window only, like SET_REMOTE_USE.
   */
  SET_PREFS: 'maker:set-plugin-engine-prefs',
} as const;

export const PLUGIN_ENGINES_PUSH = {
  CHANGED: 'maker:plugin-engines-changed',
} as const;

/** Reasoning levels a plugin engine can offer, low → high (Cindy level ids; see plugin-protocol). */
export const PLUGIN_ENGINE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PluginEngineEffort = (typeof PLUGIN_ENGINE_EFFORTS)[number];

export function isPluginEngineEffort(value: unknown): value is PluginEngineEffort {
  return typeof value === 'string' && (PLUGIN_ENGINE_EFFORTS as readonly string[]).includes(value);
}

export interface PluginEngineModel {
  id: string;
  displayName: string;
  description?: string;
  group?: string;
  /** Levels the engine offers for this model, low → high; absent = no selectable level. */
  efforts?: PluginEngineEffort[];
  /** Default for a new task, including the provider's saved override (one of `efforts`). */
  defaultEffort?: PluginEngineEffort;
  /** With an override, the original plugin default. Null means the plugin declared no level. */
  declaredDefaultEffort?: PluginEngineEffort | null;
}

/**
 * Permission modes of a plugin engine: Cindy's generic Ask each time / Full access, or the agent's
 * own modes (named like Cindy's built-in ones) followed by Full access.
 */
export const PLUGIN_ENGINE_PERMISSION_MODE_IDS = ['ask', 'default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'] as const;
export type PluginEnginePermissionModeId = (typeof PLUGIN_ENGINE_PERMISSION_MODE_IDS)[number];

export function isPluginEnginePermissionModeId(value: unknown): value is PluginEnginePermissionModeId {
  return typeof value === 'string' && (PLUGIN_ENGINE_PERMISSION_MODE_IDS as readonly string[]).includes(value);
}

export interface NewTaskPluginEngineSelection {
  providerId: string;
  deviceId?: string;
  modelId: string;
  permissionMode?: PluginEnginePermissionModeId;
  effort?: PluginEngineEffort;
}

export interface PluginEnginePermissionMode {
  id: PluginEnginePermissionModeId;
  displayName: string;
  description?: string;
}

export interface PluginEngineView {
  reportsUsage?: true;
  /** `<pluginInstance>:<harnessId>`. */
  key: string;
  /** Task `providerId` for this engine: `acp-plugin:<key>`. */
  providerId: string;
  ghostId: string;
  harnessId: string;
  /** Localized by the main process. */
  name: string;
  description?: string;
  /** The providing plugin's icon as a data URL; absent = the generic engine mark. */
  iconDataUrl?: string;
  availability: {
    state: 'available' | 'unavailable' | 'unknown';
    reason?: string;
    /** Plugin-provided hint, e.g. how to install the CLI. */
    message?: string;
    version?: string;
  };
  /** Models the agent offered the last time a task ran on it; empty until then. */
  models: PluginEngineModel[];
  /**
   * False when a shared engine's model range restricts models and excludes `default` (for example,
   * the member's allowed model list is `[]` or a specific subset). Prevents pickers and detail views
   * from synthesizing a fallback `default` entry when `models` was filtered to empty.
   */
  defaultModelAllowed?: boolean;
  permissionModes: PluginEnginePermissionMode[];
  /** The mode a new task starts in (the agent's own default mode, else 'ask'). */
  defaultPermissionMode: PluginEnginePermissionModeId;
  /**
   * Use from the owner's other computers (the agent runs on the computer that has the plugin,
   * files and commands stay on the task's computer). `supported`: the plugin offers that mode for
   * this engine; `enabled`: the user opened it on that computer; `shareSupported`: the plugin also
   * isolates sharer-local skills/config (`guestWorkspace`) so this engine can be shared across
   * accounts. Absent on a computer running a Cindy version from before this existed; read it as
   * not offered.
   */
  remoteUse?: { supported: boolean; enabled: boolean; shareSupported?: boolean };
  /**
   * What the user set for this engine on its own computer (Settings → Model providers). All four
   * are absent until the user changes something, and on a Cindy version from before they existed.
   *
   * `hidden`: left out of the model pickers of tasks on that computer; tasks already on it and
   * automations go on. `suspended`: turned off there, so `availability.state` is 'unavailable'
   * and nothing new can start on it (readers that do not know the flag already treat it that way).
   * A model the user turned off is not in `models`. A display name the user gave replaces `name`.
   */
  hidden?: true;
  suspended?: true;
  /** The name the plugin declares, when `name` is the user's own. Not sent to phones or other computers. */
  declaredName?: string;
  /** The models the user turned off, as the engine lists them. Not sent to phones or other computers. */
  disabledModels?: PluginEngineModel[];
  /** Explicit per-model reasoning defaults, for settings on this computer. */
  modelEfforts?: Readonly<Partial<Record<string, PluginEngineEffort>>>;
  /**
   * 2026-11-23 (subscription-account-pools.md 插件引擎的账号): the plugin reports this engine's
   * account; with sign-in methods, Cindy can add accounts to it. Absent on older hosts and plugins.
   */
  accounts?: { methods: Array<{ id: string; label: string; kind: 'browser' | 'secret'; secretLabel?: string }> };
  /**
   * A provider the user took accounts out of this engine into: `key` is `<engine key>~<suffix>`
   * and this names the engine it runs. Absent for the engine itself.
   */
  accountProviderOf?: string;
}

/** One change to an engine's settings; only the fields present are changed. */
export interface PluginEnginePrefsInput {
  /** Account that opened the rename dialog, for the main-process account boundary. */
  ownerStamp?: import('./dataOwnerPush.js').DataOwnerPushStamp;
  /** `<pluginInstance>:<harnessId>`. */
  key: string;
  /** A display name on this computer; null goes back to the name the plugin declares. */
  name?: string | null;
  hidden?: boolean;
  suspended?: boolean;
  /** Turns these models of the engine off or on again. */
  models?: { ids: string[]; disabled: boolean };
  /** A null effort restores the plugin's default for this model. */
  modelEffort?: { id: string; effort: PluginEngineEffort | null };
}

/** Longest display name the user can give an engine (a plugin's declared name has the same bound). */
export const PLUGIN_ENGINE_NAME_MAX = 64;

/** The engine can run a task of another computer of the same account right now. */
export function isPluginEngineOfferedRemotely(view: Pick<PluginEngineView, 'availability' | 'remoteUse'>): boolean {
  return view.remoteUse?.supported === true && view.remoteUse.enabled === true && view.availability.state !== 'unavailable';
}

/**
 * Engines another computer offers to this one, from its `maker:list-plugin-engines` reply.
 * Entries that are malformed or not opened for remote use are dropped; nothing is filled in.
 */
export function parseOfferedPluginEngines(raw: unknown): PluginEngineView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): PluginEngineView[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const view = item as Partial<PluginEngineView>;
    const key = typeof view.key === 'string' ? view.key : '';
    if (!key || view.providerId !== pluginEngineProviderId(key) || !pluginEngineKeyFromProviderId(view.providerId)) return [];
    if (typeof view.name !== 'string' || !view.name || !Array.isArray(view.models)) return [];
    const availability = view.availability;
    if (!availability || typeof availability !== 'object' || typeof availability.state !== 'string') return [];
    const remoteUse = view.remoteUse;
    if (!remoteUse || typeof remoteUse !== 'object') return [];
    const models = view.models.filter((model): model is PluginEngineModel =>
      !!model && typeof model === 'object' && typeof model.id === 'string' && !!model.id && typeof model.displayName === 'string')
      .map((model) => ({
        ...model,
        ...(Array.isArray(model.efforts) ? { efforts: model.efforts.filter(isPluginEngineEffort) } : {}),
      }));
    const permissionModes = Array.isArray(view.permissionModes)
      ? view.permissionModes.filter((mode): mode is PluginEnginePermissionMode =>
        !!mode && typeof mode === 'object' && isPluginEnginePermissionModeId(mode.id) && typeof mode.displayName === 'string')
      : [];
    const offered: PluginEngineView = {
      ...(view as PluginEngineView),
      models,
      ...(typeof view.defaultModelAllowed === 'boolean' ? { defaultModelAllowed: view.defaultModelAllowed } : {}),
      permissionModes,
      defaultPermissionMode: isPluginEnginePermissionModeId(view.defaultPermissionMode) ? view.defaultPermissionMode : 'ask',
      remoteUse: {
        supported: remoteUse.supported === true,
        enabled: remoteUse.enabled === true,
        ...(typeof remoteUse.shareSupported === 'boolean' ? { shareSupported: remoteUse.shareSupported } : {}),
      },
    };
    // The owner's picker and settings choices stay on the owner's computer: an engine that is
    // offered here is listed for this computer's tasks whether or not its owner hid it there.
    delete offered.hidden;
    delete offered.suspended;
    delete offered.declaredName;
    delete offered.disabledModels;
    return isPluginEngineOfferedRemotely(offered) ? [offered] : [];
  });
}

export function pluginEngineProviderId(key: string): string {
  return `${PLUGIN_ENGINE_PROVIDER_PREFIX}${key}`;
}

/** `acp-plugin:<ghostId>:<harnessId>` → `<ghostId>:<harnessId>`, else null. */
export function pluginEngineKeyFromProviderId(providerId: string | null | undefined): string | null {
  if (!providerId || !providerId.startsWith(PLUGIN_ENGINE_PROVIDER_PREFIX)) return null;
  const key = providerId.slice(PLUGIN_ENGINE_PROVIDER_PREFIX.length);
  const separator = key.lastIndexOf(':');
  return separator > 0 && separator < key.length - 1 ? key : null;
}

export function isPluginEngineKind(kind: unknown): kind is typeof PLUGIN_ENGINE_AGENT_KIND {
  return kind === PLUGIN_ENGINE_AGENT_KIND;
}
