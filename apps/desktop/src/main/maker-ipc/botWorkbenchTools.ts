/**
 * 伙伴工作台工具的宿主实现:把 `botWorkbenchAccess.ts` 的纯逻辑接到真实数据源上。
 *
 * - 伙伴身份从调用方 session 反查(只认本机、在用的伙伴主任务);
 * - 「一眼」与总调度身份读宿主观察层(`botWorkbenchAutonomyBridge.ts`),这里不另存状态;
 * - 逐任务责任读伙伴家的 task-responsibility 与它自己开的后台任务(bot_delegations);
 * - 继续复用宿主已有的发消息路径(本机 = send_to_session 同一条链路;另一台电脑 =
 *   跨电脑 send_to_session 的同一条通路),由调用方注入;停止走通用的 stop_session_turn。
 * 项目关联只提供按需阅读的入口，不按目录发现候选任务或导入本机外部会话。
 */
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { hasTaskActionAuthorization, assertTaskActionCurrent, captureTaskActionSyncGuard } from './taskActionAuthorization.js';

import { getDbClient } from '../localDb/client/current.js';
import { botDelegations, botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import type { WorkbenchDelegationStatus, WorkbenchTranscriptItem } from '../../shared/botWorkbench.js';
import { broadcastBotWorkbenchChanged } from './botWorkbenchService.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import { botLinkedProjectAccess } from './botLinkedProjects.js';
import { boundTranscript, readSessionTranscript } from './botWorkbenchTranscripts.js';
import { readTaskResponsibilities, responsibleSessionIds, setTaskResponsibility } from './botTaskResponsibility.js';
import { readBotGlance, readSchedulerBotId, readWatchedSession } from './botWorkbenchAutonomyBridge.js';
import {
  createBotWorkbenchAccess,
  type BotWorkbenchAccess,
  type BotWorkbenchAccessDeps,
  type WorkbenchCallerResult,
  type WorkbenchTargetFacts,
} from './botWorkbenchAccess.js';

/** 伙伴主任务才能用工作台;远端、归档、非主任务一律拒绝。 */
export async function resolveWorkbenchCaller(callerSessionId: string): Promise<WorkbenchCallerResult> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      sessionStatus: sessions.status,
      remoteHostId: sessions.remoteHostId,
      profileStatus: botProfiles.status,
      linkArchivedAt: botSessionLinks.archivedAt,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(eq(botSessionLinks.sessionId, callerSessionId), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row) return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前任务不属于任何伙伴' };
  if (row.sessionStatus !== 'active' || row.profileStatus !== 'active' || row.linkArchivedAt !== null) {
    return { ok: false, errorCode: 'BOT_SESSION_INACTIVE', message: '伙伴或它的主任务已停用' };
  }
  if (row.role !== 'canonical' && row.role !== 'thread') {
    return {
      ok: false,
      errorCode: 'BOT_MAIN_TASK_REQUIRED',
      message: '当前入口不是伙伴的私聊主任务或私聊话题，不能使用工作台、待办或项目关联工具。'
        + '本次调用未读取或修改这些记录。请告知主人：在 Cindy 中打开这位伙伴的私聊主聊天（主任务），在那里提出本次请求；私聊话题也可用。'
        + '不要在当前入口重试。',
    };
  }
  if (row.remoteHostId) {
    return { ok: false, errorCode: 'REMOTE_WORKBENCH_UNAVAILABLE', message: '远端伙伴暂不支持工作台' };
  }
  return { ok: true, botId: row.botId };
}

/** Query context only. The workbench authorization and task responsibility remain untouched. */
export async function runBotProjectsTool(params: {
  callerSessionId: string; projectId?: string; linked?: boolean; includeAvailable?: boolean;
}) {
  const owner = activeOwnerScopeKey();
  try {
    if (isAppSessionBoundaryPending()) throw new Error('OWNER_SCOPE_CHANGED');
    const caller = await resolveWorkbenchCaller(params.callerSessionId);
    if (!caller.ok) return caller;
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('OWNER_SCOPE_CHANGED');
    const access = await botLinkedProjectAccess(caller.botId);
    let projects;
    if (params.projectId !== undefined) {
      if (typeof params.linked !== 'boolean' || !hasTaskActionAuthorization(params.callerSessionId))
        return { ok: false as const, errorCode: 'TASK_ACTION_AUTHORIZATION_REQUIRED', message: 'Changing project links requires authorization.' };
      await assertTaskActionCurrent();
      projects = await access.set(params.projectId, params.linked, captureTaskActionSyncGuard());
    } else projects = await access.read();
    return { ok: true as const, projects: projects.filter(project => project.linked || params.includeAvailable).map(project => ({
      project_id: project.id, name: project.name, working_dir: project.path,
      device_id: project.deviceId ?? null, linked: project.linked, available_locally: project.available,
      // These are locations to check on demand, not promises that the files exist.
      ...(!project.deviceId && project.available ? { context_locations: ['AGENTS.md', 'CLAUDE.md', 'README.md', '.cindy/project-knowledge/TOC.md'] } : {}),
    })) };
  } catch {
    return { ok: false as const, errorCode: 'PROJECTS_UNAVAILABLE', message: 'Could not read or save project links. Re-read the saved state before retrying.' };
  }
}

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
export async function readBotResponsibleSessionIds(userDataDir: string, botId: string): Promise<string[]> {
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
export async function readBotResponsibilityScope(
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
export async function captureBotCreatedTaskResponsibility(callerSessionId?: string) {
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
    // Remote task rows draw the same mark from the teammate roster's links.
    broadcastBotRemoteResourceChanged(botId);
  };
}

type Failure = { ok: false; errorCode: string; message: string };

/**
 * 投递与跨电脑读取由调用方注入(与 send_to_session、get_chat_history 同一条宿主路径)。
 * 渲染层只读入口不注入(NO_HOST):跨电脑读取返回明确错误。
 */
export interface BotWorkbenchHostDeps {
  sendToSession: BotWorkbenchAccessDeps['sendToSession'];
  sendToRemoteSession: BotWorkbenchAccessDeps['sendToRemoteSession'];
  /** 另一台电脑上一件任务最近的用户 / 助手文字(按时间正序)。 */
  readRemoteMessages(deviceId: string, sessionId: string): Promise<{ ok: true; items: WorkbenchTranscriptItem[] } | Failure>;
}

/** Desktop sidebar marks re-read the scopes; remote task rows re-read the teammate roster links. */
function broadcastResponsibilityChanged(botId: string): void {
  broadcastBotWorkbenchChanged(botId);
  broadcastBotRemoteResourceChanged(botId);
}

/**
 * 按调用时的账号作用域组装一次工具服务:作用域在调用期间切换则中止,不做投递。
 */
function createDesktopBotWorkbenchAccess(host: BotWorkbenchHostDeps): BotWorkbenchAccess {
  const scopeKey = activeOwnerScopeKey();
  const userDataDir = ownerScopedUserDataPath();
  return createBotWorkbenchAccess({
    hasActionAuthorization: hasTaskActionAuthorization,
    resolveCaller: resolveWorkbenchCaller,
    schedulerBotId: readSchedulerBotId,
    readWatched: readWatchedSession,
    readTarget: readWorkbenchTarget,
    readGlance: readBotGlance,
    readSessionTranscript,
    readRemoteTranscript: async (deviceId, sessionId) => {
      const result = await host.readRemoteMessages(deviceId, sessionId);
      return result.ok ? { ok: true as const, transcript: boundTranscript(result.items) } : result;
    },
    notifyChanged: broadcastResponsibilityChanged,
    listDelegations: listBotDelegationChildren,
    readResponsibleSessionIds: (botId) => readBotResponsibleSessionIds(userDataDir, botId),
    saveResponsibility: (botId, sessionId, responsible) => setTaskResponsibility(
      userDataDir, botId, sessionId, responsible, () => {
        if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) throw new Error('OWNER_SCOPE_CHANGED');
      },
    ),
    sendToSession: async params => { await assertTaskActionCurrent(); return host.sendToSession(params); },
    sendToRemoteSession: async params => { await assertTaskActionCurrent(); return host.sendToRemoteSession(params); },
    isOwnerScopeCurrent: () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === scopeKey,
  });
}

/** 工具入口的统一兜底:账号切换中直接拒绝,未预期异常转成 INTERNAL,不向模型抛栈。 */
export async function runBotWorkbenchTool<T>(
  host: BotWorkbenchHostDeps,
  run: (access: BotWorkbenchAccess) => Promise<T | Failure>,
): Promise<T | Failure> {
  if (isAppSessionBoundaryPending()) {
    return { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号正在切换,请稍后重试' };
  }
  try {
    return await run(createDesktopBotWorkbenchAccess(host));
  } catch (error) {
    return { ok: false, errorCode: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
  }
}

const readOnly: Failure = { ok: false, errorCode: 'UNSUPPORTED', message: 'read only' };
const NO_HOST: BotWorkbenchHostDeps = {
  sendToSession: async () => readOnly,
  sendToRemoteSession: async () => readOnly,
  readRemoteMessages: async () => ({
    ok: false,
    errorCode: 'REMOTE_UNAVAILABLE',
    message: '另一台电脑上的任务请直接打开那件任务查看',
  }),
};

/** 工作台详情视图(主人自己的界面)读取一件任务的最近内容;与伙伴工具同一条授权规则。 */
/** Host gate: a teammate acting on its own may only adjust tasks handed to it. */
export async function canBotContinueWorkbenchTask(callerSessionId: string, taskId: string): Promise<boolean> {
  const result = await runBotWorkbenchTool(NO_HOST, async (access) => ({
    ok: true as const,
    allowed: await access.canContinue({ callerSessionId, taskId }),
  }));
  return result.ok && result.allowed;
}

export async function readBotWorkbenchTaskForOwner(botId: string, taskId: string) {
  return runBotWorkbenchTool(NO_HOST, (access) => access.readForOwner({ botId, taskId }));
}
