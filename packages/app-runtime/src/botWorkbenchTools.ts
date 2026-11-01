import type {DbClient} from '@cindy/runtime-db';
import {hasTaskActionAuthorization,assertTaskActionCurrent,captureTaskActionSyncGuard} from './taskActionAuthorization.js';
import {createWorkbenchAuthority} from './workbenchAuthority.js';
import {createWorkbenchCaller} from './workbenchCaller.js';
import {createBotWorkbenchAccess,type BotWorkbenchAccess,type BotWorkbenchAccessDeps} from '@cindy/companion-core/botWorkbenchAccess';
import type {WorkbenchTranscriptItem} from '@cindy/companion-core/botWorkbench';
import type {createBotLinkedProjects} from './botLinkedProjects.js';
import type {createBotTaskResponsibility} from './botTaskResponsibility.js';
import type {createBotWorkbenchTranscripts} from './botWorkbenchTranscripts.js';
import type {createBotWorkbenchAutonomyBridge} from './botWorkbenchAutonomyBridge.js';
type Failure={ok:false;errorCode:string;message:string};
export interface BotWorkbenchHostDeps {
  sendToSession: BotWorkbenchAccessDeps['sendToSession'];
  sendToRemoteSession: BotWorkbenchAccessDeps['sendToRemoteSession'];
  /** 另一台电脑上一件任务最近的用户 / 助手文字(按时间正序)。 */
  readRemoteMessages(deviceId: string, sessionId: string): Promise<{ ok: true; items: WorkbenchTranscriptItem[] } | Failure>;
}

export function createBotWorkbenchTools(host:ReturnType<typeof createBotTaskResponsibility>&ReturnType<typeof createBotWorkbenchTranscripts>&ReturnType<typeof createBotWorkbenchAutonomyBridge>&Pick<ReturnType<typeof createBotLinkedProjects>,'botLinkedProjectAccess'>&{getDbClient():DbClient;activeOwnerScopeKey():string;isAppSessionBoundaryPending():boolean;ownerScopedUserDataPath():string;broadcastBotWorkbenchChanged(botId:string):void}){
const {getDbClient,activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath,broadcastBotWorkbenchChanged,botLinkedProjectAccess,boundTranscript,readSessionTranscript,readTaskResponsibilities,responsibleSessionIds,setTaskResponsibility,collectTaskResponsibilityScopes,readBotGlance,readSchedulerBotId,readWatchedSession}=host;
const {resolveWorkbenchCaller}=createWorkbenchCaller(()=>getDbClient());

/** Query context only. The workbench authorization and task responsibility remain untouched. */
async function runBotProjectsTool(params: {
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

const {readWorkbenchTarget,listBotDelegationChildren,readBotResponsibleSessionIds,readBotResponsibilityScope,captureBotCreatedTaskResponsibility}=createWorkbenchAuthority({getDbClient:()=>getDbClient(),activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath,broadcastBotWorkbenchChanged,readTaskResponsibilities,responsibleSessionIds,setTaskResponsibility,collectTaskResponsibilityScopes});




/**
 * 投递与跨电脑读取由调用方注入(与 send_to_session、get_chat_history 同一条宿主路径)。
 * 渲染层只读入口不注入(NO_HOST):跨电脑读取返回明确错误。
 */

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
    notifyChanged: broadcastBotWorkbenchChanged,
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
async function runBotWorkbenchTool<T>(
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
async function readBotWorkbenchTaskForOwner(botId: string, taskId: string) {
  return runBotWorkbenchTool(NO_HOST, (access) => access.readForOwner({ botId, taskId }));
}

async function canBotContinueWorkbenchTask(callerSessionId: string, taskId: string): Promise<boolean> {
  const result = await runBotWorkbenchTool(NO_HOST, async access => ({
    ok: true as const,
    allowed: await access.canContinue({ callerSessionId, taskId }),
  }));
  return result.ok && result.allowed;
}

return {resolveWorkbenchCaller,runBotProjectsTool,readBotResponsibleSessionIds,readBotResponsibilityScope,captureBotCreatedTaskResponsibility,runBotWorkbenchTool,readBotWorkbenchTaskForOwner,canBotContinueWorkbenchTask};
}
