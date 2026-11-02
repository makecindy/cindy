import { ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

// A refusal is a preference, never an approval receipt or executable authority.
const store = createOverrideSettingsFile<Record<string, string>>({
  filePath: () => ownerScopedUserDataPath('plugin-ui-prompts.json'),
  defaults: {},
  normalize: (raw) =>
    Object.fromEntries(
      Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(
        ([key, value]) => key !== '__proto__' && typeof value === 'string',
      ),
    ),
  log: desktopMakerLogger.child('plugin-ui-prompts'),
  label: 'plugin-ui-prompts',
  preserveUnreadableFile: true,
});
const deferred = new Set<string>();
const key = (instance: string, version: string) =>
  JSON.stringify([ownerScopedUserDataPath('plugin-ui-prompts.json'), instance, version]);
export function pluginUiPromptSuppressed(instance: string, version: string): boolean {
  return deferred.has(key(instance, version)) || pluginUiPromptDeclined(instance, version);
}
export function pluginUiPromptDeclined(instance: string, version: string): boolean {
  store.invalidateIfChanged();
  return store.read()[instance] === version;
}
export function deferPluginUiPrompt(instance: string, version: string): void {
  deferred.add(key(instance, version));
}
export function declinePluginUiPrompt(instance: string, version: string): void {
  store.writePatch({ [instance]: version });
}
