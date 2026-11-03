/**
 * 私聊话题（docs/product-rules/cindy-bots-runtime.md「私聊话题」）。
 *
 * 主人在与伙伴的私聊里对某条消息开话题：宿主为「这条消息 × 这位伙伴」另开一条隐藏 Session，
 * `bot_session_links.role = 'thread'`，`route_key = 'dm-thread:<根消息所在 Session>:<根消息 clientId>'`。
 * 话题 Session 与主任务同一 Profile、Home、模型链与权限档，只有上下文是自己的。
 */

export const BOT_DM_THREAD_ROUTE_PREFIX = 'dm-thread:';

/**
 * Session id 不含冒号，所以第一个冒号之后都是 clientId；clientId 本身可以带冒号
 * （例如伙伴开场白 `bot-opening:<id>`、定时任务结果 `schedule-result:<id>`）。
 */
const SESSION_PART = /^[^:\s]{1,128}$/;
const CLIENT_PART = /^\S{1,256}$/;

export function botDmThreadRouteKey(rootSessionId: string, rootClientId: string): string {
  if (!SESSION_PART.test(rootSessionId) || !CLIENT_PART.test(rootClientId)) {
    throw new Error('Invalid private-chat topic root');
  }
  return `${BOT_DM_THREAD_ROUTE_PREFIX}${rootSessionId}:${rootClientId}`;
}

export function parseBotDmThreadRouteKey(
  routeKey: string | null | undefined,
): { rootSessionId: string; rootClientId: string } | null {
  if (!routeKey?.startsWith(BOT_DM_THREAD_ROUTE_PREFIX)) return null;
  const rest = routeKey.slice(BOT_DM_THREAD_ROUTE_PREFIX.length);
  const split = rest.indexOf(':');
  if (split <= 0) return null;
  const rootSessionId = rest.slice(0, split);
  const rootClientId = rest.slice(split + 1);
  if (!SESSION_PART.test(rootSessionId) || !CLIENT_PART.test(rootClientId)) return null;
  return { rootSessionId, rootClientId };
}

export type { BotDmThreadSummary } from '@cindy/maker-shared';
