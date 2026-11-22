import { parseOrcaWorkerRoles, type OrcaWorkerRoles } from '@cindy/device-link';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import {
  normalizeWorkerCreationSelection,
  type WorkerCreationSelection,
} from '../../shared/workerCreationSelection.js';
import {
  isOrcaWorkerPermissionMode,
  type OrcaWorkerPermissionMode,
} from '../../shared/orca-worker-permission-mode.js';

interface WorkerCreationPrefsSyncDeps<TEvent> {
  assertTrustedSender: (event: TEvent) => void;
  getActiveOwner?: () => DataOwnerPushStamp;
  isBoundaryPending?: () => boolean;
  setSelection?: (
    selection: WorkerCreationSelection | null,
    ownerStamp: DataOwnerPushStamp,
    /** 角色清单镜像；快照里没带或格式不对时为 null。 */
    roles: OrcaWorkerRoles | null,
  ) => void;
  setWorkerPermissionMode: (mode: OrcaWorkerPermissionMode) => void;
}

/**
 * Renderer → Main 的 Worker 创建偏好同步边界。
 *
 * sender guard 必须先于 payload 解析与缓存写入：即使 payload 看起来合法，未登记的
 * Renderer / WebView 也不能修改进程级 Worker 默认权限。
 */
export function createWorkerCreationPrefsSyncHandler<TEvent>(
  deps: WorkerCreationPrefsSyncDeps<TEvent>,
): (event: TEvent, payload: unknown) => void {
  return (event, payload) => {
    deps.assertTrustedSender(event);
    if (!payload || typeof payload !== 'object') return;
    const mode = (payload as { workerPermissionMode?: unknown }).workerPermissionMode;
    if (!isOrcaWorkerPermissionMode(mode)) return;
    deps.setWorkerPermissionMode(mode);
    const p = payload as { ownerStamp?: unknown; selection?: unknown; roles?: unknown };
    const owner = deps.getActiveOwner?.();
    if (
      !owner ||
      deps.isBoundaryPending?.() ||
      !isDataOwnerPushStamp(p.ownerStamp) ||
      p.ownerStamp.dataOwnerId !== owner.dataOwnerId ||
      p.ownerStamp.ownerGeneration !== owner.ownerGeneration
    )
      return;
    let roles: OrcaWorkerRoles | null = null;
    try {
      roles = p.roles === undefined || p.roles === null ? null : parseOrcaWorkerRoles(p.roles);
    } catch {
      // 读不懂的角色清单当作没镜像：远程读取会得到「未就绪」，不会拿到半截数据。
    }
    deps.setSelection?.(normalizeWorkerCreationSelection(p.selection), owner, roles);
  };
}
