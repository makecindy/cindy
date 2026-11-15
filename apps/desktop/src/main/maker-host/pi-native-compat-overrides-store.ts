/** Learned Pi cache compatibility, scoped to connection + wire model + route digest.
 * Internal override, not a user preference. Delete an entry to re-evaluate support.
 * Unreadable files are preserved; a failed write never authorizes replay.
 */

// The store itself lives in piNativeCompatOverridesStoreCore.ts (shared with the Node Host). This
// module builds the single Desktop instance; its port resolves Electron when called, never when this
// module loads.
import { createPiNativeCompatOverridesStore } from './piNativeCompatOverridesStoreCore.js';
import { app } from 'electron';

const desktopPiNativeCompatOverrides = createPiNativeCompatOverridesStore({
  app: { getPath: (name) => app.getPath(name) },
});
type Instance = typeof desktopPiNativeCompatOverrides;

export function readPiNativeCompatOverride(...args: Parameters<Instance['readPiNativeCompatOverride']>): ReturnType<Instance['readPiNativeCompatOverride']> {
  return desktopPiNativeCompatOverrides.readPiNativeCompatOverride(...args);
}

export function recordPiNativeCompatOverride(...args: Parameters<Instance['recordPiNativeCompatOverride']>): ReturnType<Instance['recordPiNativeCompatOverride']> {
  return desktopPiNativeCompatOverrides.recordPiNativeCompatOverride(...args);
}
