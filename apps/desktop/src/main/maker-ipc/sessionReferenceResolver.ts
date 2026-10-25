import { createSessionReferenceResolver } from '@cindy/app-runtime/sessionReferenceResolver';
import { getDbClient } from '../localDb/client/current.js';
import { getSelfDeviceId, remoteInvoke } from '../device-link/index.js';
import { readLatestSessionTerminal } from '../localDb/sessionTerminal.js';
export { MAX_SESSION_REFERENCES, MAX_REFERENCE_MESSAGES, MAX_REFERENCE_TOKENS, estimateReferenceTokens } from '@cindy/app-runtime/sessionReferenceBudget';
export const { SessionReferenceError, resolveSessionReferences } = createSessionReferenceResolver({
 getDbClient: () => getDbClient(), getSelfDeviceId: () => getSelfDeviceId(),
 invokeRemote: (...args) => remoteInvoke(...args), readLatestSessionTerminal: (...args) => readLatestSessionTerminal(...args),
});
