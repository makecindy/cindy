import {
  synthesizeOrcaVendorOptionsFromDb as synthesize,
  preparePersistedOrcaSessionStart as prepare,
  type OrcaSessionStartOptionsDeps,
} from '@cindy/orca-workflow/host/orcaSessionStartOptions';
import { getSessionOrcaRole, getWorkerLink, getRemoteOrcaSession } from '../localDb/orcaTeamStore.js';
import { createLogger } from '../logger.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';
import { knownNonOrcaSessionIds } from './orcaMcpHydrationCache.js';
export { applyOrcaInstructions, type OrcaSessionStartOptionsDeps } from '@cindy/orca-workflow/host/orcaSessionStartOptions';
const log = createLogger('maker-ipc:orca-session-start');

const defaultDeps: OrcaSessionStartOptionsDeps = {
  getSessionRole: getSessionOrcaRole,
  getWorkerLink: (workerSessionId) => getWorkerLink({ workerSessionId }),
  getRemoteLead: async sessionId => (await getRemoteOrcaSession(sessionId))?.orcaRemoteLead ?? null,
  warn: (message, meta) => log.warn(message, meta),
};

export function synthesizeOrcaVendorOptionsFromDb(sessionId: string, options: MakerSessionCreateOpts, deps: OrcaSessionStartOptionsDeps = defaultDeps) {
  return synthesize(sessionId, options, { knownNonOrcaSessionIds, ...deps });
}
export function preparePersistedOrcaSessionStart(sessionId: string, options: MakerSessionCreateOpts, deps: OrcaSessionStartOptionsDeps = defaultDeps) {
  return prepare(sessionId, options, { knownNonOrcaSessionIds, ...deps });
}
