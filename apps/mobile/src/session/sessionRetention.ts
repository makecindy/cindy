import type { RemoteSession } from '@/session/types';

/**
 * Mobile 消息驻留策略由任务创建来源和用户是否打开过详情决定。
 *
 * `source` 缺失时保守按普通任务处理：宁可多驻留，也不能因为标题、schedule
 * 索引等可变/晚到信息误回收用户任务。schedule 绑定既有任务时不会改写 source，
 * 因而仍属于 regular。定时任务一旦被用户打开查看，就与普通任务一致，切后台
 * 或离开详情不再整窗回收。
 */
export type SessionRetentionKind = 'regular' | 'schedule';

export function classifySessionRetention(
  session: Pick<RemoteSession, 'source'> | null | undefined,
  openedInDetail = false,
): SessionRetentionKind {
  return session?.source === 'scheduler' && !openedInDetail ? 'schedule' : 'regular';
}
