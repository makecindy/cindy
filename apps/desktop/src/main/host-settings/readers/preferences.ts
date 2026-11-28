import type { HostSettingState } from '../../../shared/hostSettings.js';
import { AGENT_ISLAND_SOUND_EVENTS } from '../../../shared/agentIsland.js';
import type { SettingsSnapshotFieldId } from '../../../shared/settingsReadCatalog.js';
import { inspectAppearanceSettings } from '../../appearance-settings-store.js';
import { inspectDatabaseSizeWarningSettings } from '../../database-size-warning-settings.js';
import { inspectedValue, type ReadonlySettingsInspection, type ReadonlySettingInspection } from '../readTypes.js';

const firstDomains = {
  newTaskDefaults: { harness: 'harness', modelId: 'modelId', providerId: 'providerId', effort: 'effort', fast: 'fast', thinking: 'thinking', worktree: 'worktree', plan: 'planMode' },
  personalization: { customized: 'isCustomized' },
  databaseWarning: { thresholdGiB: 'thresholdGiB', disabled: 'disabled' },
  appearance: { uiFontSize: 'uiSize', codeFontSize: 'codeSize', zoomFactor: 'windowZoom', uiFontCustomized: 'uiFamily', codeFontCustomized: 'codeFamily' },
} as const;
const desktopKeys = [
  'theme', 'locale', 'sidebarPinnedMode', 'sidebarMainMode', 'ghostPanelRestoreMode', 'notificationsEnabled',
  'swallowActivationClick', 'composerSendShortcut', 'webLinkOpenPreference', 'localLinkOpenPreference',
  'streamFadePreference', 'promptRecommendationEnabled', 'messageNavRailEnabled', 'feishuNotificationsEnabled',
  'networkDebugEnabled', 'agentIslandEnabled', 'agentIslandMascotSkin',
] as const;
export const PREFERENCE_SETTINGS_FIELD_IDS = [
  ...Object.entries(firstDomains).flatMap(([domain, mapping]) => Object.keys(mapping).map(key => `${domain}.${key}`)),
  ...desktopKeys.map(key => `desktop.${key}`), 'desktop.themeFamilyIdConfigured', 'desktop.agentIslandDisplayTargetConfigured',
  'desktop.agentIslandSoundSettings.enabled', ...AGENT_ISLAND_SOUND_EVENTS.map(event => `desktop.agentIslandSoundSettings.sounds.${event}`),
] as readonly SettingsSnapshotFieldId[];

type NativeState = HostSettingState<object> | { status: 'migrationPending'; revision: null };
export interface PreferenceSettingsReaders {
  newTaskDefaults: () => NativeState;
  personalization: () => NativeState;
  databaseWarning: typeof inspectDatabaseSizeWarningSettings;
  appearance: typeof inspectAppearanceSettings;
}
const stores: PreferenceSettingsReaders = {
  // New-task defaults and custom instructions live in the app window, out of this synchronous read.
  newTaskDefaults: () => ({ status: 'unavailable', revision: null }), personalization: () => ({ status: 'unavailable', revision: null }),
  databaseWarning: inspectDatabaseSizeWarningSettings, appearance: inspectAppearanceSettings,
};

/** 固定字段映射只拿领域允许的值，不上传revision、profile身份、历史或正文。 */
export function inspectPreferenceSettingsForSnapshot(platform: NodeJS.Platform, readers: PreferenceSettingsReaders = stores): ReadonlySettingsInspection {
  const fields: Record<string, ReadonlySettingInspection> = {};
  for (const domain of Object.keys(firstDomains) as Array<keyof typeof firstDomains>) {
    let state: NativeState;
    try { state = readers[domain](); } catch { state = { status: 'unreadable', revision: null }; }
    for (const [leaf, key] of Object.entries(firstDomains[domain])) {
      const id = `${domain}.${leaf}`;
      if (state.status !== 'ready') { fields[id] = { status: state.status }; continue; }
      const customized = domain === 'personalization' ? state.isCustomized : state.customizedKeys.includes(key);
      const value = domain === 'appearance' && leaf.endsWith('Customized')
        ? customized : (state.value as Record<string, unknown>)[key];
      fields[id] = inspectedValue(id === 'newTaskDefaults.fast' && value === 'ultrafast' ? true : value, customized ? 'override' : 'default');
    }
  }
  // Desktop preferences live in the app window; this synchronous read cannot
  // reach them, so they are reported as on any desktop.
  for (const id of PREFERENCE_SETTINGS_FIELD_IDS.filter(id => id.startsWith('desktop.'))) {
    fields[id] = platform !== 'darwin' && id.startsWith('desktop.agentIsland') ? { status: 'unsupported' } : { status: 'unavailable' };
  }
  return { fields };
}
