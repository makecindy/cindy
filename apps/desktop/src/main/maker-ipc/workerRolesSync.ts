import {
  ORCA_WORKER_ROLES_APPLY,
  ORCA_WORKER_ROLES_GET,
  parseOrcaWorkerRolesMutation,
  type OrcaWorkerRoles,
  type OrcaWorkerRolesMutation,
} from '@cindy/device-link';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export interface WorkerRolesSyncDeps<TEvent> {
  /** 本机 renderer 发来的调用必须来自可信应用窗口；经 device-link 进来的调用已在隧道入口鉴权。 */
  isDeviceLinkInvoke: () => boolean;
  assertTrustedSender: (event: TEvent) => void;
  getActiveOwner: () => DataOwnerPushStamp;
  isBoundaryPending: () => boolean;
  /** renderer 镜像过来的当前账号角色清单；还没镜像到时为 null。 */
  getRoles: (owner: DataOwnerPushStamp) => OrcaWorkerRoles | null;
  /** 把一次改动交给本机 renderer 写回真源(localStorage)，随后它会把新的清单再镜像回来。 */
  forwardMutation: (mutation: OrcaWorkerRolesMutation, ownerStamp: DataOwnerPushStamp) => void;
}

/**
 * 协同角色清单的远程读写。真源是这台电脑 renderer 的 workerCreationPrefs；main 只转手：
 * 读返回 renderer 镜像过来的快照，写只校验后转给 renderer，不另存一份。
 */
export function createWorkerRolesHandlers<TEvent>(deps: WorkerRolesSyncDeps<TEvent>): {
  get: (event: TEvent) => OrcaWorkerRoles;
  apply: (event: TEvent, mutation: unknown) => { ok: true };
} {
  const admit = (event: TEvent): DataOwnerPushStamp => {
    if (!deps.isDeviceLinkInvoke()) deps.assertTrustedSender(event);
    if (deps.isBoundaryPending()) throwIpcError('PRECONDITION_FAILED', 'Worker roles owner is changing');
    return deps.getActiveOwner();
  };
  return {
    get: (event) => {
      const roles = deps.getRoles(admit(event));
      if (!roles) throwIpcError('PRECONDITION_FAILED', 'Worker roles are not ready');
      return roles;
    },
    apply: (event, mutation) => {
      const owner = admit(event);
      let operation: OrcaWorkerRolesMutation;
      try {
        operation = parseOrcaWorkerRolesMutation(mutation);
      } catch {
        throwIpcError('INVALID_PARAMS', 'Invalid worker roles operation');
      }
      deps.forwardMutation(operation, owner);
      return { ok: true };
    },
  };
}

export { ORCA_WORKER_ROLES_APPLY, ORCA_WORKER_ROLES_GET };
