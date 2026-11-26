import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readKnownWorkspaces } from './readKnownWorkspaces.js';
import { SettingsReader } from '../maker-host/plugins/settings-reader.js';
import { DEFAULT_DISABLED_PLUGIN_IDS } from '../maker-host/plugins/types.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { additionalSettingsSchemas, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import { HostSettingsError } from './operations.js';
const idFor = (dir: string) => createHash('sha256').update(dir).digest('base64url');
const revisionKey = randomBytes(32);
const revisionFor = (id: string, local: string, global: string) => createHmac('sha256', revisionKey).update(JSON.stringify([id, local, global])).digest('base64url');
function known() { return readKnownWorkspaces().knownWorkspaces.map(dir => ({ dir, id: idFor(dir), label: `${path.basename(dir)} · ${path.basename(path.dirname(dir))}` })); }
const reader = () => new SettingsReader({ userDataPath: ownerScopedUserDataPath(), logger: { warn() {} } });
function project(workspace: ReturnType<typeof known>[number], state: ReturnType<SettingsReader['inspectProjectSettings']>, global: ReturnType<SettingsReader['inspectUserDefaults']>, available: ReturnType<typeof known>) {
  if (state.status !== 'ready') return state;
  if (global.status !== 'ready') return global;
  const root = (state.value.xdtMaker ?? {}) as Record<string, Record<string, { enabled: boolean }>>;
  const overrides = root.builtinTools ?? root.plugins ?? {};
  const globalOverrides = (global.value.builtinTools ?? global.value.plugins ?? {}) as Record<string, { enabled: boolean }>;
  const keys = Object.keys(additionalSettingsSchemas.workspaceTools.shape);
  const defaults = Object.fromEntries(keys.map(key => [key, globalOverrides[key]?.enabled ?? !DEFAULT_DISABLED_PLUGIN_IDS.has(key)]));
  const customizedKeys = keys.filter(key => Object.hasOwn(overrides, key));
  return { status: 'ready' as const, revision: revisionFor(workspace.id, state.revision, global.revision),
    workspaceId: workspace.id, workspaceLabel: workspace.label,
    value: Object.fromEntries(keys.map(key => [key, overrides[key]?.enabled ?? defaults[key]])), defaults,
    customizedKeys, isCustomized: customizedKeys.length > 0,
    choices: { workspaceIds: available.map(workspace => ({ value: workspace.id, label: workspace.label })) } };
}
export const nativeProjectToolSettings = {
  read(id?: string) {
    const available = known();
    const workspace = id ? available.find(item => item.id === id) : available[0];
    if (!workspace) return { status: 'unavailable' as const, revision: null };
    const store = reader();
    return project(workspace, store.inspectProjectSettings(workspace.dir), store.inspectUserDefaults(), available);
  },
  async commit(id: string, change: { set: Record<string, SettingsEditableValue>; clear: string[] }, options: OverrideSettingsCommitOptions) {
    const available = known(), workspace = available.find(item => item.id === id);
    if (!workspace) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
    const store = reader(), global = store.inspectUserDefaults(), before = store.inspectProjectSettings(workspace.dir);
    if (global.status !== 'ready' || before.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    if (options.expectedRevision !== revisionFor(id, before.revision, global.revision)) throw new HostSettingsError('CONFLICT');
    const assertCurrent = () => {
      options.assertCurrent?.();
      if (!known().some(item => item.id === id) || store.inspectUserDefaults().revision !== global.revision) throw new HostSettingsError('CONFLICT');
    };
    const state = await store.commitProjectSettings(workspace.dir, change as { set: Record<string, boolean>; clear: string[] }, { ...options, expectedRevision: before.revision, assertCurrent });
    // Receipt uses captured defaults and the committed result. No fallible reread after persistence.
    const result = project(workspace, state, global, available);
    if (result.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    return result;
  },
};
