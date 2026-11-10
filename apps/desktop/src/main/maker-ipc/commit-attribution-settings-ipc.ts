/**
 * Commit-attribution IPC business logic. The ipcMain adapter only forwards
 * events; trusted-sender checks, runtime validation and safe errors stay here.
 */

import type { CommitAttributionSettings } from '../maker-host/commit-attribution-settings-store.js';
import type { OverrideSettingsState } from '../maker-host/override-settings-file.js';
import { requireBoolean, throwIpcError } from '../utils/ipcValidate.js';

export interface CommitAttributionSettingsIpcDeps {
  assertTrustedSender: (event: unknown) => void;
  readState: () => OverrideSettingsState<CommitAttributionSettings>;
  write: (enabled: boolean) => OverrideSettingsState<CommitAttributionSettings>;
  reset: () => OverrideSettingsState<CommitAttributionSettings>;
}

export function createCommitAttributionSettingsIpc(deps: CommitAttributionSettingsIpcDeps) {
  const wire = () => {
    const state = deps.readState();
    return {
      enabled: state.value.enabled,
      isCustomized: state.isCustomized,
      defaultEnabled: state.defaults.enabled,
    };
  };

  return {
    get(event: unknown) {
      deps.assertTrustedSender(event);
      return wire();
    },

    set(event: unknown, enabled: unknown) {
      deps.assertTrustedSender(event);
      const next = requireBoolean(enabled, 'commit attribution enabled');
      try {
        deps.write(next);
      } catch {
        throwIpcError('INTERNAL', 'commit attribution setting write failed');
      }
      return { ...wire(), effective: 'new-agent-sessions' as const };
    },

    reset(event: unknown) {
      deps.assertTrustedSender(event);
      try {
        deps.reset();
      } catch {
        throwIpcError('INTERNAL', 'commit attribution setting reset failed');
      }
      return { ...wire(), effective: 'new-agent-sessions' as const };
    },
  };
}
