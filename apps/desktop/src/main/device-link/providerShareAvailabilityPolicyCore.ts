import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { withCrossProcessLock } from './crossProcessLock.js';
import { captureProviderManagementScope } from '../provider-group/managementScope.js';
import { ownerScopedUserDataPath, activeOwnerScopeKey } from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { createLogger } from '../logger.js';


export function createAvailabilityPolicy(disableShareAvailability: (shareId: string) => Promise<void>) {
/** Remember before publishing, so a restart/offline settings edit cannot forget a cloud grant. */
const registry = createOverrideSettingsFile<{ shares: Record<string, string> | null }>({
  filePath: () => ownerScopedUserDataPath('provider-share-availability.json'), scopeKey: activeOwnerScopeKey,
  defaults: () => {
    try { fs.statSync(ownerScopedUserDataPath('provider-share-availability.json')); return { shares: null }; }
    catch (error) { return { shares: (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null }; }
  }, normalize: value => {
    const shares = (value as { shares?: unknown } | null)?.shares;
    if (!shares || typeof shares !== 'object' || Array.isArray(shares)) return { shares: null };
    if (Object.entries(shares).some(([id, provider]) => !id || id.length > 512 || typeof provider !== 'string' || !provider)) return { shares: null };
    return { shares: { ...shares } as Record<string, string> };
  }, log: createLogger('provider-share-availability'), label: 'provider-share-availability',
  maxBytes: 1024 * 1024, preserveUnreadableFile: true, logLoadedValue: false,
});
const mutation = new AsyncLocalStorage<{ active: boolean }>();
let tail: Promise<unknown> = Promise.resolve();
function withAvailabilityPolicyLock<T>(work: () => Promise<T>): Promise<T> {
  const assertCurrent = captureProviderManagementScope();
  const result = tail.then(async () => {
    assertCurrent();
    const file = ownerScopedUserDataPath('provider-share-availability.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withCrossProcessLock(file, { label: 'provider-share-availability', waitMs: 12_000 }, async status => {
      if (!status.held) throw new Error('Shared standby permissions are busy');
      assertCurrent();
      return work();
    });
  });
  tail = result.catch(() => undefined);
  return result;
}
async function rememberAvailabilityShare(shareId: string, providerId: string): Promise<void> {
  await registry.updateAtomic(({ value }) => {
    if (value.shares === null) throw new Error('Shared standby registrations could not be read');
    return { shares: { ...value.shares, [shareId]: providerId } };
  });
}
/** Cloud revocation must precede acknowledging a narrower local permission. */
function withAvailabilityPolicyMutation<T>(providerId: string | undefined, work: () => Promise<T>): Promise<T> {
  const owner = activeOwnerScopeKey();
  const run = async () => {
    if (activeOwnerScopeKey() !== owner) throw new Error('Provider share account changed');
    registry.invalidateIfChanged();
    const registered = registry.read().shares;
    if (registered === null) throw new Error('Shared standby registrations could not be read');
    const shares = Object.entries(registered).filter(([, provider]) => !providerId || provider === providerId);
    if (shares.length) {
      for (const [id] of shares) await disableShareAvailability(id);
      if (activeOwnerScopeKey() !== owner) throw new Error('Provider share account changed');
      await registry.updateAtomic(({ value }) => {
        const retained = { ...value.shares };
        for (const [id] of shares) delete retained[id];
        return { shares: retained };
      });
    }
    return work();
  };
  if (mutation.getStore()?.active) return run();
  return withAvailabilityPolicyLock(async () => {
    const token = { active: true };
    try { return await mutation.run(token, run); }
    finally { token.active = false; }
  });
}

return { withAvailabilityPolicyLock, rememberAvailabilityShare, withAvailabilityPolicyMutation };
}
