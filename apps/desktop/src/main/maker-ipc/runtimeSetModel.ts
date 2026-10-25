import { withRehydrateCloseSuppressed } from '../maker-host/rehydrateCloseSuppression.js';
import { getSessionProvider, hasSessionProvider, setSessionProvider } from '../maker-host/session-provider-store.js';
import { isLocalSessionBusy, prepareLocalSessionCredentialModeSwitch, shouldCloseSessionForCredentialSwitch } from '../maker-host/codex-credential-switch.js';
import { createRuntimeSetModel } from '@cindy/app-runtime/runtimeSetModel';
export type * from '@cindy/app-runtime/runtimeSetModel';
export { closeRejectedRuntimeAndRestoreControlStores, isRemoteModelSwitchRouteChangeError } from '@cindy/app-runtime/runtimeSetModel';
export const { applyRuntimeSetModelChange, refreshActiveModelContextSettings } = createRuntimeSetModel({
  getSessionProvider, hasSessionProvider, setSessionProvider, withRehydrateCloseSuppressed,
  isLocalSessionBusy, prepareLocalSessionCredentialModeSwitch, shouldCloseSessionForCredentialSwitch,
});
