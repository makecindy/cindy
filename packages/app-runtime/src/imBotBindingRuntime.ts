import { eq } from 'drizzle-orm';
import type { DbClient } from '@cindy/runtime-db';
import { botProfiles, sessions } from '@cindy/runtime-db/schema';
import type { createBotProfileService } from './botProfileService.js';
import type { createBotCanonicalSessionRegistry } from './botCanonicalSessionRegistry.js';
import type { BotDelegationService } from './botDelegationService.js';
import type { ImCompanionRouteDeps, ImCompanionSessionResult } from '@cindy/im-runtime/imBotBindingRoute';

export function createImBotBindingRuntime(host: Pick<ReturnType<typeof createBotProfileService>, 'archiveBotChannelLanes' | 'ensureBotChannelLaneSession' | 'findBotChannelLaneSession'> &
  Pick<ReturnType<typeof createBotCanonicalSessionRegistry>, 'resolveBotCanonicalSession'> & {
  getDbClient(): DbClient;
  tryGetBotDelegationService(): Pick<BotDelegationService, 'ensureCanonicalSession'> | null;
  prepareBotSessionForImSend(sessionId: string): Promise<string | null>;
}) {
const {getDbClient, archiveBotChannelLanes, ensureBotChannelLaneSession, findBotChannelLaneSession,
  resolveBotCanonicalSession, tryGetBotDelegationService, prepareBotSessionForImSend}=host;
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

function createImCompanionRouteDeps(ownerBotId: string | (() => string | null)): ImCompanionRouteDeps {
  return {
    readBinding: () => typeof ownerBotId === 'function' ? ownerBotId() : ownerBotId,

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

return {createImCompanionRouteDeps};
}
