/**
 * plugin-engine-prefs-store — what the user set for a plugin-provided task engine in
 * Settings → Model providers (docs/dev-rules/protocol-compatibility/plugin-harnesses.md,
 * 「插件引擎进入模型供应商列表」).
 *
 * File: <userData>/owners/<owner>/plugin-engine-prefs.json
 * Shape: { engines: { "<pluginInstance>:<harnessId>": { name?, hidden?, suspended?, disabledModels? } } }
 *
 * - `name`: a display name on this computer; the plugin's declared name is untouched.
 * - `hidden`: left out of model pickers. Presentation only; tasks, automations and remote use go on.
 * - `suspended`: not offered for new work (new tasks, switching onto it, automations, Workers,
 *   other computers, shared friends). The plugin itself stays enabled, its tools and pages too.
 * - `disabledModels`: models of the engine the user turned off.
 * - `modelEfforts`: reasoning defaults explicitly set by this user.
 *
 * Only explicit choices are stored; a missing entry means the engine is listed as its plugin
 * declares it. Entries survive turning the plugin off and on again; an entry whose plugin is gone
 * is inert and bounded by the limits below.
 *
 * This file is separate from the ordinary provider files (model-disable-prefs.json, the provider
 * order and local-codex-provider-prefs.json) on purpose: nothing an ordinary provider reads or
 * writes changes when a plugin engine is renamed, hidden or turned off. The engine's 「允许被远程调用」
 * switch stays where it was (remote-provider-access-store, keyed by the task `providerId`).
 */
import { isPluginEngineEffort, type PluginEnginePrefsInput, type PluginEngineView } from '../../shared/pluginEngines.js';
import { ownerScopedPath as ownerScopedUserDataPath } from '../ownerContext.js';
import { desktopMakerLogger } from './logger-adapter.js';
import { createOverrideSettingsFile } from './override-settings-file.js';

export interface PluginEnginePrefs {
  name?: string;
  hidden?: true;
  suspended?: true;
  disabledModels?: string[];
  modelEfforts?: PluginEngineView['modelEfforts'];
}

export interface PluginEnginePrefsPatch {
  /** A non-empty name sets the display name; null goes back to the plugin's declared name. */
  name?: string | null;
  hidden?: boolean;
  suspended?: boolean;
  /** Turns these models off or on again; other models keep their state. */
  models?: { ids: readonly string[]; disabled: boolean };
  modelEffort?: PluginEnginePrefsInput['modelEffort'];
}

interface PluginEnginePrefsFile {
  engines: Record<string, PluginEnginePrefs>;
}

/** `<pluginInstance>:<harnessId>`; the same bound the remote-use switch accepts. */
export const PLUGIN_ENGINE_PREFS_KEY_MAX = 200;
/** A plugin's declared engine name is at most 64 characters; a display name follows it. */
export const PLUGIN_ENGINE_PREFS_NAME_MAX = 64;
/** Bounds of a published model list (`PUT /harnesses`): 200 models, ids up to 256 characters. */
export const PLUGIN_ENGINE_PREFS_MODELS_MAX = 200;
export const PLUGIN_ENGINE_PREFS_MODEL_ID_MAX = 256;
const MAX_ENGINES = 256;

const EMPTY: PluginEnginePrefs = Object.freeze({});
const log = desktopMakerLogger.child('plugin-engine-prefs-store');
const listeners = new Set<() => void>();

/** A key names one engine of one plugin: a harness id after the last `:`, something before it. */
export function isPluginEnginePrefsKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > PLUGIN_ENGINE_PREFS_KEY_MAX) return false;
  const separator = key.lastIndexOf(':');
  return separator > 0 && separator < key.length - 1;
}

function normalizeName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  return name && name.length <= PLUGIN_ENGINE_PREFS_NAME_MAX ? name : undefined;
}

function normalizeModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || !id || id.length > PLUGIN_ENGINE_PREFS_MODEL_ID_MAX || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= PLUGIN_ENGINE_PREFS_MODELS_MAX) break;
  }
  return ids;
}

function normalizeModelEfforts(raw: unknown): NonNullable<PluginEnginePrefs['modelEfforts']> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw)
    .filter(([id, effort]) => id.trim() && id.length <= PLUGIN_ENGINE_PREFS_MODEL_ID_MAX && isPluginEngineEffort(effort))
    .slice(0, PLUGIN_ENGINE_PREFS_MODELS_MAX));
}

/** Keeps only explicit choices: an entry that says nothing is dropped. */
function normalizeEntry(raw: unknown): PluginEnginePrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const name = normalizeName(value.name);
  const disabledModels = normalizeModels(value.disabledModels);
  const modelEfforts = normalizeModelEfforts(value.modelEfforts);
  const entry: PluginEnginePrefs = {
    ...(name ? { name } : {}),
    ...(value.hidden === true ? { hidden: true as const } : {}),
    ...(value.suspended === true ? { suspended: true as const } : {}),
    ...(disabledModels.length > 0 ? { disabledModels } : {}),
    ...(Object.keys(modelEfforts).length ? { modelEfforts } : {}),
  };
  return Object.keys(entry).length > 0 ? entry : null;
}

function normalize(raw: unknown): PluginEnginePrefsFile {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { engines?: unknown }).engines
    : null;
  const engines: Record<string, PluginEnginePrefs> = {};
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (!isPluginEnginePrefsKey(key)) continue;
      const entry = normalizeEntry(value);
      if (!entry) continue;
      if (Object.keys(engines).length >= MAX_ENGINES) break;
      engines[key] = entry;
    }
  }
  return { engines };
}

const store = createOverrideSettingsFile<PluginEnginePrefsFile>({
  filePath: () => ownerScopedUserDataPath('plugin-engine-prefs.json'),
  defaults: () => ({ engines: {} }),
  normalize,
  log,
  label: 'plugin-engine-prefs',
  maxBytes: 1024 * 1024,
  // A display name is the user's own text: it stays out of the log.
  logLoadedValue: false,
});

/** The user's choices for one engine; an empty object when there are none. */
export function readPluginEnginePrefs(key: string): PluginEnginePrefs {
  if (!key) return EMPTY;
  // Read for every engine each time the engine list is built (IPC and device-link reads): the
  // cached value only, no file access here. A write through updatePluginEnginePrefs refreshes it.
  return store.read().engines[key] ?? EMPTY;
}

/** Called after a change was written (the engine list is published again). */
export function onPluginEnginePrefsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function applyPatch(current: PluginEnginePrefs, patch: PluginEnginePrefsPatch): PluginEnginePrefs | null {
  const next: Record<string, unknown> = { ...current };
  if (patch.name !== undefined) {
    if (patch.name === null) delete next.name;
    else next.name = patch.name;
  }
  if (patch.hidden !== undefined) next.hidden = patch.hidden;
  if (patch.suspended !== undefined) next.suspended = patch.suspended;
  if (patch.models) {
    const disabled = new Set(current.disabledModels ?? []);
    for (const id of patch.models.ids) {
      if (patch.models.disabled) disabled.add(id);
      else disabled.delete(id);
    }
    if (disabled.size > PLUGIN_ENGINE_PREFS_MODELS_MAX) throw new Error('Too many plugin engine models turned off');
    next.disabledModels = [...disabled];
  }
  if (patch.modelEffort) {
    const { id, effort } = patch.modelEffort;
    const entries = new Map(Object.entries(current.modelEfforts ?? {}));
    if (effort === null) entries.delete(id);
    else entries.set(id, effort);
    if (entries.size > PLUGIN_ENGINE_PREFS_MODELS_MAX) throw new Error('Too many saved plugin model levels');
    next.modelEfforts = Object.fromEntries(entries);
  }
  return normalizeEntry(next);
}

/**
 * Writes one engine's choices and returns what is stored afterwards. The caller validates the
 * request (pluginEnginesIpc): this only refuses what would make the file unbounded.
 */
export async function updatePluginEnginePrefs(key: string, patch: PluginEnginePrefsPatch): Promise<PluginEnginePrefs> {
  if (!isPluginEnginePrefsKey(key)) throw new Error('Unknown plugin engine');
  if (typeof patch.name === 'string' && normalizeName(patch.name) === undefined) {
    throw new Error('Invalid plugin engine name');
  }
  let changed = false;
  let value: PluginEnginePrefsFile;
  try {
    // Under the cross-process lock, on the file as it is on disk: two windows changing different
    // engines at the same moment both keep their change.
    value = await store.updateAtomic(({ value: current }) => {
      const before = current.engines[key] ?? null;
      const after = applyPatch(before ?? EMPTY, patch);
      if (JSON.stringify(before) === JSON.stringify(after)) return null;
      if (!before && after && Object.keys(current.engines).length >= MAX_ENGINES) {
        throw new Error('Too many plugin engine settings');
      }
      const engines = { ...current.engines };
      if (after) engines[key] = after;
      else delete engines[key];
      changed = true;
      return { engines };
    });
  } catch (error) {
    log.warn('plugin engine settings write failed', { key, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  if (changed) {
    log.info('plugin engine settings written', { key, fields: Object.keys(patch) });
    for (const listener of listeners) {
      try { listener(); } catch { log.warn('plugin engine settings listener failed'); }
    }
  }
  return value.engines[key] ?? EMPTY;
}

export const __testing = { normalize };
