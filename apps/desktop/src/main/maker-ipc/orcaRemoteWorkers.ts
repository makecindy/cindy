import { createId } from '@paralleldrive/cuid2';
import { createOrcaRemoteWorkers as createShared, type OrcaRemoteWorkersDeps as SharedDeps } from '@cindy/orca-workflow/host/orcaRemoteWorkers';
export { invokeDeviceValue, isExecutionDeviceCandidate } from '@cindy/orca-workflow/host/orcaRemoteWorkers';
import {
  archiveSingleWorkerSession,
  getRemoteWorkerByProxySession,
  listActiveRemoteWorkers,
  listUnreleasedEndedRemoteWorkers,
  markWorkerRemoteReleased,
  markWorkerRemoteStopConfirmed,
  getWorkerRemoteReleaseState,
  saveWorkerRemoteReport,
  saveRemoteWorkerOpen,
  removeRemoteWorkerOpen,
  listOrphanRemoteWorkerOpens,
  addRemoteWorker,
  removeWorker,
} from '../localDb/orcaTeamStore.js';

export type OrcaRemoteWorkers = ReturnType<typeof createOrcaRemoteWorkers>;
export type OrcaRemoteWorkersDeps = Omit<SharedDeps, 'store' | 'createId'>;
export function createOrcaRemoteWorkers(deps: OrcaRemoteWorkersDeps) {
  return createShared({ ...deps, createId, store: {
    archiveSingleWorkerSession, getRemoteWorkerByProxySession, listActiveRemoteWorkers,
    listUnreleasedEndedRemoteWorkers, markWorkerRemoteReleased, markWorkerRemoteStopConfirmed,
    getWorkerRemoteReleaseState, saveWorkerRemoteReport, saveRemoteWorkerOpen, removeRemoteWorkerOpen,
    listOrphanRemoteWorkerOpens, addRemoteWorker, removeWorker,
  } });
}
