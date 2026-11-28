import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { isGhostInstallApprovalToken, type ConfirmedGhostUninstall } from '../../shared/ghost.js';
import { parsePluginInstallRelId } from '../../shared/pluginIdentity.js';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export function readConfirmedGhostUninstall(value: unknown): ConfirmedGhostUninstall | undefined {
  if (value === undefined) return undefined;
  const expected = value as Partial<ConfirmedGhostUninstall> | null;
  if (!expected || !isDataOwnerPushStamp(expected.owner) ||
      typeof expected.physicalId !== 'string' || !parsePluginInstallRelId(expected.physicalId) ||
      !isGhostInstallApprovalToken(expected.approval) ||
      typeof expected.version !== 'string' || !expected.version) {
    throwIpcError('INVALID_PARAMS', 'Invalid confirmed plugin installation');
  }
  return expected as ConfirmedGhostUninstall;
}

export function assertConfirmedGhostUninstallOwner(expected: ConfirmedGhostUninstall): void {
  const owner = getActiveDataOwnerPushStamp();
  if (isAppSessionBoundaryPending() || owner.dataOwnerId !== expected.owner.dataOwnerId ||
      owner.ownerGeneration !== expected.owner.ownerGeneration) {
    throwIpcError('PRECONDITION_FAILED', 'The active account changed before plugin uninstall');
  }
}
