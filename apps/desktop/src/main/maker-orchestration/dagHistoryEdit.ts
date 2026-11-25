import { randomUUID } from 'node:crypto';
import type {
  DagHistoryEditAction,
  DagHistoryEditPreview,
  DagHistoryEditReceipt,
} from '../../shared/dagHistoryEdit.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { withStableOwnerBoundaryMutation } from '../authBoundaryQuarantine.js';
import { getDbClient, getCurrentDbClientUserId } from '../localDb/client/current.js';
import { getMaker } from '../maker-host/index.js';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';
import { agentHandoffPending } from '../maker-ipc/agentHandoffPendingSingleton.js';
import {
  withSessionRestartLock,
  advanceSessionRewindGeneration,
} from '../maker-ipc/sendToSessionLock.js';
import { buildNativeContextReset } from './rewind.js';

interface NativeScope {
  fingerprint: string;
  ids: string[];
  turnCount: number;
  branchCount: number;
}
interface Ticket extends NativeScope {
  sessionId: string;
  clientId: string;
  action: DagHistoryEditAction;
  owner: string;
  expires: number;
}
const tickets = new Map<string, Ticket>();
function owner(expected: string) {
  if (
    !expected ||
    expected !== activeOwnerScopeKey() ||
    !getActiveAppSession().dataOwnerId ||
    getCurrentDbClientUserId() !== getActiveAppSession().dataOwnerId ||
    isAppSessionBoundaryPending()
  )
    throw Object.assign(new Error('账号已切换，不能操作这份会话历史。'), {
      code: 'PRECONDITION_FAILED',
    });
}
function detached(ids: string[]) {
  if (ids.some(isSessionSharedTaskActive)) throw new Error('不支持修改共享会话的历史。');
  if (ids.some((id) => !!getMaker().getSession(id)))
    throw new Error('此会话有已激活的原生上下文，不能保证可逆回退。');
}
function locks<T>(ids: readonly string[], action: () => Promise<T>, i = 0): Promise<T> {
  return i === ids.length
    ? action()
    : withSessionRestartLock(ids[i], () => locks(ids, action, i + 1));
}
export async function previewDagHistoryEdit(
  sessionId: string,
  clientId: string,
  action: DagHistoryEditAction,
  ownerScope: string,
): Promise<DagHistoryEditPreview> {
  owner(ownerScope);
  if (!sessionId || !clientId || !['delete', 'withdraw'].includes(action))
    throw new Error('缺少可定位的原问题。');
  const id = randomUUID(),
    response = {
      operationId: id,
      sessionId,
      clientId,
      action,
      turnCount: 0,
      branchCount: 0,
      canCommit: false,
    };
  for (const [key, t] of tickets)
    if (t.expires <= Date.now() || t.owner !== ownerScope) tickets.delete(key);
  try {
    const scope = await getDbClient().tx<NativeScope>('dag.historyEdit', {
      kind: 'preview',
      id,
      sessionId,
      clientId,
      action,
    });
    owner(ownerScope);
    detached(scope.ids);
    const marker = await buildNativeContextReset(sessionId, {
      targetClientId: clientId,
      agentKind: 'claude-code',
    });
    owner(ownerScope);
    const replay = JSON.parse(marker.markerContent) as {
      handoff: string;
      handoffCoverage?: string;
    };
    if (replay.handoff && replay.handoffCoverage !== 'complete')
      throw new Error('保留的上下文只能压缩交接，不能保证完整撤销。');
    if (tickets.size >= 100) tickets.delete(tickets.keys().next().value!);
    tickets.set(id, {
      ...scope,
      sessionId,
      clientId,
      action,
      owner: ownerScope,
      expires: Date.now() + 300_000,
    });
    return {
      ...response,
      turnCount: scope.turnCount,
      branchCount: scope.branchCount,
      canCommit: true,
    };
  } catch (e) {
    owner(ownerScope);
    return { ...response, reason: e instanceof Error ? e.message : '无法核实原生历史。' };
  }
}
export async function getDagHistoryEditStatus(
  id: string,
  ownerScope: string,
): Promise<DagHistoryEditReceipt | null> {
  owner(ownerScope);
  const value = await getDbClient().tx<DagHistoryEditReceipt | null>('dag.historyEdit', {
    kind: 'status',
    id,
  });
  owner(ownerScope);
  return value;
}
export async function commitDagHistoryEdit(
  id: string,
  ownerScope: string,
): Promise<DagHistoryEditReceipt> {
  const prior = await getDagHistoryEditStatus(id, ownerScope);
  if (prior) return prior;
  const t = tickets.get(id);
  if (!t || t.owner !== ownerScope || t.expires < Date.now())
    throw new Error('预览已失效，请重新核对删除范围。');
  const db = getDbClient();
  const { withIdleDagInputFence } = await import('../maker-ipc/register.js');
  owner(ownerScope);
  return locks([...t.ids].sort(), () =>
    withIdleDagInputFence(t.ids, async () => {
      owner(ownerScope);
      detached(t.ids);
      const marker = await buildNativeContextReset(t.sessionId, {
        targetClientId: t.clientId,
        agentKind: 'claude-code',
      });
      owner(ownerScope);
      detached(t.ids);
      const receipt = await withStableOwnerBoundaryMutation(
        getActiveAppSession().dataOwnerId,
        async () => {
          owner(ownerScope);
          if (getDbClient() !== db) throw new Error('数据库连接已切换，未执行。');
          detached(t.ids);
          return db.tx<DagHistoryEditReceipt>('dag.historyEdit', {
            kind: 'commit',
            id,
            sessionId: t.sessionId,
            clientId: t.clientId,
            action: t.action,
            fingerprint: t.fingerprint,
            markerContent: marker.markerContent,
          });
        },
      );
      owner(ownerScope);
      tickets.delete(id);
      for (const sid of t.ids) {
        agentHandoffPending.clear(sid);
        advanceSessionRewindGeneration(sid);
      }
      return receipt;
    }),
  );
}
export async function undoDagHistoryEdit(
  id: string,
  ownerScope: string,
): Promise<DagHistoryEditReceipt> {
  const prior = await getDagHistoryEditStatus(id, ownerScope);
  if (!prior) throw new Error('找不到此账号的撤销记录。');
  if (prior.status === 'undone') return prior;
  const ids = [prior.sessionId, ...prior.removedSessionIds].sort(),
    db = getDbClient();
  const { withIdleDagInputFence } = await import('../maker-ipc/register.js');
  owner(ownerScope);
  return locks(ids, () =>
    withIdleDagInputFence(ids, async () => {
      owner(ownerScope);
      detached(ids);
      const result = await withStableOwnerBoundaryMutation(
        getActiveAppSession().dataOwnerId,
        async () => {
          owner(ownerScope);
          if (getDbClient() !== db) throw new Error('数据库连接已切换，未执行。');
          detached(ids);
          return db.tx<DagHistoryEditReceipt>('dag.historyEdit', { kind: 'undo', id });
        },
      );
      owner(ownerScope);
      for (const sid of ids) {
        agentHandoffPending.clear(sid);
        advanceSessionRewindGeneration(sid);
      }
      return result;
    }),
  );
}
