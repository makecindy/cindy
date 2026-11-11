const activeLocks = new Set<symbol>();

function syncInteractionLockMarker(): void {
  if (activeLocks.size > 0) {
    document.body.dataset.appInteractionLocked = '1';
    return;
  }
  delete document.body.dataset.appInteractionLocked;
}

export function acquireAppInteractionLock(): () => void {
  const token = Symbol('app-interaction-lock');
  activeLocks.add(token);
  syncInteractionLockMarker();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLocks.delete(token);
    syncInteractionLockMarker();
  };
}

export function isAppInteractionLocked(): boolean {
  return activeLocks.size > 0;
}
