import {and,desc,eq,inArray,isNotNull,isNull} from 'drizzle-orm';
import type {DbClient} from '@cindy/runtime-db';
import {botDelegations,botProfiles,botSessionLinks,sessions} from '@cindy/runtime-db/schema';
import type {WorkbenchDelegationStatus} from '@cindy/companion-core/botWorkbench';
import type {createBotTaskResponsibility} from './botTaskResponsibility.js';
export interface WorkbenchTargetFacts {id:string;status:string;source:string|null;remoteHostId?:string|null;orcaRole:string|null;botLinked:boolean;delegationChild:boolean}
export function createWorkbenchAuthority(host:ReturnType<typeof createBotTaskResponsibility>&{
 getDbClient():DbClient;activeOwnerScopeKey():string;isAppSessionBoundaryPending():boolean;ownerScopedUserDataPath():string;broadcastBotWorkbenchChanged(botId:string):void;
}) {
 const {getDbClient,activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath,broadcastBotWorkbenchChanged,readTaskResponsibilities,responsibleSessionIds,setTaskResponsibility}=host;
async function readWorkbenchTarget(taskId: string): Promise<WorkbenchTargetFacts | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      id: sessions.id,
      status: sessions.status,
      source: sessions.source,
      remoteHostId: sessions.remoteHostId,
      orcaRole: sessions.orcaRole,
    })
    .from(sessions)
    .where(eq(sessions.id, taskId))
    .limit(1);
  if (!row) return null;
  const [[link], [delegation]] = await Promise.all([
    db.select({ id: botSessionLinks.id }).from(botSessionLinks).where(eq(botSessionLinks.sessionId, taskId)).limit(1),
    db.select({ id: botDelegations.id }).from(botDelegations).where(eq(botDelegations.childSessionId, taskId)).limit(1),
  ]);
  return {
    id: row.id,
    status: row.status,
    source: row.source ?? null,
    remoteHostId: row.remoteHostId ?? null,
    orcaRole: row.orcaRole ?? null,
    botLinked: Boolean(link),
    delegationChild: Boolean(delegation),
  };
}

async function listBotDelegationChildren(botId: string): Promise<Map<string, WorkbenchDelegationStatus>> {
  const rows = await getDbClient()
    .drizzle.select({
      childSessionId: botDelegations.childSessionId,
      status: botDelegations.status,
      lastError: botDelegations.lastError,
    })
    .from(botDelegations)
    .where(and(eq(botDelegations.requestingBotId, botId), isNotNull(botDelegations.childSessionId)))
    .orderBy(desc(botDelegations.createdAt));
  const out = new Map<string, WorkbenchDelegationStatus>();
  for (const row of rows) {
    if (!row.childSessionId || out.has(row.childSessionId)) continue;
    // 与后台任务卡同一口径:超时收尾在库里是 failed + TIMEOUT 前缀。
    const status = row.status === 'failed' && /^TIMEOUT(?:_|:)/i.test(row.lastError ?? '')
      ? 'timed-out'
      : (row.status as WorkbenchDelegationStatus);
    out.set(row.childSessionId, status);
  }
  return out;
}

/** Exact responsibility IDs, including archived children, without reading messages. */
async function readBotResponsibleSessionIds(userDataDir: string, botId: string): Promise<string[]> {
  return responsibleSessionIds(
    (await listBotDelegationChildren(botId)).keys(),
    await readTaskResponsibilities(userDataDir, botId),
  );
}

/**
 * The same responsibility, split: `delegatedSessionIds` are the background tasks this Bot
 * started itself (delegation children); `sessionIds` adds the ordinary tasks it explicitly
 * took over. The owner chip reads the first, the sidebar follow mark the second.
 */
async function readBotResponsibilityScope(
  userDataDir: string, botId: string,
): Promise<{ sessionIds: string[]; delegatedSessionIds: string[] }> {
  const delegated = [...(await listBotDelegationChildren(botId)).keys()].sort();
  return {
    sessionIds: responsibleSessionIds(delegated, await readTaskResponsibilities(userDataDir, botId)),
    delegatedSessionIds: delegated,
  };
}

/** Creation attribution is not workbench authorization: channel/group conversations can create tasks too. */
async function resolveBotTaskCreator(callerSessionId: string): Promise<string | null> {
  const [row] = await getDbClient().drizzle
    .select({ botId: botSessionLinks.botId })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(
      eq(botSessionLinks.sessionId, callerSessionId),
      inArray(botSessionLinks.role, ['canonical', 'thread', 'channel', 'group']),
      isNull(botSessionLinks.archivedAt),
      eq(sessions.source, 'bot'),
      eq(sessions.status, 'active'),
      isNull(sessions.remoteHostId),
      eq(botProfiles.status, 'active'),
    ))
    .limit(1);
  return row?.botId ?? null;
}

/** Capture the creator before a generic create-mode handoff crosses async boundaries. */
async function captureBotCreatedTaskResponsibility(callerSessionId?: string) {
  if (!callerSessionId || isAppSessionBoundaryPending()) return null;
  const scope = activeOwnerScopeKey();
  const root = ownerScopedUserDataPath();
  const botId = await resolveBotTaskCreator(callerSessionId);
  if (!botId) return null;
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) throw new Error('OWNER_SCOPE_CHANGED');
  };
  assertCurrent();
  return async (sessionId: string) => {
    assertCurrent();
    const target = await readWorkbenchTarget(sessionId);
    if (!target || target.status !== 'active' || target.botLinked || target.remoteHostId || target.orcaRole === 'worker') return;
    assertCurrent();
    await setTaskResponsibility(root, botId, sessionId, true, assertCurrent);
    broadcastBotWorkbenchChanged(botId);
  };
}


return {readWorkbenchTarget,listBotDelegationChildren,readBotResponsibleSessionIds,readBotResponsibilityScope,captureBotCreatedTaskResponsibility};
}
