import { app } from 'electron';

import {
  portableOverrideSettings,
  type OverrideSettingsState,
} from './override-settings-file.js';
import {
  createSessionRuntimeFallbackSettingsFile,
  type SessionRuntimeFallbackSettings,
} from './sessionRuntimeFallbackSettingsCore.js';

export type { SessionRuntimeFallbackSettings } from './sessionRuntimeFallbackSettingsCore.js';

const store = createSessionRuntimeFallbackSettingsFile(() => app.getPath('userData'));

export function readSessionRuntimeFallbackSettings(): SessionRuntimeFallbackSettings {
  return store.read();
}

export function readSessionRuntimeFallbackSettingsState(): OverrideSettingsState<SessionRuntimeFallbackSettings> {
  return store.readState();
}

export function writeSessionRuntimeFallbackEnabled(enabled: boolean): void {
  store.writePatch({ enabled });
}

export function resetSessionRuntimeFallbackSettings(): SessionRuntimeFallbackSettings {
  return store.reset();
}

/** New-computer setup: values the user changed here (docs/product-rules/new-device-setup-migration.md). */
export const sessionRuntimeFallbackPortableSettings = portableOverrideSettings(store);
