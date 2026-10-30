/**
 * main/im/shared/imBotBindingRuntime.ts
 * ---------------------------------------------------------------------------
 * 伙伴自有 IM 连接的落点路由(注入给 turnRunner, 契约见 imBotBindingRoute.ts)。
 *
 *   - 主人私聊 → 伙伴主任务: 复用伙伴消息服务的 ensureCanonicalSession(唯一的
 *     主任务恢复入口, 健康主任务不会被覆盖);
 *   - 群 / 话题 / 外部用户私聊 → bots.ts 的 channel 专线(幂等创建);
 *   - 发送前守卫 → register.ts 的 prepareBotSessionForImSend(与桌面发送同源)。
 *
 * 独立连接使用固定归属；个人微信单实例通过回调读取当前伙伴归属。
 */

import { eq } from 'drizzle-orm';

import { getDbClient } from '../../localDb/client/current';
import {
  archiveBotChannelLanes,
  ensureBotChannelLaneSession,
  findBotChannelLaneSession,
} from '../../localDb/ipc/bots';
import { botProfiles, sessions } from '../../localDb/schema';
import { resolveBotCanonicalSession } from '../../maker-ipc/botCanonicalSessionRegistry';
import { prepareBotSessionForImSend, tryGetBotDelegationService } from '../../maker-ipc/register';
import type { ImCompanionRouteDeps, ImCompanionSessionResult } from './imBotBindingRoute';

async function readProfileStatus(botId: string): Promise<string | null> {
  const [row] = await getDbClient()
    .drizzle.select({ status: botProfiles.status })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  return row?.status ?? null;
}

async function isActiveSession(sessionId: string): Promise<boolean> {
  const [row] = await getDbClient()
    .drizzle.select({ status: sessions.status, source: sessions.source })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row?.status === 'active' && row.source === 'bot';
}

export function createImCompanionRouteDeps(ownerBotId: string | ((botContextId: string, userId?: string) => string | null)): ImCompanionRouteDeps {
  return {
    readBinding: (contextId, userId) => typeof ownerBotId === 'function' ? ownerBotId(contextId, userId) : ownerBotId,

    async resolveSession({ botId, target, create }): Promise<ImCompanionSessionResult | null> {
      if (!create) {
        // 只查已有任务: 伙伴不可用时报不可用(调用方回落渠道自己的路由), 可用但
        // 还没有这条任务时返回 null(调用方不建行)。
        const status = await readProfileStatus(botId);
        if (status !== 'active') {
          return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: `bot status ${status ?? 'missing'}` };
        }
        if (target.kind === 'canonical') {
          const registered = await resolveBotCanonicalSession(botId);
          if (registered.status !== 'resolved') return null;
          return (await isActiveSession(registered.sessionId))
            ? { ok: true, sessionId: registered.sessionId, created: false }
            : null;
        }
        const sessionId = await findBotChannelLaneSession(botId, target.routeKey);
        return sessionId ? { ok: true, sessionId, created: false } : null;
      }
      if (target.kind === 'canonical') {
        const service = tryGetBotDelegationService();
        if (!service) {
          return { ok: false, errorCode: 'DELEGATION_UNAVAILABLE', message: '伙伴消息服务尚未就绪' };
        }
        const ensured = await service.ensureCanonicalSession(botId);
        return ensured.ok
          ? { ok: true, sessionId: ensured.sessionId, created: false }
          : { ok: false, errorCode: ensured.errorCode, message: ensured.message };
      }
      const lane = await ensureBotChannelLaneSession({
        botId,
        routeKey: target.routeKey,
        title: target.title,
      });
      return lane.ok
        ? { ok: true, sessionId: lane.sessionId, created: lane.created }
        : { ok: false, errorCode: lane.errorCode, message: lane.message };
    },

    archiveLane: (routeKey) => archiveBotChannelLanes({ routeKey }),

    prepareSend: (sessionId) => prepareBotSessionForImSend(sessionId),
  };
}
