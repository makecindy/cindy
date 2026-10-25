
import { hasClaudeNativeLogin } from './claude-native-auth.js';

import {
  crossesCodexAppliedCustomProviderIdentity,
  isAppliedCodexCustomProviderIdentity,
} from './codex-custom-provider-route.js';

import { withRehydrateCloseSuppressed } from './rehydrateCloseSuppression.js';

import { getActiveCatalog } from './active-catalog.js';
import { createCredentialModeSwitch } from '@cindy/app-runtime/credentialModeSwitch';
export type * from '@cindy/app-runtime/credentialModeSwitch';
export { CredentialModeSwitchBusyError, CodexCredentialModeSwitchBusyError, isCredentialModeSwitchBusyError } from '@cindy/im-runtime/credentialModeSwitchError';
export const { isCodexThreadModelProviderIdentityMismatch, isLocalSessionBusy, shouldCloseSessionForCredentialSwitch, prepareLocalSessionCredentialModeSwitch, prepareLocalCodexCredentialModeSwitch } = createCredentialModeSwitch({ getActiveCatalog, hasClaudeNativeLogin, withRehydrateCloseSuppressed, crossesCodexAppliedCustomProviderIdentity, isAppliedCodexCustomProviderIdentity });
