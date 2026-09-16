import type { Logger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';

interface InterruptedTurnAutoResumeSettingsState {
  value: { enabled: boolean };
  defaults: { enabled: boolean };
  isCustomized: boolean;
}

interface InterruptedTurnAutoResumeSettingsHandlersDeps {
  readState: () => InterruptedTurnAutoResumeSettingsState;
  writeEnabled: (enabled: boolean) => void | Promise<void>;
  reset: () => void | Promise<unknown>;
  cancelWaiting: () => void;
  log: Pick<Logger, 'error'>;
}

function settingsWire(state: InterruptedTurnAutoResumeSettingsState) {
  return {
    enabled: state.value.enabled,
    isCustomized: state.isCustomized,
    defaultEnabled: state.defaults.enabled,
  };
}

/**
 * Keep filesystem details on the Main side of the IPC boundary. In particular,
 * Node errors from rename/unlink commonly contain the absolute userData path.
 */
function throwSettingsIpcError(
  deps: InterruptedTurnAutoResumeSettingsHandlersDeps,
  action: 'read' | 'write' | 'reset',
  error: unknown,
): never {
  deps.log.error('interrupted turn auto-resume settings operation failed', {
    action,
    error: error instanceof Error ? error.message : String(error),
  });
  throwIpcError('INTERNAL', `interrupted turn auto-resume settings ${action} failed`);
}

/** Business handlers kept separate from ipcMain so failure paths are unit-testable. */
export function createInterruptedTurnAutoResumeSettingsHandlers(
  deps: InterruptedTurnAutoResumeSettingsHandlersDeps,
) {
  const readWire = () => settingsWire(deps.readState());

  return {
    get() {
      try {
        return readWire();
      } catch (error) {
        throwSettingsIpcError(deps, 'read', error);
      }
    },

    async set(enabled: unknown) {
      if (typeof enabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'interrupted turn auto-resume enabled required (boolean)');
      }
      try {
        await deps.writeEnabled(enabled);
        if (!enabled) deps.cancelWaiting();
        return { ...readWire(), effective: 'immediate' as const };
      } catch (error) {
        throwSettingsIpcError(deps, 'write', error);
      }
    },

    async reset() {
      try {
        await deps.reset();
        return { ...readWire(), effective: 'immediate' as const };
      } catch (error) {
        throwSettingsIpcError(deps, 'reset', error);
      }
    },
  };
}
