/**
 * 伙伴工作台工具的宿主实现:把 `botWorkbenchAccess.ts` 的纯逻辑接到真实数据源上。
 *
 * - 伙伴身份从调用方 session 反查(只认本机、在用的伙伴主任务);
 * - 已接手项目与伙伴的判断读写伙伴家的 `workbench.json`;
 * - 任务、后台任务、活动快照、例行任务与自动化都读宿主已有的权威来源,不另存状态;
 * - 本机 Claude Code / Codex 会话复用导入扫描(只读、带缓存),读转录只读文件尾部;
 *   只有伙伴继续某一件时才经设置页同一条单条导入路径导入它;
 * - 继续 / 停止复用宿主已有的发消息与优雅停止路径(与 send_to_session、
 *   stop_session_turn 同一条链路),由调用方注入。
 */
import { promises as fs } from 'node:fs';

import { and, count, desc, eq, inArray, isNotNull, isNull, like, ne, or } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botDelegations, botProfiles, botSessionLinks, messages, sessions } from '../localDb/schema.js';
import {
  getSessionImportScan,
  invalidateSessionImportScanCache,
} from '../localDb/ipc/session-import.js';
import { importExternalClaudeCodeSessions } from '../maker-host/claude-local-sessions.js';
import { importExternalCodexSessions } from '../maker-host/codex-local-sessions.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { routineTools } from '../routines/service.js';
import { getSchedulerIfInitialized } from '../scheduler-host/index.js';
import { normalizeWorkingDirForGrouping } from '../../shared/workingDir.js';
import type { WorkbenchDelegationStatus } from '../../shared/botWorkbench.js';
import {
  broadcastBotWorkbenchChanged,
  readBotWorkbenchState,
  rekeyBotWorkbenchJudgment,
  setBotWorkbenchJudgment,
} from './botWorkbenchService.js';
import { readExternalTranscript, readSessionTranscript } from './botWorkbenchTranscripts.js';
import { readCanonicalSessionActivity } from './sessionActivityProjection.js';
import {
  createBotWorkbenchAccess,
  type BotWorkbenchAccess,
  type BotWorkbenchAccessDeps,
  type WorkbenchCallerResult,
  type WorkbenchExternalCandidate,
  type WorkbenchTargetFacts,
} from './botWorkbenchAccess.js';

/** 伙伴主任务才能用工作台;远端、归档、非主任务一律拒绝。 */
async function resolveWorkbenchCaller(callerSessionId: string): Promise<WorkbenchCallerResult> {
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
  if (row.role !== 'canonical') {
    return { ok: false, errorCode: 'BOT_MAIN_TASK_REQUIRED', message: '只有伙伴的主任务可以使用工作台' };
  }
  if (row.remoteHostId) {
    return { ok: false, errorCode: 'REMOTE_WORKBENCH_UNAVAILABLE', message: '远端伙伴暂不支持工作台' };
  }
  return { ok: true, botId: row.botId };
}

async function readWorkbenchTarget(taskId: string): Promise<WorkbenchTargetFacts | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      id: sessions.id,
      status: sessions.status,
      source: sessions.source,
      remoteHostId: sessions.remoteHostId,
      workingDir: sessions.workingDir,
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
    workingDir: row.workingDir ?? null,
    orcaRole: row.orcaRole ?? null,
    botLinked: Boolean(link),
    delegationChild: Boolean(delegation),
  };
}

/**
 * 已接手项目里的候选任务。先用前缀 LIKE 缩小范围(托管 worktree 都在主仓库目录下;SQLite 的
 * LIKE 对 ASCII 不区分大小写,路径里的 `_` / `%` 只会让范围变宽),精确的项目归属由调用方
 * 用共享的归一规则再判一次,所以这里不需要转义。
 */
async function listWorkbenchProjectTasks(
  projectDirs: readonly string[],
  alwaysInclude: ReadonlySet<string>,
) {
  const prefixes = projectDirs
    .map((dir) => normalizeWorkingDirForGrouping(dir))
    .filter((dir): dir is string => Boolean(dir));
  if (prefixes.length === 0) return [];
  const db = getDbClient().drizzle;
  const hiddenIds = db.select({ id: botSessionLinks.sessionId }).from(botSessionLinks);
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      workingDir: sessions.workingDir,
      agentKind: sessions.agentKind,
      source: sessions.source,
      orcaRole: sessions.orcaRole,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
      listPreview: sessions.listPreview,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'active'),
        isNull(sessions.remoteHostId),
        isNotNull(sessions.workingDir),
        or(isNull(sessions.source), inArray(sessions.source, ['desktop', 'plugin'])),
        or(isNull(sessions.orcaRole), eq(sessions.orcaRole, 'lead')),
        or(...prefixes.map((prefix) => like(sessions.workingDir, `${prefix}%`))),
      ),
    )
    .orderBy(desc(sessions.updatedAt))
    .limit(500);
  const hidden = new Set((await hiddenIds).map((row) => row.id));
  const kept = rows
    .filter((row) => !hidden.has(row.id))
    .filter((row) => row.userSendAt != null || row.listPreview != null || alwaysInclude.has(row.id));
  const messageCounts = new Map<string, number>();
  if (kept.length > 0) {
    const counted = await db
      .select({ sessionId: messages.sessionId, total: count() })
      .from(messages)
      .where(and(
        inArray(messages.sessionId, kept.slice(0, 200).map((row) => row.id)),
        isNull(messages.rewindAt),
        inArray(messages.role, ['user', 'assistant']),
      ))
      .groupBy(messages.sessionId);
    for (const row of counted) messageCounts.set(row.sessionId, Number(row.total));
  }
  return kept
    .map((row) => ({
      id: row.id,
      title: row.title,
      workingDir: row.workingDir ?? null,
      agentKind: row.agentKind ?? null,
      summary: row.listPreview ?? null,
      lastActiveAt: row.userSendAt ?? row.updatedAt ?? null,
      messageCount: messageCounts.get(row.id) ?? null,
    }))
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
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

async function listBotRoutines(botId: string) {
  const routines = await routineTools.list(botId);
  return Promise.all(
    routines.map(async (routine) => {
      const latest = (await routineTools.history(botId, routine.id).catch(() => []))[0];
      const lastResult = latest
        ? [latest.status, latest.resultText ?? latest.error].filter(Boolean).join(': ')
        : null;
      return {
        id: routine.id,
        name: routine.name,
        enabled: routine.enabled,
        ...(routine.activity ? { activity: routine.activity } : {}),
        lastResult,
      };
    }),
  );
}

async function listProjectSchedules() {
  const scheduler = getSchedulerIfInitialized();
  if (!scheduler) return [];
  const schedules = await scheduler.list();
  return schedules.map((schedule) => ({
    id: schedule.id,
    name: schedule.name,
    status: schedule.status,
    ...(schedule.source ? { source: schedule.source } : {}),
    workspaceKind: schedule.workspaceKind,
    workingDir: schedule.workingDir ?? null,
    nextFireAt: schedule.nextFireAt ?? null,
  }));
}

/** 本机还没导入的 Claude Code / Codex 会话:复用设置页导入扫描(只读、30 秒缓存)。 */
async function listExternalCandidates(): Promise<WorkbenchExternalCandidate[]> {
  const scan = await getSessionImportScan();
  return scan.candidates.map((item) => ({
    source: item.source,
    id: item.id,
    title: item.title,
    cwd: item.cwd,
    workspaceKind: item.workspaceKind,
    updatedAt: Date.parse(item.updatedAt) || 0,
    archived: item.archived,
  }));
}

async function findImportedSession(source: 'claude' | 'codex', externalId: string): Promise<string | null> {
  const [row] = await getDbClient()
    .drizzle.select({ id: sessions.id })
    .from(sessions)
    .where(and(
      eq(sessions.sdkSessionId, externalId),
      eq(sessions.agentKind, source === 'claude' ? 'cc' : 'codex'),
      ne(sessions.status, 'deleted'),
    ))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  return row?.id ?? null;
}

/** 只导入这一条外部会话(设置页同一条导入路径),返回它在 Cindy 里的任务 id。 */
async function importExternalSession(
  source: 'claude' | 'codex',
  externalId: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; errorCode: string; message: string }> {
  try {
    if (source === 'claude') await importExternalClaudeCodeSessions([externalId]);
    else await importExternalCodexSessions([externalId]);
  } catch (error) {
    return {
      ok: false,
      errorCode: 'IMPORT_FAILED',
      message: `没能把这条本机会话接过来:${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    invalidateSessionImportScanCache();
  }
  const sessionId = await findImportedSession(source, externalId);
  return sessionId
    ? { ok: true, sessionId }
    : { ok: false, errorCode: 'IMPORT_FAILED', message: '没能把这条本机会话接过来,请让主人稍后重试' };
}

export type BotWorkbenchSendDeps = Pick<BotWorkbenchAccessDeps, 'sendToSession' | 'stopSessionTurn'>;

/**
 * 按调用时的账号作用域组装一次工具服务:作用域在调用期间切换则中止,不做投递。
 */
export function createDesktopBotWorkbenchAccess(send: BotWorkbenchSendDeps): BotWorkbenchAccess {
  const scopeKey = activeOwnerScopeKey();
  const userDataDir = ownerScopedUserDataPath();
  return createBotWorkbenchAccess({
    resolveCaller: resolveWorkbenchCaller,
    readState: (botId) => readBotWorkbenchState(userDataDir, botId),
    projectExists: async (dir) => {
      try {
        return (await fs.stat(dir)).isDirectory();
      } catch {
        return false;
      }
    },
    readTarget: readWorkbenchTarget,
    listProjectTasks: listWorkbenchProjectTasks,
    listExternalCandidates,
    findImportedSession,
    importExternal: importExternalSession,
    readSessionTranscript,
    readExternalTranscript,
    saveJudgment: (botId, taskId, judgment) => setBotWorkbenchJudgment(userDataDir, botId, taskId, judgment),
    rekeyJudgment: (botId, from, to) => rekeyBotWorkbenchJudgment(userDataDir, botId, from, to),
    notifyChanged: broadcastBotWorkbenchChanged,
    listDelegations: listBotDelegationChildren,
    readActivityPhase: async (sessionId) => (await readCanonicalSessionActivity(sessionId)).phase,
    listRoutines: listBotRoutines,
    listSchedules: listProjectSchedules,
    sendToSession: send.sendToSession,
    stopSessionTurn: send.stopSessionTurn,
    caseInsensitive: process.platform === 'win32',
    isOwnerScopeCurrent: () => !isAppSessionBoundaryPending() && activeOwnerScopeKey() === scopeKey,
  });
}

type ToolFailure = { ok: false; errorCode: string; message: string };

/** 工具入口的统一兜底:账号切换中直接拒绝,未预期异常转成 INTERNAL,不向模型抛栈。 */
export async function runBotWorkbenchTool<T>(
  send: BotWorkbenchSendDeps,
  run: (access: BotWorkbenchAccess) => Promise<T | ToolFailure>,
): Promise<T | ToolFailure> {
  if (isAppSessionBoundaryPending()) {
    return { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号正在切换,请稍后重试' };
  }
  try {
    return await run(createDesktopBotWorkbenchAccess(send));
  } catch (error) {
    return { ok: false, errorCode: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
  }
}

const NO_SEND: BotWorkbenchSendDeps = {
  sendToSession: async () => ({ ok: false, errorCode: 'UNSUPPORTED', message: 'read only' }),
  stopSessionTurn: async () => ({ ok: false, errorCode: 'UNSUPPORTED', message: 'read only' }),
};

/** 工作台详情视图(主人自己的界面)读取一件任务的最近内容;范围同样限于已接手项目。 */
export async function readBotWorkbenchTaskForOwner(botId: string, taskId: string) {
  return runBotWorkbenchTool(NO_SEND, (access) => access.readForOwner({ botId, taskId }));
}
