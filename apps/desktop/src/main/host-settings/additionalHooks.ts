import { createHmac, randomBytes } from 'node:crypto';
import { getHostHookPreferencesContext } from '../hook-control/ipc.js';
import { DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT, inspectOfficialHookSettings, type SlackHookConfigState } from '../hook-control/store.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { HostSettingsError } from './operations.js';
import { additionalSettingsSchemas, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
const revisionKey = randomBytes(32);
function read() {
  const context = getHostHookPreferencesContext();
  if (!context?.fingerprint) return { status: 'unavailable' as const, revision: null };
  const inspected = inspectOfficialHookSettings(ownerScopedUserDataPath('slack-hook.json'), context.fingerprint, ownerScopedUserDataPath('hook-connections.json'));
  if (inspected.status !== 'ready') return { status: inspected.status === 'unreadable' ? 'unreadable' as const : 'unavailable' as const, revision: null };
  return project(context.store.get(), context.fingerprint);
}
function project(view: SlackHookConfigState, fingerprint: string) {
  const value = { lifecycleAnnouncement: view.lifecycleAnnouncementOverride ?? DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT,
    telegramDefaultWorkspace: view.telegramDefaultWorkspace, xDefaultWorkspace: view.xDefaultWorkspace };
  additionalSettingsSchemas.officialHooks.parse(value);
  const customizedKeys = [...(view.lifecycleAnnouncementOverride !== null ? ['lifecycleAnnouncement'] : []), ...(['telegramDefaultWorkspace', 'xDefaultWorkspace'] as const).filter(key => value[key] !== null)];
  const revision = createHmac('sha256', revisionKey).update(JSON.stringify([fingerprint, value, customizedKeys, view.workspaces])).digest('base64url');
  const directories = Object.keys(view.workspaces).map(value => ({ value, label: value }));
  return { status: 'ready' as const, revision, value, defaults: { lifecycleAnnouncement: DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT, telegramDefaultWorkspace: null, xDefaultWorkspace: null }, customizedKeys, isCustomized: customizedKeys.length > 0,
    choices: { telegramDefaultWorkspace: directories, xDefaultWorkspace: directories } };
}
export const nativeHookSettings = {
  read,
  commit(change: { set: Record<string, SettingsEditableValue>; clear: string[] }, options: OverrideSettingsCommitOptions) {
    options.assertCurrent?.();
    const before = read(); if (before.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    if (before.revision !== options.expectedRevision) throw new HostSettingsError('CONFLICT');
    const context = getHostHookPreferencesContext();
    if (!context?.store.commitPreferences || !context.fingerprint) throw new HostSettingsError('NOT_READY');
    const patch = Object.fromEntries([...change.clear.map(key => [key === 'lifecycleAnnouncement' ? 'lifecycleAnnouncementOverride' : key, null]),
      ...Object.entries(change.set).map(([key, value]) => [key === 'lifecycleAnnouncement' ? 'lifecycleAnnouncementOverride' : key, value])]);
    // All validation and the native rename are synchronous: no owner switch or
    // hook callback can run between the revision check and the one-file commit.
    options.assertCurrent?.();
    // The native writer returns the exact committed view; no fallible disk read
    // is needed to decide whether persistence succeeded.
    const committed = context.store.commitPreferences(patch);
    const result = project(committed, context.fingerprint);
    let applicationFailed = false;
    try { options.assertCurrent?.(); context.refresh(); } catch { applicationFailed = true; }
    return { ...result, applicationFailed };
  },
};
