/**
 * 模型组接口的纯 Node 来源闸(architecture-invariants §5)：Desktop 与 Node Host 共用。
 * 本机可信调用与同账号 owner 远程控制端放行，分享任务等 scoped 控制端拒绝。
 */
import { throwIpcError } from '../utils/ipcValidate.js';

export interface ModelGroupsCallerDeps {
  isDeviceLink: () => boolean;
  origin: () => 'owner' | 'scoped' | undefined;
  assertLocal?: () => void;
}

export function assertModelGroupsCallerCore(deps: ModelGroupsCallerDeps): void {
  if (!deps.isDeviceLink()) {
    deps.assertLocal?.();
    return;
  }
  if (deps.origin() !== 'owner') {
    throwIpcError('PRECONDITION_FAILED', 'remote model groups require an owner controller');
  }
}
