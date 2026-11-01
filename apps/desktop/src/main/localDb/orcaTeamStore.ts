export * from '@cindy/app-runtime/orcaTeamStore';
import { createOrcaTeamStore } from '@cindy/app-runtime/orcaTeamStore';
import { BrowserWindow } from 'electron';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { notifyAgentIslandSessionPatch } from './agentIslandSessionPatch.js';
import { withSessionRouteLock, withSessionRouteLocks } from './sessionRouteLock.js';
import { cleanupSessionRuntimeForTerminalStatus } from './sessionRuntimeCleanup.js';
import { compactSessionToolResultsBestEffort } from './toolResultCompaction.js';
const runtime = createOrcaTeamStore({
  getDbClient: () => getDbClient(), logger: createLogger('orca-team-store'),
  withSessionRouteLock: (...args) => withSessionRouteLock(...args),
  withSessionRouteLocks: (...args) => withSessionRouteLocks(...args),
  cleanupSessionRuntimeForTerminalStatus: (...args) => cleanupSessionRuntimeForTerminalStatus(...args),
  compactSessionToolResultsBestEffort: (...args) => compactSessionToolResultsBestEffort(...args),
  broadcastSessionPatch(sessionId, patch) {
    notifyAgentIslandSessionPatch(sessionId, patch);
    tapWindowBroadcast('local-db:sessions:patched', { sessionId, patch });
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send('local-db:sessions:patched', { sessionId, patch }); } catch { /* best effort */ }
    }
  },
});
export const { markWorkerIdle, listIdleReleaseCandidates, markIdleReleased, touchWorker, setRemoteWorkerStatusProvider, reserveWorkerCreation, renewWorkerCreationReservation, releaseWorkerCreationReservation, createOrGetTeamForLead, getTeamByLeadSession, getActiveTeamByLead, isOrphanedTeamInit, createActiveTeam, markTeamEnded, archiveWorkersByTeam, markWorkersStatusByTeam, reconcileInactiveTeamWorkersForLead, getTeamByWorkerSession, addOrUpdateWorker, listWorkersByLead, listWorkersByLeads, getWorkerLink, getSessionOrcaRole, getRemoteOrcaSession, updateWorkerStatus, markWorkerIdleIfStatus, restoreWorkerDoneIfIdle, removeWorker, setWorkerFocus, archiveSingleWorkerSession, setSessionOrcaRole, addRemoteWorker, setWorkerRemoteExecution, saveWorkerRemoteReport, saveRemoteWorkerOpen, removeRemoteWorkerOpen, listOrphanRemoteWorkerOpens, markWorkerRemoteStopConfirmed, getWorkerRemoteReleaseState, markWorkerRemoteReleased, listActiveRemoteWorkers, listUnreleasedEndedRemoteWorkers, getRemoteWorkerByProxySession } = runtime;
export const updateWorkerIdentity = runtime.updateWorkerIdentity;
