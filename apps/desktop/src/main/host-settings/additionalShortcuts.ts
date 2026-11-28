import { getAppShortcutStore } from '../app-shortcuts/index.js';
import { APP_SHORTCUT_IDS, getAppShortcutDefinition, isAppShortcutAvailableOnPlatform, type AppShortcutOverrides } from '../../shared/appShortcuts.js';
import { additionalSettingsSchemas, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import { HostSettingsError } from './operations.js';

const ids = () => APP_SHORTCUT_IDS.filter(id => {
  const definition = getAppShortcutDefinition(id);
  return definition.rebindable && !definition.hiddenInSettings && isAppShortcutAvailableOnPlatform(id, process.platform);
});
const disabled = { code: null, ctrl: false, meta: false, alt: false, shift: false };
function project(state: ReturnType<ReturnType<typeof getAppShortcutStore>['inspectHost']>) {
  if (state.status !== 'ready') return state;
  const overrides = (state.value.overrides ?? {}) as AppShortcutOverrides;
  const entries = ids().filter(id => Object.hasOwn(overrides, id)).map(id => ({ id, ...Object.fromEntries(Object.keys(disabled).map(key => [key, (overrides[id] ?? disabled)[key as keyof typeof disabled]])) }));
  additionalSettingsSchemas.shortcuts.parse({ entries });
  return { ...state, value: { entries }, defaults: { entries: [] }, customizedKeys: entries.length ? ['entries'] : [], isCustomized: entries.length > 0,
    choices: { entries: ids().map(id => ({ value: { id, ...(getAppShortcutDefinition(id).getDefaultCombos(process.platform)[0] ?? disabled) }, label: id })) } };
}
export const nativeShortcutSettings = {
  read: () => project(getAppShortcutStore().inspectHost()),
  async commit(change: { set: Record<string, SettingsEditableValue>; clear: string[] }, options: OverrideSettingsCommitOptions) {
    const entries = change.clear.includes('entries') ? [] : additionalSettingsSchemas.shortcuts.parse(change.set).entries;
    if (entries.some(item => !ids().includes(item.id))) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
    const overrides: AppShortcutOverrides = Object.fromEntries(entries.map(({ id, code, ...modifiers }) => [id, code === null ? null : { code, ...modifiers }]));
    return project(await getAppShortcutStore().commitHost(overrides, ids(), options));
  },
};
