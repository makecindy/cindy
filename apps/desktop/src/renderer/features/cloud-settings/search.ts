import type { SettingsSearchEntry } from '@/components/settings/settingsSearchTypes';
import {
  CLOUD_SETTINGS_GROUPS,
  type CloudSettingsDomain,
  type CloudSettingsTab,
} from '../../../shared/cloudSettings';
const targetDomain: Record<string, CloudSettingsDomain> = {
  'settings-collaboration': 'collaboration',
  'settings-agent-resource': 'agentResource',
  'settings-search-target-general-git-safety': 'gitSafety',
  'settings-search-target-general-experimental': 'lsp',
  'settings-search-target-personalization-user-prompt': 'personalization',
  'settings-search-target-personalization-memory': 'memory',
  'settings-search-target-personalization-subagents': 'subagentModel',
  'settings-search-target-personalization-auxiliary-models': 'auxiliaryModel',
  'settings-search-target-personalization-terminal-shell': 'terminal',
  'settings-search-target-general-language': 'desktopGeneral',
};
export function cloudSearchEntryAllowed(
  entry: SettingsSearchEntry,
  domains: readonly CloudSettingsDomain[],
  trial: boolean,
): boolean {
  if (!(entry.tab in CLOUD_SETTINGS_GROUPS)) return false;
  // Shares the tips section but only changes the instance's own window.
  if (entry.id === 'settings.promptRecommendation.label') return false;
  if ((entry.fallbackTargetId ?? entry.targetId) === 'settings-search-target-personalization-tips')
    return domains.some((d) => d === 'silentEncryptedRetry' || d === 'chatEmbedding');
  if (entry.tab === 'storage')
    return (
      domains.includes('databaseWarning') &&
      [
        'storage',
        'settings.about.storage.dbSizeWarningThresholdLabel',
        'settings.about.storage.dbSizeWarningDisableLabel',
      ].includes(entry.id)
    );
  if (entry.tab === 'about') {
    if (entry.id === 'settings.about.analyticsLabel') return domains.includes('privacy');
    if (entry.id === 'settings.about.debugLogLabel') return domains.includes('desktopNotifications');
    if (entry.id === 'settings.about.logUpload.crashAutoLabel') return domains.includes('diagnostics');
    return (
      entry.id === 'about' &&
      domains.some((d) => d === 'privacy' || d === 'desktopNotifications' || d === 'diagnostics')
    );
  }
  if (entry.tab === 'computer-use') {
    if (entry.id === 'settings.computerUse.browser.title') return domains.includes('browserTools');
    if (entry.id === 'settings.computerUse.directControl.title')
      return domains.includes('computerTools');
    return (
      entry.id === 'computerUse' &&
      domains.some((d) => d === 'browserTools' || d === 'computerTools')
    );
  }
  if (entry.tab === 'builtin-tools') return domains.includes('builtinTools');
  if (entry.id === 'general' || entry.id === 'personalization')
    return CLOUD_SETTINGS_GROUPS[entry.tab as CloudSettingsTab].some((d) => domains.includes(d));
  const domain = targetDomain[entry.fallbackTargetId ?? entry.targetId];
  // A real instance answers the prompt over its private DeviceLink channel, so the CIS open never
  // lists this domain (client.ts) while the page always shows the section; only the trial reports it.
  if (domain === 'personalization') return !trial || domains.includes(domain);
  return !!domain && domains.includes(domain) && (domain !== 'gitSafety' || trial);
}
