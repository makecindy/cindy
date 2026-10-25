import { withRehydrateCloseSuppressed } from '../maker-host/rehydrateCloseSuppression.js';
import { isLocalSessionBusy, prepareLocalSessionCredentialModeSwitch } from '../maker-host/codex-credential-switch.js';
import { setSessionProvider } from '../maker-host/session-provider-store.js';
import { PendingCredentialSwitchService as SharedPendingCredentialSwitchService, type PendingCredentialSwitchDeps } from '@cindy/app-runtime/pendingCredentialSwitch';
export type * from '@cindy/app-runtime/pendingCredentialSwitch';
export class PendingCredentialSwitchService extends SharedPendingCredentialSwitchService {
  constructor(deps: PendingCredentialSwitchDeps) {
    super(deps, { withRehydrateCloseSuppressed, isLocalSessionBusy, prepareLocalSessionCredentialModeSwitch, setSessionProvider });
  }
}
