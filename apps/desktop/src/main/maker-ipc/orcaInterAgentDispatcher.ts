import { createLogger } from '../logger.js';
import { createOrcaInterAgentDispatcher as createSharedDispatcher, type OrcaInterAgentDispatcherDeps, type OrcaInterAgentDispatcher } from '@cindy/orca-workflow/host/orcaInterAgentDispatcher';
export * from '@cindy/orca-workflow/host/orcaInterAgentDispatcher';
const defaultLog = createLogger('maker-ipc');
export function createOrcaInterAgentDispatcher<TSessionMeta>(deps: OrcaInterAgentDispatcherDeps<TSessionMeta>): OrcaInterAgentDispatcher {
  return createSharedDispatcher(deps, defaultLog);
}
