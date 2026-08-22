import { getDeviceId } from '../../authManager.js';
import { getDbClient } from '../../localDb/client/current.js';
import {
  ensureBotRouteSession,
  resolveOrCreateBotRoute,
} from '../../localDb/botRouteService.js';
import { sessions } from '../../localDb/schema.js';
import type { BotRouteSource } from '../../../shared/botRoute.js';
import { toCoreAgentKind } from './sessionRepo.js';
import type { RouteTarget } from './turnRunner.js';
import { eq } from 'drizzle-orm';
export { botRouteSourceForMessage } from './botRouteSource.js';

async function toRouteTarget(args: {
  sessionId: string;
  scopeKey?: string;
  created: boolean;
}): Promise<RouteTarget> {
  const [row] = await getDbClient()
    .drizzle.select()
    .from(sessions)
    .where(eq(sessions.id, args.sessionId))
    .limit(1);
  if (!row?.workingDir || row.source !== 'bot' || row.status !== 'active') {
    throw new Error('Bot Route task is unavailable after resolution');
  }
  return {
    row: {
      id: row.id,
      agentKind: toCoreAgentKind(row.agentKind),
      workingDir: row.workingDir,
      model: row.model,
      effort: row.effort,
      permissionMode: row.permissionMode,
      fastMode: row.fastMode,
      sdkSessionId: row.sdkSessionId,
      providerId: row.providerId ?? null,
      workspaceKind: row.workspaceKind,
    },
    attached: false,
    botRoute: true,
    scopeKey: args.scopeKey,
    created: args.created,
  };
}

export async function resolveBotImRouteTarget(args: {
  source: BotRouteSource;
  scopeKey?: string;
}): Promise<RouteTarget | null> {
  const route = await resolveOrCreateBotRoute(args.source);
  if (!route) return null;
  const ensured = await ensureBotRouteSession({
    routeId: route.id,
    ownerDeviceId: getDeviceId(),
  });
  return toRouteTarget({
    sessionId: ensured.sessionId,
    scopeKey: args.scopeKey,
    created: ensured.created,
  });
}

export async function renewBotImRouteTarget(args: {
  source: BotRouteSource;
  scopeKey?: string;
}): Promise<{ target: RouteTarget; previousSessionId?: string } | null> {
  const route = await resolveOrCreateBotRoute(args.source);
  if (!route) return null;
  const ensured = await ensureBotRouteSession({
    routeId: route.id,
    ownerDeviceId: getDeviceId(),
    forceRenew: true,
  });
  return {
    target: await toRouteTarget({
      sessionId: ensured.sessionId,
      scopeKey: args.scopeKey,
      created: true,
    }),
    ...(route.currentSessionId ? { previousSessionId: route.currentSessionId } : {}),
  };
}
