import type { Session } from '@cindy/maker-core';

/** Called only after reservation, with cleanup owned by the product turn. */
export async function beginTemporaryImPermission(
  session: Session,
  setCleanup: (cleanup: () => void) => void,
  warn: (error: unknown) => void,
): Promise<void> {
  const previous = session.stablePermissionModeState;
  if (previous?.mode !== 'bypassPermissions' ||
      !session.capabilities.setPermissionModeMidSession?.supported ||
      !session.capabilities.permissionModes?.some(mode => mode.id === 'auto') ||
      !session.capabilities.turnPermissionPolicy?.supported?.supported ||
      session.capabilities.turnPermissionPolicy.unsupportedPermissionModes?.includes('auto')) return;

  const originalMode = previous.mode;
  const release = session.acquireTurnLease();
  const switching = session.setPermissionModeIfUnchanged(previous, 'auto');
  let released = false;
  const cleanup = () => {
    if (released) return;
    released = true;
    void switching.then(async changed => {
      if (changed) await session.setPermissionModeIfUnchanged(
        { mode: 'auto', generation: previous.generation + 1 }, originalMode,
      );
    }).catch(warn).finally(release);
  };
  setCleanup(cleanup);
  try { await switching; }
  catch (error) { cleanup(); throw error; }
}
