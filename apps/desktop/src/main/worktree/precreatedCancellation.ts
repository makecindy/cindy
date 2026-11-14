// The cancellation store itself lives in precreatedCancellationCore.ts (shared with the Node
// Host). This module builds the single Desktop instance; its port resolves Electron when
// called, never when this module loads.
import { createPrecreatedCancellation } from './precreatedCancellationCore.js';
import { app } from 'electron';

const desktopCancellation = createPrecreatedCancellation({
  app: { getPath: (name) => app.getPath(name) },
});
type Instance = typeof desktopCancellation;

/** Serialize creation/registration and cancellation across processes sharing a profile. */
export function withPrecreatedSessionOperationLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  return desktopCancellation.withPrecreatedSessionOperationLock(sessionId, task);
}

export function assertPrecreatedSessionNotCancelled(...args: Parameters<Instance['assertPrecreatedSessionNotCancelled']>): ReturnType<Instance['assertPrecreatedSessionNotCancelled']> {
  return desktopCancellation.assertPrecreatedSessionNotCancelled(...args);
}

export function sealPrecreatedSessionCancellation(...args: Parameters<Instance['sealPrecreatedSessionCancellation']>): ReturnType<Instance['sealPrecreatedSessionCancellation']> {
  return desktopCancellation.sealPrecreatedSessionCancellation(...args);
}
