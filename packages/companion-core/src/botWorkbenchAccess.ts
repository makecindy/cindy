/**
 * 伙伴工作台的权限边界与工具服务(纯逻辑,依赖全部注入,便于单测)。
 *
 * 产品裁决(2026-10-17,放弃「项目」):工作台是「一眼」,授权不再来自「交给伙伴的项目目录」。
 *  - 总调度伙伴(账号设置「自动跟进所有任务」的那个,默认 Cindy 助理):可读本机任意普通任务
 *    与在线电脑上的任务(deviceId::sessionId);可继续的只有「没有伙伴开」的任务、自己开的任务,
 *    以及宿主已把跟进人落到它身上的任务(开任务的伙伴暂停 / 允许交给总调度跟)。别的伙伴开的
 *    任务默认只看不跟(TASK_FOLLOWED_BY_OTHER_BOT);观察层读不到这件任务时,只放行确定没有
 *    伙伴开的本机任务,另一台电脑上的一律不继续。另一台电脑上已观察到的任务不带创建者事实
 *    (被控端任务列表没有归属),总调度照常可以继续——主人裁决(2026-10-17):「别的伙伴开的
 *    任务只读」这条边界不跨电脑生效,不为此扩设备互联协议;
 *  - 其它伙伴:只能碰自己开的后台任务(读)或明确接手的任务(读 + 继续),本机。
 * 目录不再授予任何权限;旧 workbench.json 里的项目与判断原样留在磁盘上,不读作授权。
 *
 * 上述关系只界定观察和候选范围，所有继续还须独立的 Host 行动授权；身份本身不授权写入。
 * 每次调用都在 main 里确定性校验:
 *  1. 调用方 session → 伙伴:只认本机、在用的伙伴主任务(canonical);
 *  2. 本机目标:存在、未删除;不是任何伙伴自己的专线;不是 Orca worker;来源是主人会跟进的那几类;
 *     继续还要求未归档,伙伴自己的后台任务改用 message_session_task;
 *  3. 另一台电脑上的目标:只有总调度伙伴可以,读写都经对方电脑的同一条通路(对方再校验)。
 * 总调度身份查不到(观察层未就绪)时按「不是总调度」处理(fail closed)。
 */
import type { BotGlance, WatchedSession } from './botAutonomy.js';
import type { WorkbenchDelegationStatus, WorkbenchTranscript } from './botWorkbench.js';

type Failure = { ok: false; errorCode: string; message: string };

export const WORKBENCH_TOOL_MAX_MESSAGE_CHARS = 4_000;

export type WorkbenchCallerResult = { ok: true; botId: string } | Failure;

/** 授权判定所需的本机目标任务事实,由宿主从数据库读出。 */
export interface WorkbenchTargetFacts {
  id: string;
  status: string;
  source: string | null;
  /** SSH 远端执行的任务(本机有记录,经同一条发送通路投递)。仅供调用方参考,不影响授权。 */
  remoteHostId?: string | null;
  orcaRole: string | null;
  /** 该 session 在 bot_session_links 里有记录(伙伴主任务、群专线、历史等)。 */
  botLinked: boolean;
  /** 该 session 是某个伙伴后台任务(bot_delegations.child_session_id)的执行任务。 */
  delegationChild: boolean;
}

/** 主人会跟进的任务来源:与观察层同一口径(普通任务、插件、IM 渠道、共享、定时任务)。 */
const FOLLOWABLE_SOURCES = new Set([
  'desktop', 'plugin', 'feishu', 'slack', 'telegram', 'x', 'discord', 'wechat', 'dingtalk', 'wecom',
  'shared', 'scheduler',
]);

export function isFollowableTaskSource(source: string | null | undefined): boolean {
  return FOLLOWABLE_SOURCES.has(source ?? 'desktop');
}

export type WorkbenchTaskRef =
  | { kind: 'local'; sessionId: string }
  | { kind: 'remote'; deviceId: string; sessionId: string };

/** 本机 id,或另一台电脑上的 deviceId::sessionId(与历史工具同一写法)。 */
export function parseWorkbenchTaskRef(taskId: unknown): WorkbenchTaskRef | null {
  if (typeof taskId !== 'string') return null;
  const value = taskId.trim();
  if (!value || value.length > 512) return null;
  const parts = value.split('::');
  if (parts.length === 1) return /^[\w.-]{1,256}$/.test(value) ? { kind: 'local', sessionId: value } : null;
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { kind: 'remote', deviceId: parts[0], sessionId: parts[1] };
}

export type WorkbenchAccessMode = 'read' | 'continue';

export interface WorkbenchGrant {
  /** Separate Host-confirmed action. Observation/creator/responsibility never supplies this. */
  actionAuthorized?: boolean;
  /** 调用方是总调度伙伴。 */
  scheduler: boolean;
  /** 调用方明确接手过这件任务(task-responsibility)。 */
  responsible: boolean;
  /** 这件任务是调用方自己开的后台任务。 */
  createdByCaller: boolean;
  /**
   * 总调度继续时的跟进归属:开这件任务的是别的伙伴、且宿主没把跟进人落到调用方身上时,
   * 填那位伙伴的 id(读不到状态时为 'unknown');否则 null。只影响总调度的「继续」。
   */
  followedByOtherBot?: string | null;
}

/** 共享给访客的任务里有账号外的人发的话:伙伴不能经工作台推动它,只能告诉主人。 */
const sharedTaskNotContinuable: Failure = {
  ok: false,
  errorCode: 'TASK_SHARED_WITH_GUESTS',
  message: '这件任务共享给了访客,里面有账号外的人发的话;伙伴不能替主人继续它,请告诉主人由他自己处理。',
};

/** 总调度对别的伙伴开的任务默认只看不跟。 */
export function followedByOtherBotFailure(creatorBotId: string): Failure {
  const who = creatorBotId === 'unknown' ? '另一位伙伴' : `伙伴 ${creatorBotId}`;
  return {
    ok: false,
    errorCode: 'TASK_FOLLOWED_BY_OTHER_BOT',
    message: `这件任务是${who}开的,默认由它自己跟进,你只能读不能继续。`
      + '需要你接手时告诉主人:可以在那位伙伴的设置里打开「它开的任务也交给你跟进」。',
  };
}

/**
 * 从观察层状态行算出总调度能否代跟。watched 为 null(观察层没看到这件任务)时退回保守判断:
 * 本机任务只有确定不是伙伴开的后台任务才放行;另一台电脑上的任务无从判断,一律不放行。
 */
export function followedByOtherBot(
  callerBotId: string,
  watched: Pick<WatchedSession, 'creatorBotId' | 'followerBotId'> | null,
  fallback: { remote: boolean; delegationChild: boolean },
): string | null {
  if (watched) {
    const creator = watched.creatorBotId;
    if (!creator || creator === callerBotId || watched.followerBotId === callerBotId) return null;
    return creator;
  }
  return fallback.remote || fallback.delegationChild ? 'unknown' : null;
}

/** 本机目标的授权判定:只看任务事实与调用方的关系,不看目录。 */
export function authorizeWorkbenchTarget(
  target: WorkbenchTargetFacts | null,
  grant: WorkbenchGrant,
  mode: WorkbenchAccessMode,
): { ok: true } | Failure {
  if (!target || target.status === 'deleted') {
    return { ok: false, errorCode: 'TASK_NOT_FOUND', message: '找不到这件任务,它可能已被删除' };
  }
  if (target.botLinked || target.source === 'bot') {
    return { ok: false, errorCode: 'TASK_NOT_ACCESSIBLE', message: '这是伙伴自己的专线,不能通过工作台操作' };
  }
  if (target.orcaRole === 'worker' || (!target.delegationChild && !isFollowableTaskSource(target.source))) {
    return { ok: false, errorCode: 'TASK_NOT_SUPPORTED', message: '这类任务不在工作台的范围内' };
  }
  if (mode === 'read') {
    if (grant.scheduler || grant.responsible || grant.createdByCaller) return { ok: true };
    return { ok: false, errorCode: 'TASK_NOT_RESPONSIBLE', message: '这件任务不是你开的,也没有交给你跟进' };
  }
  if (target.status !== 'active') {
    return { ok: false, errorCode: 'TASK_ARCHIVED', message: '这件任务已归档,请让主人先恢复它' };
  }
  if (target.delegationChild && grant.createdByCaller) {
    return {
      ok: false,
      errorCode: 'TASK_IS_BACKGROUND_TASK',
      message: '这是你开的后台任务,请用 message_session_task / stop_session_task',
    };
  }
  if (!grant.actionAuthorized) return actionAuthorizationRequired;
  if (grant.responsible) return { ok: true };
  if (grant.scheduler) {
    return grant.followedByOtherBot ? followedByOtherBotFailure(grant.followedByOtherBot) : { ok: true };
  }
  return { ok: false, errorCode: 'TASK_NOT_RESPONSIBLE', message: '这件任务没有交给你跟进' };
}

export interface BotWorkbenchAccessDeps {
  hasActionAuthorization?(callerSessionId: string): boolean;
  resolveCaller(callerSessionId: string): Promise<WorkbenchCallerResult>;
  /** 当前总调度伙伴 id;观察层未就绪时返回 null(按不是总调度处理)。 */
  schedulerBotId(): Promise<string | null>;
  /** 观察层状态表的一行(本机裸 id / 远程 deviceId::sessionId);读不到返回 null。 */
  readWatched(taskKey: string): Pick<WatchedSession, 'creatorBotId' | 'followerBotId' | 'shared'> | null;
  readResponsibleSessionIds(botId: string): Promise<string[]>;
  saveResponsibility(botId: string, sessionId: string, responsible: boolean): Promise<void>;
  /** 该伙伴自己的后台任务:执行任务 id → 状态。 */
  listDelegations(botId: string): Promise<Map<string, WorkbenchDelegationStatus>>;
  readTarget(sessionId: string): Promise<WorkbenchTargetFacts | null>;
  /** 观察层的「一眼」投影;未就绪返回 null。 */
  readGlance(botId: string): Promise<BotGlance | null>;
  readSessionTranscript(sessionId: string): Promise<WorkbenchTranscript>;
  readRemoteTranscript(deviceId: string, sessionId: string): Promise<{ ok: true; transcript: WorkbenchTranscript } | Failure>;
  sendToSession(params: {
    targetSessionId: string;
    message: string;
    dispatcherSessionId: string;
  }): Promise<{ ok: true; wakeKind: string; queuedMessageId?: string } | Failure>;
  sendToRemoteSession(params: {
    deviceId: string;
    sessionId: string;
    message: string;
    dispatcherSessionId: string;
  }): Promise<{ ok: true; wakeKind: string } | Failure>;
  notifyChanged(botId: string): void;
  /** 账号切换守卫:返回 false 时中止,不做任何写入或投递。 */
  isOwnerScopeCurrent?(): boolean;
}

const scopeChanged: Failure = { ok: false, errorCode: 'OWNER_SCOPE_CHANGED', message: '账号已切换,请重试' };
const actionAuthorizationRequired: Failure = { ok: false, errorCode: 'TASK_ACTION_AUTHORIZATION_REQUIRED', message: '跟进关系只授予观察责任；请先向主人展示目标任务、动作和具体内容并取得授权。' };
const badId: Failure = { ok: false, errorCode: 'INVALID_ARGS', message: '任务 id 格式不对:本机写 id,另一台电脑写 deviceId::sessionId' };
const remoteNotAllowed: Failure = {
  ok: false,
  errorCode: 'TASK_NOT_RESPONSIBLE',
  message: '只有负责「自动跟进所有任务」的伙伴可以碰另一台电脑上的任务',
};
const emptyTranscript: Failure = { ok: false, errorCode: 'TRANSCRIPT_UNAVAILABLE', message: '读不到这件任务的记录' };

export function createBotWorkbenchAccess(deps: BotWorkbenchAccessDeps) {
  const scopeCurrent = () => deps.isOwnerScopeCurrent?.() ?? true;

  const isScheduler = async (botId: string) => (await deps.schedulerBotId().catch(() => null)) === botId;

  const grantFor = async (botId: string, sessionId: string, scheduler: boolean): Promise<WorkbenchGrant> => {
    const [responsible, delegations] = await Promise.all([
      deps.readResponsibleSessionIds(botId),
      deps.listDelegations(botId),
    ]);
    return { scheduler, responsible: responsible.includes(sessionId), createdByCaller: delegations.has(sessionId) };
  };

  type Resolved =
    | { ok: true; ref: WorkbenchTaskRef; taskId: string }
    | Failure;

  /** 统一入口:解析 id,远程只认总调度,本机按任务事实与关系判定。 */
  const authorize = async (botId: string, taskId: string, mode: WorkbenchAccessMode, actionAuthorized = false): Promise<Resolved> => {
    const ref = parseWorkbenchTaskRef(taskId);
    if (!ref) return badId;
    const scheduler = await isScheduler(botId);
    const watched = () => {
      try {
        return deps.readWatched(ref.kind === 'remote' ? `${ref.deviceId}::${ref.sessionId}` : ref.sessionId);
      } catch {
        return null;
      }
    };
    if (ref.kind === 'remote') {
      if (!scheduler) return remoteNotAllowed;
      if (mode === 'continue' && watched()?.shared) return sharedTaskNotContinuable;
      if (mode === 'continue' && !actionAuthorized) return actionAuthorizationRequired;
      if (mode === 'continue') {
        const other = followedByOtherBot(botId, watched(), { remote: true, delegationChild: false });
        if (other) return followedByOtherBotFailure(other);
      }
      return { ok: true, ref, taskId: `${ref.deviceId}::${ref.sessionId}` };
    }
    const target = await deps.readTarget(ref.sessionId);
    if (mode === 'continue' && target?.source === 'shared') return sharedTaskNotContinuable;
    const grant = await grantFor(botId, ref.sessionId, scheduler);
    grant.actionAuthorized = actionAuthorized;
    if (scheduler && mode === 'continue' && target) {
      grant.followedByOtherBot = followedByOtherBot(botId, watched(), {
        remote: false,
        delegationChild: target.delegationChild && !grant.createdByCaller,
      });
    }
    const decision = authorizeWorkbenchTarget(target, grant, mode);
    return decision.ok ? { ok: true, ref, taskId: ref.sessionId } : decision;
  };

  const readTranscript = async (ref: WorkbenchTaskRef) => {
    if (ref.kind === 'remote') return deps.readRemoteTranscript(ref.deviceId, ref.sessionId);
    const transcript = await deps.readSessionTranscript(ref.sessionId);
    return { ok: true as const, transcript };
  };

  const read = async (botId: string, taskId: string) => {
    const allowed = await authorize(botId, taskId, 'read');
    if (!allowed.ok) return allowed;
    const result = await readTranscript(allowed.ref).catch(() => emptyTranscript);
    if (!result.ok) return result;
    if (!scopeCurrent()) return scopeChanged;
    return { ok: true as const, taskId: allowed.taskId, transcript: result.transcript };
  };

  return {
    async setResponsibility(params: { callerSessionId: string; taskId: string; responsible: boolean }) {
      if (typeof params.responsible !== 'boolean') return { ok: false as const, errorCode: 'INVALID_ARGS', message: 'Invalid responsibility' };
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      const ref = parseWorkbenchTaskRef(params.taskId);
      if (!ref || ref.kind !== 'local') return { ok: false as const, errorCode: 'INVALID_ARGS', message: 'A task ID on this computer is required' };
      const facts = await deps.readTarget(ref.sessionId);
      if (!facts || facts.status === 'deleted' || facts.botLinked || facts.source === 'bot') {
        return { ok: false as const, errorCode: 'TASK_NOT_ACCESSIBLE', message: 'Task is unavailable' };
      }
      if (params.responsible && (facts.status !== 'active' || facts.orcaRole === 'worker' || !isFollowableTaskSource(facts.source))) {
        return { ok: false as const, errorCode: 'TASK_NOT_ACCESSIBLE', message: 'Task cannot be taken' };
      }
      if (!params.responsible && !(await deps.readResponsibleSessionIds(caller.botId)).includes(ref.sessionId)) {
        return { ok: false as const, errorCode: 'TASK_NOT_RESPONSIBLE', message: 'You do not own this responsibility' };
      }
      if (!scopeCurrent()) return scopeChanged;
      await deps.saveResponsibility(caller.botId, ref.sessionId, params.responsible);
      deps.notifyChanged(caller.botId);
      return { ok: true as const, taskId: ref.sessionId, responsible: params.responsible };
    },

    async get(params: { callerSessionId: string }) {
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      const glance = await deps.readGlance(caller.botId);
      if (!glance) {
        return { ok: false as const, errorCode: 'HOST_NOT_READY', message: '工作台还在准备,请稍后再看' };
      }
      if (!scopeCurrent()) return scopeChanged;
      return { ok: true as const, workbench: glance };
    },

    async read(params: { callerSessionId: string; taskId: string }) {
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      return read(caller.botId, params.taskId);
    },

    async canContinue(params: { callerSessionId: string; taskId: string }): Promise<boolean> {
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return false;
      return (await authorize(caller.botId, params.taskId, 'continue', true)).ok;
    },

    async continueTask(params: { callerSessionId: string; taskId: string; message: string }) {
      const message = params.message.trim();
      if (!message || message.length > WORKBENCH_TOOL_MAX_MESSAGE_CHARS) {
        return { ok: false as const, errorCode: 'INVALID_ARGS', message: `消息不能为空,且不超过 ${WORKBENCH_TOOL_MAX_MESSAGE_CHARS} 字` };
      }
      const caller = await deps.resolveCaller(params.callerSessionId);
      if (!caller.ok) return caller;
      const allowed = await authorize(caller.botId, params.taskId, 'continue', deps.hasActionAuthorization?.(params.callerSessionId) === true);
      if (!allowed.ok) return allowed;
      if (!scopeCurrent()) return scopeChanged;
      if (allowed.ref.kind === 'remote') {
        const sent = await deps.sendToRemoteSession({
          deviceId: allowed.ref.deviceId,
          sessionId: allowed.ref.sessionId,
          message,
          dispatcherSessionId: params.callerSessionId,
        });
        if (!sent.ok) return sent;
        return {
          ok: true as const,
          taskId: allowed.taskId,
          delivery: sent.wakeKind === 'queued' ? ('queued' as const) : ('started' as const),
        };
      }
      const sent = await deps.sendToSession({
        targetSessionId: allowed.ref.sessionId,
        message,
        dispatcherSessionId: params.callerSessionId,
      });
      if (!sent.ok) return sent;
      return {
        ok: true as const,
        taskId: allowed.taskId,
        delivery: sent.wakeKind === 'queued' ? ('queued' as const) : ('started' as const),
        ...(sent.queuedMessageId ? { queuedMessageId: sent.queuedMessageId } : {}),
      };
    },

    /**
     * 渲染层「一眼」点开一件任务时的只读摘录。调用方是主人自己的界面(受信 renderer),
     * 仍按同一条规则判定,不让详情视图成为读任意会话的入口。
     */
    async readForOwner(params: { botId: string; taskId: string }) {
      return read(params.botId, params.taskId);
    },
  };
}

export type BotWorkbenchAccess = ReturnType<typeof createBotWorkbenchAccess>;
