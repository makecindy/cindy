import { ipcMain } from 'electron';

import {
  getTeamByLeadSession,
  getTeamByWorkerSession,
  updateWorkerStatus,
  type OrcaWorkerStatus,
} from '../orcaTeamStore.js';
import {
  __resetOrcaWorkerListSingleFlightForTest,
  listWorkersByLeadSingleFlight,
  listWorkersByLeadsSingleFlight,
} from './orcaWorkerListSingleFlight.js';
import {
  throwIpcError,
  requireString,
  requireEnum,
} from '../../utils/ipcValidate.js';

export {
  invalidateWorkersByLeadSingleFlight,
  listWorkersByLeadSingleFlight,
  listWorkersByLeadsSingleFlight,
} from './orcaWorkerListSingleFlight.js';

const WORKER_STATUSES = ['idle', 'running', 'done', 'error'] as const;
const MAX_BATCH_LEAD_IDS = 200;

function requireLeadSessionIdArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH_LEAD_IDS) {
    throwIpcError('INVALID_PARAMS', 'leadSessionIds must be an array');
  }
  return [...new Set(value.map((item, index) => requireString(item, `leadSessionIds[${index}]`)))];
}

export function __resetOrcaWorkflowIpcForTest(): void {
  __resetOrcaWorkerListSingleFlightForTest();
}

export function registerOrcaWorkflowIpc(): void {
  ipcMain.handle(
    'local-db:orca-workflows:get-by-lead',
    async (_e, leadSessionId: unknown) => {
      return getTeamByLeadSession(requireString(leadSessionId, 'leadSessionId'));
    },
  );

  ipcMain.handle(
    'local-db:orca-workflows:get-by-worker-session',
    async (_e, workerSessionId: unknown) => {
      return getTeamByWorkerSession(requireString(workerSessionId, 'workerSessionId'));
    },
  );

  ipcMain.handle(
    'local-db:orca-workflows:list-workers-by-lead',
    async (_e, leadSessionId: unknown) => {
      const normalizedLeadSessionId = requireString(leadSessionId, 'leadSessionId');
      return listWorkersByLeadSingleFlight(normalizedLeadSessionId);
    },
  );

  ipcMain.handle(
    'local-db:orca-workflows:list-workers-by-leads',
    async (_e, leadSessionIds: unknown) => {
      const normalizedLeadSessionIds = requireLeadSessionIdArray(leadSessionIds);
      return listWorkersByLeadsSingleFlight(normalizedLeadSessionIds);
    },
  );

  ipcMain.handle(
    'local-db:orca-workflows:update-worker-status',
    async (_e, workerId: unknown, status: unknown) => {
      return updateWorkerStatus(
        requireString(workerId, 'workerId'),
        requireEnum<OrcaWorkerStatus>(status, WORKER_STATUSES, 'worker status'),
      );
    },
  );
}
