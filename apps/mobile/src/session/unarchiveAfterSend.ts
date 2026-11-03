import { isSharedTaskPeer } from '@cindy/device-link';
import { isExplicitRemoteNotFoundError } from './newSessionWorktree';
import { isHostManagedSession } from './hostManagedSession';
import {
  remoteSessionStore,
  resolveSessionWriteDevices,
  sessionMetaWriteGuard,
  sessionMetaWriteQueue,
  sessionPendingWrites,
} from './remoteSessionStore';
import { pickWriteFields, retryPatchWhileLatest } from './swipeRowRegistry';
import type { RemoteSession } from './types';

/** 与设备链路 invoke 同形;preSend 是出网前的同步检查点,抛错即放弃这次发送。 */
export type SessionPatchInvoke = <T = unknown>(
  deviceId: string,
  channel: string,
  args?: unknown[],
  options?: { preSend?: () => void },
) => Promise<T>;

const ACTIVE_PATCH = { status: 'active' } as const;

/**
 * 与桌面一致:在已归档任务里发出的消息被电脑接收后,任务自动取消归档。
 *
 * 不变量:电脑接收消息后,任务在电脑端必须变为 active,除非之后有更新的用户操作(本机更晚的
 * 状态写,或其他控制端的推送);写入结束后本机缓存必须与电脑收敛。
 *
 * - 只能在电脑已确认收到消息之后调用——离线时消息先落进手机的待发队列,等重连送达才算发出。
 * - 菜单本来就不提供取消归档的任务(伙伴托管、分享来的任务、协同 Worker)不在这里改状态。
 * - 本机缓存没有这个任务时(跨 App 重启才送达、列表刷新已把归档行移走),用 readSession 向
 *   电脑确认状态;此时不做乐观改写与行回滚,写完重新对账即可。
 * - 状态写入与菜单、首页的归档/删除共用 sessionMetaWriteGuard / sessionMetaWriteQueue:最新的
 *   用户意图为准,这笔旧写会让位,也不会用过期的行去回滚。
 * - 在途期间被遮蔽的其他控制端推送(例如另一台电脑随后归档了它),成功后要消费遮蔽标记并重新对账。
 * - 传入的 invoke 只应绑定账号归属,不能绑定待发记录的生命周期(记录对账后会被清走)。
 * - 同一任务的多笔取消归档按顺序执行,后一笔在前一笔结束后重新判断,保证每条被接收的消息都有
 *   自己的机会(前一笔失败回滚时不会留下已归档的运行中任务)。
 * - 取消归档失败不影响已送达的消息:任务保持已归档,不弹错误。
 */
export function unarchiveSessionAfterSend(
  sessionId: string,
  deviceId: string,
  invoke: SessionPatchInvoke,
  readSession?: () => Promise<Pick<RemoteSession, 'status' | 'orcaRole' | 'source'> | null>,
): Promise<void> {
  // 同一任务的取消归档按顺序执行:前一笔乐观改成 active 后,后一条消息若直接返回,前一笔
  // 失败回滚时这条已被接收的消息就没有自己的取消归档。排在后面的等前一笔结束,再按
  // 那时的缓存状态重新判断(前一笔成功则无事,失败则重试一轮)。
  const run = (inFlightByTask.get(sessionId) ?? Promise.resolve())
    .then(() => unarchiveOnce(sessionId, deviceId, invoke, readSession));
  inFlightByTask.set(sessionId, run);
  void run.finally(() => {
    if (inFlightByTask.get(sessionId) === run) inFlightByTask.delete(sessionId);
  });
  return run;
}

const inFlightByTask = new Map<string, Promise<void>>();

async function unarchiveOnce(
  sessionId: string,
  deviceId: string,
  invoke: SessionPatchInvoke,
  readSession?: () => Promise<Pick<RemoteSession, 'status' | 'orcaRole' | 'source'> | null>,
): Promise<void> {
  const cached = remoteSessionStore.getSessions().find((item) => item.id === sessionId);
  let known: Pick<RemoteSession, 'status' | 'orcaRole' | 'source'> | null | undefined = cached;
  if (!known) {
    try { known = await readSession?.(); } catch { return; }
  }
  if (known?.status !== 'archived' || known.orcaRole === 'worker') return;
  if (isHostManagedSession(known) || isSharedTaskPeer(deviceId)) return;
  // 读取期间缓存可能已变化,以此刻的缓存为准决定能否乐观改写与回滚。
  const row = remoteSessionStore.getSessions().find((item) => item.id === sessionId);
  const { rpcDeviceId, shardId } = resolveSessionWriteDevices(sessionId, row, deviceId)
    ?? { rpcDeviceId: deviceId, shardId: deviceId };
  const fields = Object.keys(ACTIVE_PATCH);
  const write = sessionMetaWriteGuard.begin(sessionId, fields);
  const releasePending = sessionPendingWrites.track(sessionId, fields);
  if (row) remoteSessionStore.applySessionPatch(shardId, sessionId, ACTIVE_PATCH);
  try {
    const updated = await sessionMetaWriteQueue.enqueue(sessionId, fields, () => retryPatchWhileLatest(
      write.isLatest,
      (assertStillLatest) => invoke<RemoteSession>(
        rpcDeviceId,
        'local-db:sessions:patch-meta',
        [sessionId, ACTIVE_PATCH],
        { preSend: assertStillLatest },
      ),
    ));
    if (updated && write.isLatest()) {
      // 与菜单、首页同口径:回包按字段对账(updatedAt 单调下限),再处理被遮蔽的并发推送。
      const currentUpdatedAt = remoteSessionStore.getSessions()
        .find((item) => item.id === sessionId)?.updatedAt ?? null;
      remoteSessionStore.applySessionPatch(shardId, sessionId, pickWriteFields(updated, fields, currentUpdatedAt));
      if (!row || sessionPendingWrites.consumeMaskedPush(sessionId, fields)) {
        remoteSessionStore.requestReseed(shardId);
      }
    }
  } catch (err) {
    // 只有仍是最新写才有资格改本机状态;被后续归档/删除取代时由那笔负责收敛。
    if (row && write.isLatest() && isExplicitRemoteNotFoundError(err)) {
      // 任务已在电脑端被删除:确定缺失,不要把旧的归档行插回去留下幽灵任务。
      remoteSessionStore.applySessionPatch(shardId, sessionId, { status: 'deleted' });
    } else if (row && write.isLatest()) {
      // 把状态改回 archived 会让行移出列表,与页面里的归档回滚一样整行插回原物理 shard;
      // 先释放在途登记,否则 upsert 会因 status 在途而被挡掉。
      releasePending();
      const shardName = remoteSessionStore.getSessions()
        .find((item) => item.deviceLinkDeviceId === shardId)?.deviceLinkDeviceName
        ?? row.deviceLinkDeviceName
        ?? shardId;
      remoteSessionStore.upsertDeviceSession(shardId, shardName, row);
    }
    remoteSessionStore.requestReseed(shardId);
  } finally {
    releasePending();
  }
}
