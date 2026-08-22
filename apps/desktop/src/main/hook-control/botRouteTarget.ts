/** Bot Route adapter for server-relayed Telegram and Slack Bots. */

import { eq } from 'drizzle-orm';

import { getDeviceId } from '../authManager.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  ensureBotRouteSession,
  resolveOrCreateBotRoute,
} from '../localDb/botRouteService.js';
import { sessions } from '../localDb/schema.js';
import type { BotRouteSource } from '../../shared/botRoute.js';
import type { TaskSource } from '@cindy/slack-hook-protocol';

export interface HookBotRouteTarget {
  sessionId: string;
  workingDir: string;
}

/**
 * Decodes only the official relay shapes and fails closed for legacy/unknown
 * keys. The route identity intentionally excludes the relay generation and
 * sender principal: it is the configured bot account plus chat/topic.
 */
export function telegramBotRouteSourceFromExternalKey(externalKey: string): BotRouteSource | null {
  const parts = externalKey.split(':');
  if (parts[0] !== 'telegram') return null;
  const kind = parts[1];
  const accountKey = parts[2]?.trim() ?? '';
  const principalKey = parts[3]?.trim() ?? '';
  if (!accountKey || !principalKey) return null;
  const last = parts.length - 1;
  const terminal = /^g\d+$/.test(parts[last] ?? '') ? last - 1 : last;
  if (kind === 'dm') {
    if (terminal < 3) return null;
    return {
      platform: 'telegram', accountKey, scopeKey: accountKey, principalKey, deliveryKey: externalKey,
    };
  }
  if (kind === 'group') {
    if (terminal <= 3) return null;
    return {
      platform: 'telegram', accountKey, scopeKey: accountKey, principalKey, deliveryKey: externalKey,
    };
  }
  if (kind === 'topic') {
    const threadKey = parts[4]?.trim() ?? '';
    if (!threadKey || terminal <= 4) return null;
    return {
      platform: 'telegram', accountKey, scopeKey: accountKey, principalKey,
      parentPrincipalKey: principalKey, threadKey, deliveryKey: externalKey,
    };
  }
  return null;
}

const SLACK_ID = /^[A-Z][A-Z0-9]*$/;
const SLACK_TS = /^\d+(?:\.\d+)?$/;
const ROUTE_GENERATION = /^g\d+$/;

function sourceSlackTeamId(source?: TaskSource): string {
  if (source?.im !== 'slack') return '';
  const teamId = source.teamId?.trim() ?? '';
  return SLACK_ID.test(teamId) ? teamId : '';
}

/**
 * Production Slack keys are owned by slack-hook-server:
 *   - slack:<teamId>:<channelId>:<threadRootTs>
 *   - slack:dm:<teamId>:<userId>:g<generation>
 *
 * Older servers used a provider prefix without the team id.  Those keys are
 * accepted only when the signed task source supplies the missing Slack team;
 * source-less legacy keys stay on the existing binding path instead of being
 * guessed into a Bot Route.
 */
export function slackBotRouteSourceFromExternalKey(
  externalKey: string,
  source?: TaskSource,
): BotRouteSource | null {
  const parts = externalKey.split(':');
  if (parts[0] === 'slack' && parts[1] === 'dm') {
    const teamId = parts[2]?.trim() ?? '';
    const userId = parts[3]?.trim() ?? '';
    const generation = parts[4]?.trim() ?? '';
    if (
      parts.length !== 5
      || !SLACK_ID.test(teamId)
      || !SLACK_ID.test(userId)
      || !ROUTE_GENERATION.test(generation)
    ) {
      return null;
    }
    return {
      platform: 'slack',
      accountKey: teamId,
      scopeKey: teamId,
      principalKey: userId,
      deliveryKey: externalKey,
    };
  }

  if (parts[0] === 'slack') {
    const teamId = parts[1]?.trim() ?? '';
    const channelId = parts[2]?.trim() ?? '';
    const threadTs = parts[3]?.trim() ?? '';
    if (
      parts.length !== 4
      || !SLACK_ID.test(teamId)
      || !SLACK_ID.test(channelId)
      || !SLACK_TS.test(threadTs)
    ) {
      return null;
    }
    return {
      platform: 'slack',
      accountKey: teamId,
      scopeKey: teamId,
      principalKey: channelId,
      parentPrincipalKey: channelId,
      threadKey: threadTs,
      deliveryKey: externalKey,
    };
  }

  if (parts[0] === 'team-slack') {
    const teamId = sourceSlackTeamId(source);
    const channelId = parts[1]?.trim() ?? '';
    const threadTs = parts[2]?.trim() ?? '';
    if (
      parts.length !== 3
      || !teamId
      || !SLACK_ID.test(channelId)
      || !SLACK_TS.test(threadTs)
    ) {
      return null;
    }
    return {
      platform: 'slack',
      accountKey: teamId,
      scopeKey: teamId,
      principalKey: channelId,
      parentPrincipalKey: channelId,
      threadKey: threadTs,
      deliveryKey: externalKey,
    };
  }

  // Pre-provider-prefix channel key: <teamId>:<channelId>:<threadRootTs>.
  const teamId = parts[0]?.trim() ?? '';
  const channelId = parts[1]?.trim() ?? '';
  const threadTs = parts[2]?.trim() ?? '';
  if (
    parts.length === 3
    && SLACK_ID.test(teamId)
    && SLACK_ID.test(channelId)
    && SLACK_TS.test(threadTs)
    && (source === undefined || source.im === 'slack')
  ) {
    return {
      platform: 'slack',
      accountKey: teamId,
      scopeKey: teamId,
      principalKey: channelId,
      parentPrincipalKey: channelId,
      threadKey: threadTs,
      deliveryKey: externalKey,
    };
  }
  return null;
}

export function hookBotRouteSourceFromExternalKey(
  externalKey: string,
  source?: TaskSource,
): BotRouteSource | null {
  return telegramBotRouteSourceFromExternalKey(externalKey)
    ?? slackBotRouteSourceFromExternalKey(externalKey, source);
}

async function readTarget(routeId: string, forceRenew = false): Promise<HookBotRouteTarget> {
  const ensured = await ensureBotRouteSession({ routeId, ownerDeviceId: getDeviceId(), forceRenew });
  const [row] = await getDbClient().drizzle
    .select({ id: sessions.id, workingDir: sessions.workingDir, source: sessions.source, status: sessions.status })
    .from(sessions).where(eq(sessions.id, ensured.sessionId)).limit(1);
  if (!row?.workingDir || row.source !== 'bot' || row.status !== 'active') {
    throw new Error('Bot Route task is unavailable after resolution');
  }
  return { sessionId: row.id, workingDir: row.workingDir };
}

export async function resolveHookBotRouteTarget(
  externalKey: string,
  taskSource?: TaskSource,
): Promise<HookBotRouteTarget | null> {
  const routeSource = hookBotRouteSourceFromExternalKey(externalKey, taskSource);
  if (!routeSource) return null;
  const route = await resolveOrCreateBotRoute(routeSource);
  return route ? readTarget(route.id) : null;
}

/** `/new` renews a mounted Route, never an unrelated legacy binding. */
export async function renewHookBotRouteTarget(externalKey: string): Promise<HookBotRouteTarget | null> {
  const routeSource = hookBotRouteSourceFromExternalKey(externalKey);
  if (!routeSource) return null;
  const route = await resolveOrCreateBotRoute(routeSource);
  return route ? readTarget(route.id, true) : null;
}
