import fs from 'node:fs';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { createLogger } from '../logger.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
let revokeGuest: ((controller: string, reapproved: boolean) => Promise<void>) | undefined;
export function configureStandbyGuestCleanup(cleanup: (controller: string, reapproved: boolean) => Promise<void>): void { revokeGuest = cleanup; }
interface Member { joinedAt: number; pendingCleanup?: boolean }
const filePath = () => ownerScopedUserDataPath('provider-share-standby-members.json');
const store = createOverrideSettingsFile<{ members: Record<string, Member> | null }>({
  filePath, scopeKey: activeOwnerScopeKey,
  defaults: () => {
    try { fs.statSync(filePath()); return { members: null }; }
    catch (error) { return { members: (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null }; }
  },
  normalize(raw) {
    const members = (raw as { members?: unknown } | null)?.members;
    if (!members || typeof members !== 'object' || Array.isArray(members)) return { members: null };
    if (Object.values(members).some(row => !row || typeof row !== 'object' || !Number.isSafeInteger(row.joinedAt))) return { members: null };
    return { members: members as Record<string, Member> };
  },
  log: createLogger('provider-share-standby-members'), label: 'provider-share-standby-members',
  maxBytes: 4 * 1024 * 1024, preserveUnreadableFile: true, logLoadedValue: false,
});
export function knownStandbyGuests(): string[] {
  store.invalidateIfChanged();
  const members = store.read().members;
  if (members === null) throw new Error('Standby membership history could not be read');
  return Object.keys(members);
}
/** Persist the cleanup fence before deleting; a restart cannot adopt the new approval early. */
export async function reconcileStandbyGuest(controller: string, joinedAt: number | null): Promise<void> {
  const assertCurrent = captureProviderManagementScope();
  let cleanup = false;
  await store.updateAtomic(({ value }) => {
    assertCurrent();
    if (value.members === null) throw new Error('Standby membership history could not be read');
    const previous = value.members[controller];
    if (joinedAt === null && !previous) return {};
    if (!previous && Object.keys(value.members).length >= 20_000) throw new Error('Standby membership history is full');
    cleanup = !!previous && (previous.pendingCleanup === true || joinedAt === null || previous.joinedAt !== joinedAt);
    return { members: { ...value.members, [controller]: { joinedAt: joinedAt ?? previous.joinedAt, ...(cleanup ? { pendingCleanup: true } : {}) } } };
  });
  assertCurrent();
  if (!cleanup) return;
  if (!revokeGuest) throw new Error('Standby guest cleanup is not configured');
  await revokeGuest(controller, joinedAt !== null);
  assertCurrent();
  await store.updateAtomic(({ value }) => {
    assertCurrent();
    if (!value.members) throw new Error('Standby membership history could not be read');
    const members = { ...value.members };
    if (joinedAt === null) delete members[controller];
    else members[controller] = { joinedAt };
    return { members };
  });
}
