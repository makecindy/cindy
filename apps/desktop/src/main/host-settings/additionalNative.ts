import { nativeProjectToolSettings } from './additionalProjectTools.js';
import { getHostBrowserBackendStore } from '../browser-backend-settings-store.desktop.js';
import { nativeWorkspaceProviderSettings } from './additionalWorkspaceProviders.js';
import { commitHostBrowserBackendKind } from '../mcp-integrations/browser.desktop.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import type { SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import { HostSettingsError } from './operations.js';
import { BUILTIN_THEME_FAMILIES } from '../../shared/themeFamilies.js';
import { LOCAL_THEME_SUFFIX } from '../../shared/local-themes.js';
import { loadLocalThemesSync } from '../local-themes/loader.js';
import { nativeShortcutSettings } from './additionalShortcuts.js';
import { nativePluginSettings } from './additionalPlugins.js';
import { nativeTelegramGroupSettings } from './additionalTelegram.js';
import { nativeHookSettings } from './additionalHooks.js';
import { wecomGroupNotificationService } from '../wecomGroupNotification.js';
import { nativeWorkspaceSettings } from './additionalWorkspaces.js';

type Values = Record<string, SettingsEditableValue>;
/** Assembly of native lifecycle services; no new renderer or remote invoke surface. */
export const nativeSettingsOperations = {
  imWorkspaceProviders: nativeWorkspaceProviderSettings,
  workspaceTools: nativeProjectToolSettings,
  shortcuts: nativeShortcutSettings,
  plugins: nativePluginSettings,
  telegramGroups: nativeTelegramGroupSettings,
  officialHooks: nativeHookSettings,
  imWorkspaces: nativeWorkspaceSettings,
  wecomNotifications: {
    read: () => wecomGroupNotificationService.inspectEnabledPreference(),
    commit: (change: { set: Values; clear: string[] }, options: OverrideSettingsCommitOptions) =>
      wecomGroupNotificationService.commitEnabledPreference(change.clear.includes('enabled') ? null : change.set.enabled === true, options),
  },
  themeChoices() {
    const local = loadLocalThemesSync({ passive: true });
    if (!local.success) throw new HostSettingsError('UNREADABLE');
    const families = [...BUILTIN_THEME_FAMILIES, ...local.themes.map(theme => ({ id: theme.family ? `${theme.family}${LOCAL_THEME_SUFFIX}` : theme.id, name: theme.name }))];
    return families.filter((item, index) => families.findIndex(other => other.id === item.id) === index).map(item => ({ value: item.id, label: item.name }));
  },
  async commit(_domain: 'browserBackend', change: { set: Values; clear: string[] }, options: OverrideSettingsCommitOptions) {
    const store = getHostBrowserBackendStore();
    let receipt: Awaited<ReturnType<typeof store.commitAtomic>> | undefined;
    const assertCurrent = () => {
      options.assertCurrent?.();
      if (!receipt && store.inspect().revision !== options.expectedRevision) throw new HostSettingsError('CONFLICT');
    };
    assertCurrent();
    try {
      const kind = change.clear.includes('kind') ? 'external' : change.set.kind;
      if (kind !== 'external' && kind !== 'rsb-webview') throw new HostSettingsError('INVALID_PARAMS');
      await commitHostBrowserBackendKind(kind, async () => {
        receipt = await store.commitAtomic(change as never, { ...options, assertCurrent });
      });
      if (!receipt) throw new HostSettingsError('CONFLICT');
      options.assertCurrent?.();
      return { ...receipt, applicationFailed: false };
    } catch (error) {
      // The receipt is produced at persistence. Later runtime failures must never
      // invite the caller to retry a write that already happened.
      if (receipt) return { ...receipt, applicationFailed: true };
      throw error;
    }
  },
};
