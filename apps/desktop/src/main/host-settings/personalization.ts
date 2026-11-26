import { createHmac, randomBytes } from 'node:crypto';
import { isAppSessionBoundaryPending, peekCommittedAppSession } from '../appSessionState.js';
import type { OverrideSettingsCommitOptions, OverrideSettingsMutation } from '../maker-host/override-settings-file.js';
import { manageAppPreferences } from '../app-settings/preferences.js';
import type { PersonalizationSettings, SettingsOwnerStamp, HostSettingState } from '../../shared/hostSettings.js';
import { HostSettingsError } from './operations.js';
import { getInstanceConfig } from '../instance-runtime/config.js';

/**
 * The custom instructions stay in the app window's store, on a cloud
 * instance too. The cloud page and task starts reach them through the preferences section's
 * user-prompt operation.
 */
export function isManagedCloudInstance(): boolean {
  return getInstanceConfig() !== null;
}

/** 仅观察内存中的 owner，不执行旧 app-session 的读取或修复。 */
export function currentSettingsOwner(): SettingsOwnerStamp | null {
  const session = peekCommittedAppSession();
  if (!session || !session.dataOwnerId || isAppSessionBoundaryPending()) return null;
  return { dataOwnerId: session.dataOwnerId, ownerGeneration: session.generation };
}
export function settingsOwnerKey(stamp: SettingsOwnerStamp): string {
  return `${stamp.dataOwnerId ?? 'none'}:${stamp.ownerGeneration}`;
}
export function assertSettingsOwner(stamp: SettingsOwnerStamp): void {
  const current = currentSettingsOwner();
  if (!current || settingsOwnerKey(current) !== settingsOwnerKey(stamp)) throw new HostSettingsError('OWNER_CHANGED');
}

const revisionKey = randomBytes(32);
function state(userPrompt: string): HostSettingState<PersonalizationSettings> & { status: 'ready' } {
  const customizedKeys = userPrompt ? ['userPrompt'] : [];
  return { status: 'ready', revision: createHmac('sha256', revisionKey).update(userPrompt).digest('base64url'), value: { userPrompt },
    defaults: { userPrompt: '' }, customizedKeys, isCustomized: customizedKeys.length > 0 };
}

/** Reads through the app window; a window that does not answer leaves it unreadable. */
export async function readPersonalization(): Promise<HostSettingState<PersonalizationSettings>> {
  if (!isManagedCloudInstance() || !currentSettingsOwner()) return { status: 'unavailable', revision: null };
  try { return state((await manageAppPreferences('user-prompt')).userPrompt ?? ''); }
  catch { return { status: 'unreadable', revision: null }; }
}

/**
 * The instructions a task on this instance starts with. A window that is still loading gets a few
 * more tries; one that never answers stops the start rather than using the controller's copy.
 */
export async function windowUserPrompt(attempts = 3, pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))): Promise<string> {
  const owner = currentSettingsOwner();
  if (!owner) throw new HostSettingsError('OWNER_CHANGED');
  for (let attempt = 1; ; attempt += 1) {
    assertSettingsOwner(owner);
    let userPrompt: string | undefined;
    try {
      ({ userPrompt } = await manageAppPreferences('user-prompt'));
    } catch { /* retried below */ }
    assertSettingsOwner(owner);
    if (typeof userPrompt === 'string') return userPrompt;
    if (attempt >= attempts) throw new HostSettingsError('UNREADABLE');
    await pause(1000);
  }
}

export async function commitPersonalization(mutation: OverrideSettingsMutation<PersonalizationSettings>, options: OverrideSettingsCommitOptions = {}) {
  if (!isManagedCloudInstance()) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
  const owner = currentSettingsOwner();
  if (!owner) throw new HostSettingsError('OWNER_CHANGED');
  const assertCurrent = () => { assertSettingsOwner(owner); options.assertCurrent?.(); };
  const before = await readPersonalization();
  assertCurrent();
  if (before.status !== 'ready') throw new HostSettingsError('UNREADABLE');
  if (options.expectedRevision !== undefined && before.revision !== options.expectedRevision) throw new HostSettingsError('CONFLICT');
  const next = mutation.clear?.includes('userPrompt') ? '' : mutation.set?.userPrompt ?? before.value.userPrompt;
  if (typeof next !== 'string' || next.length > 8000) throw new HostSettingsError('INVALID_PARAMS');
  let saved: string | undefined;
  try { saved = (await manageAppPreferences('user-prompt', undefined, undefined, { userPrompt: next })).userPrompt; }
  catch { throw new HostSettingsError('SAVE_FAILED'); }
  assertCurrent();
  if (saved !== next) throw new HostSettingsError('SAVE_FAILED');
  return state(saved);
}
