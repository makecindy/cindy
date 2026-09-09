import type { RemoteSession } from '@/session/types';

/**
 * Mobile 消息驻留策略只由任务创建来源决定。
 *
 * `source` 缺失时保守按普通任务处理：宁可多驻留，也不能因为标题、schedule
 * 索引等可变/晚到信息误回收用户任务。schedule 绑定既有任务时不会改写 source，
 * 因而仍属于 regular。
 */
export type SessionRetentionKind = 'regular' | 'schedule';

export function classifySessionRetention(
  session: Pick<RemoteSession, 'source'> | null | undefined,
): SessionRetentionKind {
  return session?.source === 'scheduler' ? 'schedule' : 'regular';
}
