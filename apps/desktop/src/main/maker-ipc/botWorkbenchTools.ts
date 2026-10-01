/**
 * 伙伴工作台工具的宿主实现:把 `botWorkbenchAccess.ts` 的纯逻辑接到真实数据源上。
 *
 * - 伙伴身份从调用方 session 反查(只认本机、在用的伙伴主任务);
 * - 已接手项目与伙伴的判断读写伙伴家的 `workbench.json`;
 * - 任务、后台任务、活动快照、例行任务与自动化都读宿主已有的权威来源,不另存状态;
 * - 本机 Claude Code / Codex / Pi 会话按固定的转录目录发现(`botWorkbenchSessionRoots.ts`),只看近期、
 *   只读头尾;只有伙伴继续某一件时才经设置页同一条单条导入路径导入它(Pi 与导入不了的改开后台任务);
 * - 项目素材 brief(文档路径、git、GitHub PR / issue)宿主现算、有界、带缓存;
 * - 继续复用宿主已有的发消息路径(与 send_to_session 同一条链路),由调用方注入;停止走通用的
 *   stop_session_turn,不再有工作台专属的停止工具;
 * - 主人本人那一轮可以让伙伴记下 / 移除一个已接手项目(add_workbench_project /
 *   remove_workbench_project),与工作台里「交给伙伴」写同一份记录。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import { and, count, desc, eq, inArray, isNotNull, isNull, like, ne, or } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { botDelegations, botProfiles, botSessionLinks, messages, sessions } from '../localDb/schema.js';
import { invalidateSessionImportScanCache } from '../localDb/ipc/session-import.js';
import { importExternalClaudeCodeSessions } from '../maker-host/claude-local-sessions.js';
import { importExternalCodexSessions } from '../maker-host/codex-local-sessions.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { routineTools } from '../routines/service.js';
import { normalizeWorkingDirForGrouping } from '../../shared/workingDir.js';
import {
  isCaseInsensitivePlatform,
  WORKBENCH_RECENT_WINDOW_MS,
  type WorkbenchDelegationStatus,
} from '../../shared/botWorkbench.js';
import {
  addBotWorkbenchDirectory,
  broadcastBotWorkbenchChanged,
  deleteBotWorkbenchJudgment,
  readBotWorkbenchDirectoryPaths,
  readBotWorkbenchState,
  removeBotWorkbenchDirectory,
  rekeyBotWorkbenchJudgment,
  setBotWorkbenchJudgment,
} from './botWorkbenchService.js';
import {
  listExternalSessionsForProjects,
  readExternalTranscriptFile,
  readSessionDigest,
  readSessionTranscript,
} from './botWorkbenchTranscripts.js';
import { workbenchSessionRoots } from './botWorkbenchSessionRoots.js';
import { checkHandoverDirectory, findHandedProject } from './botWorkbenchHandover.js';
import { createBriefCache, type WorkbenchBriefGithubItem } from './botWorkbenchBrief.js';
import { readCanonicalSessionActivity } from './sessionActivityProjection.js';
import {
  authorizeWorkbenchTarget,
  createBotWorkbenchAccess,
  type BotWorkbenchAccess,
  type BotWorkbenchAccessDeps,
  type WorkbenchCallerResult,
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

/**
 * 这件任务在不在主人交给该伙伴的项目里——与工作台继续同一判据。伙伴用通用会话工具
 * 处理「主人事先安排」的一轮时，靠它决定能不能动这件任务（见 botTurnAuthority.ts）。
 */
export async function isWorkbenchProjectSession(botId: string, sessionId: string): Promise<boolean> {
  const { directories } = await readBotWorkbenchState(ownerScopedUserDataPath(), botId);
  if (directories.length === 0) return false;
  const target = await readWorkbenchTarget(sessionId);
  return authorizeWorkbenchTarget(target, directories, isCaseInsensitivePlatform(process.platform)).ok;
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
      // 与渲染层同一口径:主人发消息与任务本身的最近更新取较晚的那个。
      lastActiveAt: Math.max(row.userSendAt ?? 0, row.updatedAt ?? 0) || null,
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
  // 调度器入口牵连通知等主进程模块,按需加载,避免任务 IPC 一引用本模块就把它们带进来。
  const { getSchedulerIfInitialized } = await import('../scheduler-host/index.js');
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

function appPath(name: 'appData' | 'userData'): string | null {
  try {
    return app.getPath(name);
  } catch {
    return null;
  }
}

/**
 * 已接手项目里近期的本机 Claude Code / Codex / Pi 会话。根目录见 `workbenchSessionRoots`
 * (含其它 Cindy profile 的 codex-home 与 pi-agent-home),按 cwd 过滤,只读近期转录的头尾。
 */
async function listExternalCandidates(projectDirs: readonly string[]) {
  const now = Date.now();
  // 与 `codexAccountHome` 同一个派生;按需加载,不把账号登录模块带进任务 IPC。
  const { codexAccountOwnerDir } = await import('../maker-host/codex-account-auth.js');
  return listExternalSessionsForProjects({
    roots: workbenchSessionRoots({
      homeDir: os.homedir(),
      appDataDir: appPath('appData'),
      userDataDir: appPath('userData'),
      platform: process.platform,
      env: { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, APPDATA: process.env.APPDATA },
      codexAccountOwner: codexAccountOwnerDir(),
    }),
    projectDirs,
    caseInsensitive: isCaseInsensitivePlatform(process.platform),
    since: now - WORKBENCH_RECENT_WINDOW_MS,
    now,
  });
}

const GIT_TIMEOUT_MS = 3_000;
const GITHUB_TIMEOUT_MS = 8_000;

/** 项目素材:git 命令限时、gh 登录 token 复用,拿不到就缺项。按项目缓存 60 秒。 */
// git / GitHub 依赖按需加载:只有伙伴真的读工作台时才用到,不拖累引用本模块的其它入口。
const readBrief = createBriefCache({
  git: async (cwd, args) => {
    try {
      const { runGit } = await import('../git-review/gitRunner.js');
      return (await runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: 512 * 1024 })).stdout;
    } catch {
      return null;
    }
  },
  searchGithub: async (query, limit) => {
    const [{ getSharedGhCliTokenSource }, { GithubClient }, { outboundFetch }] = await Promise.all([
      import('../git-context/ghCliTokenSource.js'),
      import('@cindy/github-client'),
      import('../maker-host/outbound-fetch.js'),
    ]);
    const token = await getSharedGhCliTokenSource().readToken();
    if (!token) return null;
    const client = new GithubClient({ token, fetchImpl: outboundFetch });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      client.searchIssuesAndPRs({ q: query, sort: 'updated', order: 'desc', per_page: limit }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('github timeout')), GITHUB_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    return result.items.slice(0, limit).map((item): WorkbenchBriefGithubItem => ({
      number: item.number,
      title: item.title.slice(0, 200),
      state: item.state,
      updatedAt: item.updated_at,
      url: item.html_url,
    }));
  },
  now: () => Date.now(),
});

const AGENT_KIND = { claude: 'cc', codex: 'codex', pi: 'pi' } as const;

async function findImportedSession(source: 'claude' | 'codex' | 'pi', externalId: string): Promise<string | null> {
  const [row] = await getDbClient()
    .drizzle.select({ id: sessions.id })
    .from(sessions)
    .where(and(
      eq(sessions.sdkSessionId, externalId),
      eq(sessions.agentKind, AGENT_KIND[source]),
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

/** 投递、停止与开后台任务由调用方注入(与 send_to_session、stop_session_turn、start_session_task 同一条宿主路径)。 */
export type BotWorkbenchSendDeps = Pick<BotWorkbenchAccessDeps, 'sendToSession' | 'startBackgroundTask'>;

/**
 * 按调用时的账号作用域组装一次工具服务:作用域在调用期间切换则中止,不做投递。
 */
function createDesktopBotWorkbenchAccess(send: BotWorkbenchSendDeps): BotWorkbenchAccess {
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
    startBackgroundTask: send.startBackgroundTask,
    readSessionDigest,
    readBrief,
    readSessionTranscript,
    readExternalTranscript: (candidate) => readExternalTranscriptFile(candidate.source, candidate.id, candidate.file),
    deleteJudgment: (botId, taskId) => deleteBotWorkbenchJudgment(userDataDir, botId, taskId),
    saveJudgment: (botId, taskId, judgment) => setBotWorkbenchJudgment(userDataDir, botId, taskId, judgment),
    rekeyJudgment: (botId, from, to) => rekeyBotWorkbenchJudgment(userDataDir, botId, from, to),
    notifyChanged: broadcastBotWorkbenchChanged,
    listDelegations: listBotDelegationChildren,
    readActivityPhase: async (sessionId) => (await readCanonicalSessionActivity(sessionId)).phase,
    listRoutines: listBotRoutines,
    listSchedules: listProjectSchedules,
    sendToSession: send.sendToSession,
    caseInsensitive: isCaseInsensitivePlatform(process.platform),
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
  startBackgroundTask: async () => ({ ok: false, errorCode: 'UNSUPPORTED', message: 'read only' }),
};

/** 工作台详情视图(主人自己的界面)读取一件任务的最近内容;范围同样限于已接手项目。 */
export async function readBotWorkbenchTaskForOwner(botId: string, taskId: string) {
  return runBotWorkbenchTool(NO_SEND, (access) => access.readForOwner({ botId, taskId }));
}

/** 工作台用:已接手项目里近期本机会话的 id 与最近活动。 */
export async function listBotWorkbenchCandidatesForOwner(botId: string) {
  return runBotWorkbenchTool(NO_SEND, (access) => access.listCandidatesForOwner({ botId }));
}

type ProjectFailure = { ok: false; errorCode: string; message: string };

async function runProjectChange<T>(run: () => Promise<T | ProjectFailure>): Promise<T | ProjectFailure> {
  if (isAppSessionBoundaryPending()) {
    return { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号正在切换,请稍后重试' };
  }
  try {
    return await run();
  } catch (error) {
    return { ok: false, errorCode: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 伙伴按主人的话记下一个已接手项目。只认本机、在用的伙伴主任务;「只有主人本人那一轮能用」
 * 由工具调用前的按轮判定保证(botTurnAuthority.ts 未列名的工具默认只放行主人本人那一轮)。
 */
export function addBotWorkbenchProjectForCaller(params: { callerSessionId: string; path: string }) {
  return runProjectChange(async () => {
    const scopeKey = activeOwnerScopeKey();
    const userDataDir = ownerScopedUserDataPath();
    const caller = await resolveWorkbenchCaller(params.callerSessionId);
    if (!caller.ok) return caller;
    const checked = await checkHandoverDirectory(params.path, {
      homeDir: os.homedir(),
      userDataDir: app.getPath('userData'),
      caseInsensitive: isCaseInsensitivePlatform(process.platform),
    });
    if (!checked.ok) return checked;
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) {
      return { ok: false as const, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号已切换,请重试' };
    }
    const added = await addBotWorkbenchDirectory(userDataDir, caller.botId, checked.path);
    if (!added.ok) {
      return {
        ok: false as const,
        errorCode: added.errorCode,
        message: added.errorCode === 'TOO_MANY' ? '交给这个伙伴的项目已经太多了,先移除一些再加' : '这不是一个目录',
      };
    }
    broadcastBotWorkbenchChanged(caller.botId);
    const projectCount = (await readBotWorkbenchDirectoryPaths(userDataDir, caller.botId)).length;
    return {
      ok: true as const,
      project: { name: path.basename(checked.path) || checked.path, path: checked.path },
      projectCount,
    };
  });
}

/** 伙伴按主人的话移除一个已接手项目;项目里的任务、文件与伙伴写过的判断都不动。 */
export function removeBotWorkbenchProjectForCaller(params: { callerSessionId: string; path: string }) {
  return runProjectChange(async () => {
    const scopeKey = activeOwnerScopeKey();
    const userDataDir = ownerScopedUserDataPath();
    const caller = await resolveWorkbenchCaller(params.callerSessionId);
    if (!caller.ok) return caller;
    const before = await readBotWorkbenchDirectoryPaths(userDataDir, caller.botId);
    const matched = await findHandedProject(params.path, before, {
      homeDir: os.homedir(),
      caseInsensitive: process.platform === 'darwin' || isCaseInsensitivePlatform(process.platform),
    });
    if (!matched) {
      return {
        ok: false as const,
        errorCode: 'PROJECT_NOT_IN_WORKBENCH',
        message: `工作台里没有这个项目,没有移除任何东西。现在交给你的项目:${before.join('、') || '(无)'}`,
      };
    }
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) {
      return { ok: false as const, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号已切换,请重试' };
    }
    await removeBotWorkbenchDirectory(userDataDir, caller.botId, matched);
    broadcastBotWorkbenchChanged(caller.botId);
    return { ok: true as const, path: matched, removed: true };
  });
}
