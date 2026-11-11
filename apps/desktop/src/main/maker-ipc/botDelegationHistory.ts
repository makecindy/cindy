/**
 * Read-only access to the V1 teammate background tasks ("delegations") already in
 * `bot_delegations`. Nothing creates, advances or settles these rows any more: V2 teammates
 * open ordinary tasks with send_to_session. The rows keep old task cards, glance outputs and
 * the "opened by this teammate" mark of old children readable. A row that was still running
 * at upgrade keeps its stored status; its child is an ordinary task now.
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botDelegations, botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import type {
  BotDelegationArtifact,
  BotDelegationListResult,
  BotDelegationStatus,
  BotDelegationView,
} from '../../shared/botDelegation.js';

type DelegationRow = typeof botDelegations.$inferSelect;

function parseJson(value: string | null | undefined, fallback: unknown): unknown {
  try { return JSON.parse(value ?? '') as unknown; } catch { return fallback; }
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  const parsed = parseJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseStringArray(value: string | null | undefined): string[] {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function parseArtifacts(value: string | null | undefined): BotDelegationArtifact[] {
  const parsed = parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const artifact = item as Partial<BotDelegationArtifact> | null;
    return artifact && typeof artifact === 'object'
      && typeof artifact.path === 'string' && typeof artifact.absolutePath === 'string'
      && ['added', 'modified', 'deleted', 'renamed'].includes(artifact.status ?? '')
      ? [artifact as BotDelegationArtifact] : [];
  });
}

/** Timeouts were stored as failed + a TIMEOUT error; cards show them as timed out. */
function viewStatus(row: Pick<DelegationRow, 'status' | 'lastError'>): BotDelegationStatus {
  return row.status === 'failed' && /^TIMEOUT(?:_|:)/i.test(row.lastError ?? '') ? 'timed-out' : row.status;
}

/**
 * The tasks shown in one teammate conversation: its main chat sees all of the teammate's tasks,
 * a private-chat topic or a group lane only the ones started there. History links read too, so
 * archived chats keep their saved titles.
 */
export async function listBotDelegationHistory(callerSessionId: string): Promise<BotDelegationListResult> {
  const db = getDbClient().drizzle;
  const [caller] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      routeKey: botSessionLinks.routeKey,
      sessionStatus: sessions.status,
      sessionSource: sessions.source,
      profileStatus: botProfiles.status,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(eq(botSessionLinks.sessionId, callerSessionId))
    .limit(1);
  if (!caller
    || caller.sessionSource !== 'bot'
    || (caller.sessionStatus !== 'active' && caller.sessionStatus !== 'archived')
    || caller.profileStatus === 'deleting'
    || !['canonical', 'history', 'thread', 'routine', 'delegation', 'group'].includes(caller.role)) {
    return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
  }
  const originRoute = caller.role === 'group' ? '$.groupOriginRoute' : caller.role === 'thread' ? '$.threadOriginRoute' : null;
  const rows = await db
    .select()
    .from(botDelegations)
    .where(and(
      eq(botDelegations.requestingBotId, caller.botId),
      originRoute
        ? sql`CASE WHEN json_valid(${botDelegations.permissionSnapshotJson}) THEN
            json_extract(${botDelegations.permissionSnapshotJson}, ${originRoute}) = ${caller.routeKey}
            ELSE 0 END`
        : undefined,
    ))
    .orderBy(desc(botDelegations.createdAt));
  const targetIds = [...new Set(rows.flatMap((row) => row.targetBotId ? [row.targetBotId] : []))];
  const childIds = rows.flatMap((row) => row.childSessionId ? [row.childSessionId] : []);
  const [profiles, children] = await Promise.all([
    targetIds.length
      ? db.select({ id: botProfiles.id, displayName: botProfiles.displayName }).from(botProfiles).where(inArray(botProfiles.id, targetIds))
      : [],
    childIds.length
      ? db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(inArray(sessions.id, childIds))
      : [],
  ]);
  const names = new Map(profiles.map((profile) => [profile.id, profile.displayName]));
  const titles = new Map(children.map((child) => [child.id, child.title]));
  const firstLine = (row: DelegationRow) => row.objective.trim().split('\n')[0] ?? '';
  return {
    ok: true,
    delegations: rows.map((row): BotDelegationView => ({
      id: row.id,
      requestingBotId: row.requestingBotId,
      targetBotId: row.targetBotId,
      targetBotName: row.targetBotId ? (names.get(row.targetBotId) ?? row.targetBotId) : 'Cindy',
      parentSessionId: row.parentSessionId,
      childSessionId: row.childSessionId,
      title: row.childSessionId ? (titles.get(row.childSessionId) ?? firstLine(row)) : firstLine(row),
      objective: row.objective,
      contextRefs: parseStringArray(row.contextRefsJson),
      permissionSnapshot: parseRecord(row.permissionSnapshotJson),
      lineage: parseStringArray(row.lineageJson),
      targetProfileVersion: row.targetProfileVersion,
      depth: row.depth,
      status: viewStatus(row),
      // Waiting was live-only; nothing answers through these rows any more.
      pendingInteraction: null,
      resultSummary: row.resultSummary,
      artifacts: parseArtifacts(row.outputArtifactsJson),
      lastError: row.lastError,
      createdAt: row.createdAt,
      acceptedAt: row.acceptedAt,
      completedAt: row.completedAt,
      updatedAt: row.updatedAt,
    })),
  };
}

/** Children this teammate started as V1 background tasks; they stay "opened by this teammate". */
export async function listBotDelegationChildIds(botId: string): Promise<string[]> {
  const rows = await getDbClient().drizzle
    .select({ childSessionId: botDelegations.childSessionId })
    .from(botDelegations)
    .where(and(eq(botDelegations.requestingBotId, botId), isNotNull(botDelegations.childSessionId)));
  return [...new Set(rows.flatMap((row) => row.childSessionId ? [row.childSessionId] : []))].sort();
}

/** An old background task created with an explicit model keeps it: no automatic model fallback. */
export async function hasExplicitSessionTaskModel(sessionId: string): Promise<boolean> {
  const [row] = await getDbClient().drizzle
    .select({ permissionSnapshotJson: botDelegations.permissionSnapshotJson })
    .from(botDelegations)
    .where(eq(botDelegations.childSessionId, sessionId))
    .limit(1);
  return !!parseRecord(row?.permissionSnapshotJson).taskModelOverride;
}
