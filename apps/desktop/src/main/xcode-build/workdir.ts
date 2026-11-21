import path from 'node:path';

import { getSessionRowSnapshotStrict } from '../localDb/ipc/sessions.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Main-authoritative local workdir check for Xcode discovery and execution. */
export async function assertXcodeBuildSessionWorkdir(
  sessionId: string,
  workdir: string,
): Promise<void> {
  let row;
  try {
    row = await getSessionRowSnapshotStrict(sessionId);
  } catch {
    throwIpcError('PRECONDITION_FAILED', 'session workspace is unavailable');
  }
  if (!row || !row.workingDir) throwIpcError('NOT_FOUND', 'session workspace not found');
  if (row.remoteHostId || row.agentDeviceId) {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Xcode builds require a local workspace');
  }
  if (path.resolve(row.workingDir) !== path.resolve(workdir)) {
    throwIpcError('PERMISSION_DENIED', 'workdir does not belong to this session');
  }
}
