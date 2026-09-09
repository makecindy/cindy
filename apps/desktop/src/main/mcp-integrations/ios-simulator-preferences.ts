/**
 * Owner-scoped iOS Simulator presentation preferences.
 *
 * This store only controls whether successful Host actions automatically ask
 * the Renderer to reveal the embedded panel. It must never gate simulator
 * lifecycle, ownership, build, launch, input, or explicit panel-open actions.
 */

import type { IOSSimulatorPreferences } from '../../shared/iosSimulatorIpc.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('ios-simulator-preferences');

const DEFAULTS: IOSSimulatorPreferences = {
  autoOpenEmbeddedPanel: true,
};

function normalize(raw: unknown): IOSSimulatorPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const value = (raw as Record<string, unknown>).autoOpenEmbeddedPanel;
  return {
    autoOpenEmbeddedPanel: typeof value === 'boolean' ? value : DEFAULTS.autoOpenEmbeddedPanel,
  };
}

export interface IOSSimulatorPreferencesStore {
  read(): IOSSimulatorPreferences;
  writeAutoOpenEmbeddedPanel(enabled: boolean): Promise<IOSSimulatorPreferences>;
}

export function createIOSSimulatorPreferencesStore(options: {
  filePath: () => string;
  scopeKey?: () => string;
}): IOSSimulatorPreferencesStore {
  const store = createOverrideSettingsFile<IOSSimulatorPreferences>({
    filePath: options.filePath,
    defaults: DEFAULTS,
    normalize,
    scopeKey: options.scopeKey,
    log,
    label: 'iOS Simulator preferences',
    maxBytes: 4 * 1024,
  });

  return {
    read() {
      store.invalidateIfChanged();
      return store.read();
    },
    async writeAutoOpenEmbeddedPanel(enabled) {
      store.invalidateIfChanged();
      await store.writePatchAtomic({ autoOpenEmbeddedPanel: enabled });
      log.info('iOS Simulator auto-open preference written', { enabled });
      return store.read();
    },
  };
}

const ownerStore = createIOSSimulatorPreferencesStore({
  filePath: () => ownerScopedUserDataPath('ios-simulator-preferences.json'),
  scopeKey: activeOwnerScopeKey,
});

export function readIOSSimulatorPreferences(): IOSSimulatorPreferences {
  return ownerStore.read();
}

export function writeIOSSimulatorAutoOpenEmbeddedPanel(
  enabled: boolean,
): Promise<IOSSimulatorPreferences> {
  return ownerStore.writeAutoOpenEmbeddedPanel(enabled);
}

export const __testing = { normalize, DEFAULTS };
