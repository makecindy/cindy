import path from 'node:path';
import { app } from 'electron';
import { dataOwnerStorageKey, isAppSessionBoundaryPending, peekCommittedAppSession } from '../appSessionState.js';
import { peekCommittedAuthIdentity } from '../authManager.js';
import type { CoreSettingsReadContext } from './readers/core.js';

/** 只使用已提交的内存身份和现有 profile 定位；不加载会话、不初始化鉴权、不创建目录。 */
export function getSettingsReadContext(): CoreSettingsReadContext | null {
  try {
    if (isAppSessionBoundaryPending()) return null;
    const session = peekCommittedAppSession();
    if (!session || (session.mode !== 'local' && session.mode !== 'cloud') || !session.dataOwnerId) return null;
    const auth = session.mode === 'cloud' ? peekCommittedAuthIdentity() : null;
    if (session.mode === 'cloud' && (!auth || !auth.isAuthenticated || auth.userId !== session.dataOwnerId)) return null;
    const userDataPath = app.getPath('userData');
    if (!userDataPath || !path.isAbsolute(userDataPath)) return null;
    const ownerRoot = path.join(userDataPath, 'owners', dataOwnerStorageKey(session.dataOwnerId));
    const latest = peekCommittedAppSession();
    if (isAppSessionBoundaryPending() || !latest || latest.mode !== session.mode
      || latest.dataOwnerId !== session.dataOwnerId || latest.generation !== session.generation) return null;
    return {
      mode: session.mode,
      dataOwnerId: session.dataOwnerId,
      generation: session.generation,
      ownerRoot,
      userDataPath,
      isAuthenticated: auth?.isAuthenticated ?? false,
      membershipKind: auth?.membershipKind ?? null,
      platform: process.platform,
      arch: process.arch,
    };
  } catch {
    return null;
  }
}

/** 任何上下文漂移都丢弃整次读取；静态错误不得夹带 owner、路径或底层异常。 */
export function assertSettingsReadContext(captured: CoreSettingsReadContext): void {
  const current = getSettingsReadContext();
  if (!current || current.mode !== captured.mode || current.dataOwnerId !== captured.dataOwnerId
    || current.generation !== captured.generation || current.userDataPath !== captured.userDataPath
    || current.ownerRoot !== captured.ownerRoot || current.isAuthenticated !== captured.isAuthenticated
    || current.membershipKind !== captured.membershipKind || current.platform !== captured.platform
    || current.arch !== captured.arch) throw new Error('SETTINGS_OWNER_CHANGED');
}
