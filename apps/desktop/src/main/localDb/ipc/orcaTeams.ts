import { ipcMain } from 'electron';

import {
  getTeamByLeadSession,
  getTeamByWorkerSession,
  listWorkersByLead,
  updateWorkerStatus,
  type OrcaWorkerStatus,
} from '../orcaTeamStore.js';
import {
  requireString,
  requireEnum,
} from '../../utils/ipcValidate.js';

const WORKER_STATUSES = ['idle', 'running', 'done', 'error'] as const;

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
      return listWorkersByLead(requireString(leadSessionId, 'leadSessionId'));
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
