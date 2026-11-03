import fs from 'node:fs';
import path from 'node:path';

import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** 账号进入清理边界时旧 owner key 仍有效，管理操作必须同时核对切换状态。 */
export function captureProviderManagementScope(ownerKey: () => string = activeOwnerScopeKey): () => void {
  const owner = ownerKey();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || ownerKey() !== owner) {
      throwIpcError('PRECONDITION_FAILED', 'The account changed during provider management');
    }
  };
  assertCurrent();
  return assertCurrent;
}

/** 锁顺序固定为账号级组修改锁 → 各数据文件锁，清理回放和新分配不能交错。 */
export async function withProviderGroupMutation<T>(task: () => Promise<T>): Promise<T> {
  const assertCurrent = captureProviderManagementScope();
  const file = ownerScopedUserDataPath('provider-group-mutation.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withCrossProcessLock(file, { label: 'provider-group-mutation', waitMs: 12_000 }, async (status) => {
    if (!status.held) throwIpcError('PRECONDITION_FAILED', 'Provider group settings are busy in another process');
    assertCurrent();
    return task();
  });
}
