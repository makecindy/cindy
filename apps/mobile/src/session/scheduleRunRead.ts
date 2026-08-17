import type { ScheduleEventProjection } from '@cindy/maker-shared/schedule-events';
import { isTransientRemoteError } from '@/device-link/remoteRetry';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { loadSessionScheduleIndex } from '@/session/scheduleIndex';

/**
 * 会话维度的自动化 run「已读」编排(对齐桌面端 CCAgentSidebarUpper 的「激活即已读」语义)。
 *
 * 手机端打开自动化会话读完报告后,run 的未读状态要在被控端清掉,host 才会广播 `read` 调度
 * 事件,首页 / 设备列表的未读红点才会消失。这里提供两条互补路径:
 *  - 开会话时:拉一次 schedule index,把该会话名下所有未读 run 标已读(markSessionScheduleRunsRead);
 *  - 会话开着时报告刚生成:从调度事件投影里直接取出绑定到本会话的完成 run,免拉 index
 *    (unreadRunIdFromProjection → 单次 markRunRead)。
 */

type ScheduleReadTransport = Pick<MobileMakerTransport, 'schedule'>;

/**
 * 拉一次 schedule index,把 `sessionId` 名下的未读 run 全部标记已读。
 * 返回成功标记的 runId 列表(空数组 = 无未读或全部失败)。单个非瞬态 run 标记失败不影响其它 run;
 * 瞬态失败向外抛给调用方的 withTransientRemoteRetry。
 */
export async function markSessionScheduleRunsRead(
  maker: ScheduleReadTransport,
  sessionId: string,
): Promise<string[]> {
  if (!sessionId) return [];
  const index = await loadSessionScheduleIndex(maker, {
    throwOnTransientRunListError: true,
    sessionIds: [sessionId],
  });
  const unreadRunIds = index.get(sessionId)?.unreadRunIds ?? [];
  if (unreadRunIds.length === 0) return [];
  // 单个永久失败不阻塞其它 run;瞬态失败需要抛出,让外层 retry 重新探测并补标。
  // allSettled 后按原 unreadRunIds 顺序收集成功项,返回值保序。
  const results = await Promise.allSettled(
    unreadRunIds.map((runId) => maker.schedule.markRunRead(runId)),
  );
  const transientError = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected' && isTransientRemoteError(result.reason),
  )?.reason;
  if (transientError) throw transientError;
  return unreadRunIds.filter((_, i) => results[i].status === 'fulfilled');
}

/**
 * 从调度事件投影中取出「刚完成且绑定到本会话」的 runId;不匹配返回 null。
 * 只认 terminal 状态(completed 事件带 sessionId;read/all-read 的 runPatch 无 sessionId,
 * 不会命中,因此本会话标已读后广播回来的 read 事件不会造成重复触发)。
 */
export function unreadRunIdFromProjection(
  projection: ScheduleEventProjection | null,
  sessionId: string,
): string | null {
  if (!projection || !sessionId) return null;
  const patch = projection.runPatch;
  if (patch.status !== 'terminal' || patch.sessionId !== sessionId) return null;
  return patch.runId;
}
