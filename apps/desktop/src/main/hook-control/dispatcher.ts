/**
 * hook-control/dispatcher.ts
 * ---------------------------------------------------------------------------
 * 第三步核心: 把合法的 task.dispatch 变成真实的 agent turn, 并把结果以
 * turn.end 回推。纯逻辑模块 —— store / bindings / runner 全部注入, 单测用
 * 假实现直接驱动, 不需要 Electron / maker(规则 14)。
 *
 * 职责链(对应协议语义):
 *   1. 幂等: (connectionId, requestId) 去重 —— 重投只回放上次 ack, 不重跑;
 *   2. 会话定位:
 *      - 带 sessionId(接管): session 必须存在且其工作目录落在本连接注册的
 *        别名路径内(白名单不因接管放松), 通过后把 externalKey 重绑到它;
 *      - 不带(默认): 别名解析(映射即白名单)-> binding 查 externalKey ->
 *        复用或新建并落绑定。复用与否**每条消息现场重算**, 唯一依据是会话
 *        当前的工作目录是否仍落在工作目录映射(或内置对话根)内 —— 映射是
 *        「远端能驱动哪些本地目录」的唯一边界, 判定不带任何**持久化授权**状态
 *        (进程内仍有 awaitingPersist 这类短生命周期记账, 但它们只是收窄判定,
 *        本身不构成放行依据)。移出映射(被移到别处 / 映射被改删)= 丢绑定重建,
 *        并回一条说明怎么恢复;
 *   3. 排队: 目标 session 正在跑 turn 时 FIFO 排队, ack 回 queued + 位置;
 *      turn 收口后自动 drain;
 *   4. 回推: turn.end 经当前连接发送; 连接不在线时缓存, 重连(onConnected)
 *      后按序补发 —— server 侧按 requestId 幂等。执行中的渲染快照经
 *      turn.progress 直发(不缓存不补发, 装饰性信息丢了无害)。
 *
 * 权限模式: dispatch 的 options.permissionMode 对「新建 session」生效 ——
 * runner 校验其属于目标 agent 的能力档位, 合法即用, 非法/缺省落
 * bypassPermissions(hook 无人值守的历史默认); 复用/接管以 session meta 为
 * 权威, options 不覆盖。非 bypass 档下 agent 的权限请求经 interaction.request
 * 以 Slack 卡片呈现(允许一次/本对话总是允许/拒绝), 超时安全默认拒绝。
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  makeInteractionCancel,
  makeInteractionRequest,
  makeTaskAck,
  makeTurnEnd,
  makeTurnProgress,
  type HookMessage,
  type InteractionButton,
  type InteractionDecisionPayload,
  type TaskAckPayload,
  type TaskAttachment,
  type TaskDispatchPayload,
  type TaskRejectReason,
  type TaskSource,
} from '@cindy/slack-hook-protocol';

import { HOOK_CHAT_WORKSPACE_ALIAS } from '../../shared/hookControlIpc.js';
import { isPathWithin } from './paths.js';
import type { HookConnectionConfig } from './store.js';
import type { HookBindingStore } from './bindings.js';

/** 会话执行器抽象 —— 生产实现 session-runner.ts(包 maker), 测试注入假的。 */
export interface HookSessionRunner {
  /** 目标 session 是否正在跑 turn。 */
  isBusy(sessionId: string): boolean;
  /**
   * 会话现状: null = 不存在; usable=false = 已归档/删除(不可投递);
   * workingDir 用于接管/复用时的白名单校验。
   */
  inspect(sessionId: string): Promise<{ workingDir: string | null; usable: boolean } | null>;
  /** 跑一个完整 turn, 收口(done / terminal error)后返回。 */
  run(req: HookRunRequest): Promise<HookRunOutcome>;
}

export interface HookRunRequest {
  sessionId: string;
  /**
   * IM lane 形态(externalKey 派生): 'group' = 群/topic, 'dm' = 私聊。
   * runner 据此决定进度快照是否携带过程时间线(群内可编辑消息适合过程卡,
   * DM 的 Rich draft 动画不适合反复重排)。缺省按 'dm' 保守处理。
   */
  laneKind?: 'dm' | 'group';
  /** true = 新建 session(workingDir/title 生效); false = 复用/接管已有。 */
  isNew: boolean;
  workingDir: string;
  /** dispatch options 显式指定的 agent; null = 桌面端按草稿默认落值。 */
  agentKind: string | null;
  /** dispatch options 显式指定的模型(Slack 个人习惯); null = 草稿默认。 */
  model: string | null;
  /** dispatch options 显式指定的 effort; null = 草稿默认。 */
  effort: string | null;
  /**
   * dispatch options 显式指定的权限档(Slack 按目录偏好); null = 默认
   * bypassPermissions。仅 isNew 时消费(复用/接管以 session meta 为权威)。
   */
  permissionMode: string | null;
  /**
   * 'dialogue' = 内置「对话」伪目录(chat)的新会话 —— runner 建会话时透传,
   * 落侧边栏「对话」分组而非按目录聚成项目。仅 isNew 时有意义。
   */
  workspaceKind?: 'dialogue';
  /**
   * 本次派发的目录别名(内置「对话」= chat)—— runner 据此查本地的目录模型
   * 来源偏好(workspaceProviderSourceStore)。缺省 = 老 server 未带 workspace。
   */
  workspaceAlias?: string;
  title: string | null;
  prompt: string;
  /** 本次派发携带的入站附件(base64); 无则省略。runner 解码落盘后喂给 agent。 */
  attachments?: TaskAttachment[];
  /** 来源标注(落 user 消息 agentMeta + turnOrigin)。 */
  origin: { connectionId: string; connectionName: string; externalKey: string };
  /** IM 来源元数据(平台 + thread 上下文); 省略 = 旧 server 不发。 */
  source?: TaskSource;
  /**
   * 执行中渲染快照回调(turn.progress 链路)。runner 合成「过程区时间线 +
   * 部分正文」的完整 markdown 快照并节流回调; dispatcher 注入的实现把它
   * 打成 turn.progress 帧发给 server。进度是尽力而为的装饰性信息 ——
   * 连接不在线时直接丢弃, 不缓存不重发(与 turn.end 的离线补发相反)。
   */
  onProgress?: (text: string) => void;
  /**
   * 执行中交互卡回调(interaction.request 链路)。runner 把 maker 的
   * InteractionRequest 合成渠道无关卡片后经此发出; 连接不在线时丢弃
   * (runner 侧的交互超时会按安全默认自决, 任务不会卡死)。
   */
  onInteraction?: (card: {
    interactionId: string;
    kind: string;
    title: string;
    body: string;
    buttons: InteractionButton[];
  }) => void;
  /** 交互已在本端收口(超时默认 / turn 结束), 通知 server 改写卡片。 */
  onInteractionCancel?: (interactionId: string, reason: string) => void;
  /**
   * "这个目录此刻还在本连接的工作目录映射内吗" —— dispatcher 注入(只有它查得到
   * 映射)。runner 用它校验**真正要跑的那个 live session 的 workDir**: maker 对
   * 已活着的 session id 会忽略传入的 workingDir 直接返回旧实例, 那个实例的目录
   * 可能已被移出映射, 且实例不换就一直错配(PR #733 review 指出)。
   * 省略 = 不校验(测试与旧调用方)。
   */
  isDirAuthorized?: (dir: string) => boolean;
}

export interface HookRunOutcome {
  status: 'ok' | 'error';
  finalText: string;
  errorMessage: string | null;
  durationMs: number;
  /** 出站附件(agent 产图/产文件, runner 收集编码; 无则省略), 随 turn.end 回传。 */
  attachments?: TaskAttachment[];
}

/** 为新会话预建独立 worktree 的结果(成功时调用方必须用返回的 sessionId 建会话)。 */
export type PrepareWorktreeResult =
  | { ok: true; sessionId: string; path: string; cleanup: () => Promise<void> }
  | { ok: false; message: string };

export interface HookDispatcherDeps {
  getConnection: (id: string) => HookConnectionConfig | null;
  bindings: HookBindingStore;
  runner: HookSessionRunner;
  /**
   * 可选: 为新建 hook 会话预建独立 git worktree(并发隔离 —— 每个
   * thread/会话一个 worktree, 多任务同时跑互不踩工作树)。失败时 dispatcher
   * 回退共享工作区目录, 不拒单(非 git 目录天然走回退)。
   */
  prepareWorktree?: (workingDir: string) => Promise<PrepareWorktreeResult>;
  /**
   * 可选: 为派发组装本地群上下文前缀(group-relay-v1 窗口, 生产为
   * groupWindow.buildGroupContextPrefix)。只影响发给 agent 的 prompt,
   * 不影响会话标题与 UI 渲染(二者用 source.userText / 原始 prompt);
   * 失败或空装配 = 无前缀, 绝不因上下文拒单。commit 在任务被受理
   * (accepted/queued)后由本模块调用, 拒单不推进窗口游标。
   */
  buildContextPrefix?: (
    payload: TaskDispatchPayload,
  ) => Promise<{ prefix: string; commit: () => void }>;
  /**
   * 可选: 内置「对话」伪目录(chat 保留别名)的解析面。rootDir 在每次
   * dispatch 时解析当前 data owner 的 app 托管目录根，allocateDir 为新会话
   * 分配独立子目录。
   * 未注入时 chat 别名按 unknown_workspace 拒绝(纯逻辑测试 / 旧行为默认)。
   */
  dialogue?: { rootDir: () => string; allocateDir: (sessionId: string) => Promise<string> };
  /**
   * 可选: 中断某 session 正在跑的 turn(task.cancel 用; 生产为
   * maker.getSession(id)?.abort())。未注入时 cancel 只能收口排队中的任务。
   */
  abortSession?: (sessionId: string) => Promise<void>;
  /**
   * 可选: 把 session 行置为 archived(session.archive 用; 生产为
   * patchSessionMetaInDb, 自带 sidebar 广播)。未注入时 archive 只清绑定。
   */
  archiveSessionRow?: (sessionId: string) => Promise<void>;
  /**
   * 可选: 按钮决策回流的配对出口(interaction.decision 用; 生产为
   * interactions.ts 的 resolveHookInteraction)。未注入时决策帧被忽略,
   * runner 侧交互只能等超时默认。
   */
  resolveInteraction?: (interactionId: string, buttonId: string) => boolean;
  /**
   * Production keeps ingress closed until the owner DB-ready callback opens
   * the account boundary. Tests and standalone consumers retain the historical
   * eager behavior unless they opt out explicitly.
   */
  accountInitiallyActive?: boolean;
  log: { info(msg: string): void; warn(msg: string): void };
}

export interface HookDispatcher {
  /** transport 收到 task.dispatch 时调用。send 为该连接当前的发送函数。 */
  handleDispatch(
    connectionId: string,
    payload: TaskDispatchPayload,
    send: (m: HookMessage) => boolean,
  ): void;
  /** 连接握手完成(welcome)后调用: 更新发送函数并补发离线期间积压的 turn.end。 */
  onConnected(connectionId: string, send: (m: HookMessage) => boolean): void;
  /** transport 离线或失去已协商能力时调用，禁止继续向旧 socket 发送帧。 */
  onDisconnected(connectionId: string): void;
  /**
   * task.cancel: 中断指定 requestId 的任务。排队中的直接摘除并回
   * turn.end(cancelled); 执行中的标记取消并 abort 对应 session, 收口时以
   * cancelled 回推; 未知 / 已收口的静默忽略(server 侧幂等消化竞态)。
   */
  cancel(connectionId: string, requestId: string): void;
  /**
   * session.archive: 归档 externalKey 绑定的会话并清绑定(Slack 私聊 /new
   * 换代触发)。幂等: 无绑定 / 会话已不存在时静默 no-op。与同 key 的 dispatch
   * 走同一条串行链, 不与在途的会话定位竞争。
   */
  handleSessionArchive(connectionId: string, externalKey: string): void;
  /**
   * interaction.decision: 交互卡按钮回流。归属校验(requestId 必须是本连接
   * 正在执行的任务)后按 interactionId 配对 resolve; 未知 / 迟到的静默忽略。
   */
  handleInteractionDecision(connectionId: string, payload: InteractionDecisionPayload): void;
  /** Re-open ingress after the next account DB is ready. */
  activateAccount(): void;
  /** Close ingress, abort old-account turns and await their final async boundary. */
  deactivateAccount(): Promise<void>;
}

/** 单 session 排队上限 —— 超过按 rejected(invalid) 打回, 防失控上游刷爆。 */
const MAX_QUEUE_PER_SESSION = 20;
/** 单连接离线 turn.end 缓存上限(FIFO 丢最老)。 */
const MAX_PENDING_TURN_ENDS = 100;

/**
 * 原对话不再落在工作目录映射内时(被移到映射外的项目, 或映射本身被改/删),
 * 回给渠道的一次性说明(Slack / Telegram 侧文案不进 locale, 与 interactions.ts
 * 的卡片按钮同规硬编码中文)。
 *
 * 必须如实: 旧绑定被丢弃后同一个 externalKey 立刻指向新对话, 光把目录加进映射
 * **不会**自动接回原对话(那条 thread 已经绑到新的了), 只有先让目录进映射、再用
 * 对话选择重新指定原对话才接得回来 —— 两步缺一不可。
 */
const NOTICE_SESSION_RECREATED =
  'ℹ️ 原对话已不在可用的工作目录里，这条消息起换用了新对话，原对话的上下文不会带过来。' +
  '想接回原对话：先到 Cindy 的 设置 → 远程连接 → 工作目录映射 把它所在的目录加进来，' +
  '再在这里用对话选择重新指定它。';
/**
 * 查不到原对话时的说明。措辞刻意留了余地: inspect 返回 null 是多义的 ——
 * 会话真的没了是 null, meta / DB 读取瞬时失败也被吞成 null(session-runner
 * 两路都 catch)。一口咬定"已被归档或删除"会在读库抖动时误导用户
 * (PR #733 review 指出)。
 */
const NOTICE_SESSION_GONE = 'ℹ️ 原对话现在读不到（可能已被归档或删除），这条消息起换用了新对话。';

/** 标题里消息摘要的最大长度(字符), 超出截断加省略号。 */
const TITLE_SNIPPET_MAX = 24;
/** Server-controlled source metadata is persisted and rendered, so keep it bounded locally too. */
const SOURCE_USER_TEXT_MAX = 20_000;
const SOURCE_TRIGGER_MESSAGE_ID_MAX = 64;
const SOURCE_CHANNEL_NAME_MAX = 160;
const SOURCE_TEAM_ID_MAX = 128;
const SOURCE_TEAM_NAME_MAX = 160;
const SOURCE_THREAD_CONTEXT_MAX = 20;
const SOURCE_THREAD_AUTHOR_MAX = 128;
const SOURCE_THREAD_TEXT_MAX = 4_000;

/**
 * Bound IM display metadata before it reaches session persistence. The wire
 * parser validates types, while this client boundary limits renderer work and
 * keeps desktop/mobile normalization consistent without changing the shared
 * protocol or silently truncating the prompt sent to the agent.
 */
export function normalizeTaskSource(source: TaskSource): TaskSource {
  const boundedNullable = (
    value: string | null | undefined,
    max: number,
  ): string | null | undefined => {
    if (value === null || value === undefined) return value;
    return value.slice(0, max);
  };
  const channelName = boundedNullable(source.channelName, SOURCE_CHANNEL_NAME_MAX);
  const teamId = boundedNullable(source.teamId, SOURCE_TEAM_ID_MAX);
  const teamName = boundedNullable(source.teamName, SOURCE_TEAM_NAME_MAX);
  const threadContext = source.threadContext?.slice(0, SOURCE_THREAD_CONTEXT_MAX).map((entry) => ({
    author: entry.author.slice(0, SOURCE_THREAD_AUTHOR_MAX),
    text: entry.text.slice(0, SOURCE_THREAD_TEXT_MAX),
    ...(entry.isBot === true ? { isBot: true } : {}),
  }));

  return {
    im: source.im,
    ...(channelName !== undefined ? { channelName } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
    ...(teamName !== undefined ? { teamName } : {}),
    ...(threadContext !== undefined ? { threadContext } : {}),
    ...(source.userText !== undefined
      ? { userText: source.userText.slice(0, SOURCE_USER_TEXT_MAX) }
      : {}),
    ...(source.triggerMessageId !== undefined
      ? {
          triggerMessageId:
            source.triggerMessageId === null
              ? null
              : source.triggerMessageId.slice(0, SOURCE_TRIGGER_MESSAGE_ID_MAX),
        }
      : {}),
  };
}

/**
 * 新建 hook 会话的标题: `[<Provider>] <首条消息摘要>`(如 `[Slack] 修登录页`)。
 * 前缀保留 provider 名标明"谁驱动的"(首字母大写, 不再带 `Hook·` 实现细节);
 * 后半段用消息内容(压平空白后截断), 比"频道 ID + 时间戳"可读。消息为空
 * (如纯图片派发)时回退渠道内标识 bareKey。
 * 渠道内标识约定 `dm:` 前缀 = 私聊(见 slack-hook-server externalKeyFor),
 * 私聊会话前缀额外标 `·DM`(`[Slack·DM]`), 与频道驱动的会话在列表里一眼区分。
 * contextName: Slack workspace 或 Telegram group/topic 显示名，非空时并入方括号**首段**
 * (`[XD Inc.·Slack·DM] ...`)—— 多绑定设备上区分「哪个 workspace 派来的」,
 * team 名在前便于列表扫读; 放括号内保持标题统一以 `[` 开头对齐
 * (老 server / 单绑定不下发, 无 teamName 分支格式不变)。
 */
export function buildHookSessionTitle(
  providerName: string,
  prompt: string,
  bareKey: string,
  contextName?: string | null,
): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  const snippet =
    flat.length === 0
      ? bareKey
      : flat.length > TITLE_SNIPPET_MAX
        ? `${flat.slice(0, TITLE_SNIPPET_MAX)}…`
        : flat;
  const dmTag = bareKey.startsWith('dm:') ? '·DM' : '';
  const displayProvider = providerName.charAt(0).toUpperCase() + providerName.slice(1);
  const contextTag = contextName && contextName.trim().length > 0 ? `${contextName.trim()}·` : '';
  return `[${contextTag}${displayProvider}${dmTag}] ${snippet}`;
}

/** 待执行任务(定位已完成, 排队即执行参数就绪)。 */
interface PendingTask {
  connectionId: string;
  requestId: string;
  externalKey: string;
  run: HookRunRequest;
  accountGeneration: number;
  /** 会话定位阶段产生的一次性说明, 前置到本次 turn.end 的 finalText。 */
  notice?: string;
  /**
   * 本次定位为新会话预建的 worktree 的回收句柄。**只在这个任务最终没能进
   * runner 时调用** —— 正常执行时 worktree 归会话所有, 不能回收。少了它,
   * 执行前的映射收口一旦拦下任务, 刚建好的 worktree 目录与分支就成了没有会话
   * 认领的孤儿, 反复改映射会累积(PR #733 review 指出)。
   */
  cleanupWorktree?: () => Promise<void>;
}

export function createHookDispatcher(deps: HookDispatcherDeps): HookDispatcher {
  const {
    getConnection,
    bindings,
    runner,
    prepareWorktree,
    buildContextPrefix,
    dialogue,
    abortSession,
    archiveSessionRow,
    resolveInteraction,
    accountInitiallyActive,
    log,
  } = deps;

  /**
   * worktree 预建全局串行链: 不同 externalKey 的新建会并发到达(keyChains 只按
   * key 串行), 同时建两个 worktree 会在 suggestName 上撞名(竞态取同一个名字,
   * 后者建分支失败)。预建本身是秒级操作, 全局串行的吞吐代价可忽略。
   */
  let worktreeChain: Promise<void> = Promise.resolve();
  function prepareWorktreeSerial(workingDir: string): Promise<PrepareWorktreeResult> {
    const fn = prepareWorktree;
    if (!fn) return Promise.resolve({ ok: false, message: 'prepareWorktree not configured' });
    const result = worktreeChain.then(
      () => fn(workingDir),
      () => fn(workingDir),
    );
    worktreeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** (connectionId, requestId) -> 已回放的 ack(幂等表, 进程内)。app 重启后
   *  server 重投会真重跑一次 —— 原任务已随进程死亡, 重跑正是期望行为。 */
  const ackHistory = new Map<string, TaskAckPayload>();
  /** 幂等表容量上限: 超出淘汰最老条目(Map 迭代序即插入序), 防长驻进程无界增长。 */
  const MAX_ACK_HISTORY = 2000;
  /** 正在处理(尚未回 ack)的请求 —— 同 requestId 在此窗口内重投直接忽略,
   *  首条处理完的 ack 就是应答(封掉 in-flight 幂等窗口)。 */
  const inflightRequests = new Set<string>();
  /**
   * 按 (connectionId, externalKey) 串行化会话定位与入队:
   * resolveTarget 内有 await(inspect), 同 key 两条 dispatch 并发穿插会双双
   * 走到"新建"分支, 破坏「同 key 同 session」铁律(ws 同步 emit 下同一 TCP
   * 段的两帧在同一 tick 送达, 生产可达)。链式 promise 保证同 key 严格按序。
   */
  const keyChains = new Map<string, Promise<void>>();
  function serializeByKey(key: string, fn: () => Promise<void>): void {
    const prev = keyChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const stored = next.catch(() => undefined);
    keyChains.set(key, stored);
    void stored.finally(() => {
      if (keyChains.get(key) === stored) keyChains.delete(key);
    });
  }
  /** 每连接当前发送函数(transport 重建后由 onConnected / handleDispatch 刷新)。 */
  const sendFns = new Map<string, (m: HookMessage) => boolean>();
  /** 离线积压的 turn.end, 按连接缓存。 */
  const pendingTurnEnds = new Map<string, HookMessage[]>();
  /** 正在执行 turn 的 session(本模块发起的)。 */
  const running = new Set<string>();
  /**
   * 本 dispatcher 刚新建、但**还没被确认落库**的 session -> 建它时用的目录。
   * 免检快路径只认这张表(见 resolveTarget)—— `inspect()` 返回 null 是多义的:
   * session 不存在是 null, meta / DB 读取瞬时失败也被吞成 null(session-runner
   * 两路都 catch)。只凭 null 放行, 一次读库抖动就能让已落库、已被移出映射的
   * session 继续收消息, 绕过映射边界(PR #733 review 指出)。
   *
   * 存目录而不只是 id: 会话还没落库的这段时间里别名映射可能已被改指, 免检时
   * 要拿它跟当前映射重新比一次 —— 否则那条消息会排进一个建在已撤权目录里的
   * 会话(同一轮 review 指出)。它不是"授权凭据", 只是 dispatcher 自己刚用过的
   * 目录的进程内记账, 每次都要重新过映射校验才算数。
   *
   * 出表的两个口子: 任何一次 inspect 成功查到它(说明已落库), 或它的 turn
   * 收口(run 返回时 session 必已建好)。因此表的规模 ≤ 并发新建数, 不会泄漏。
   */
  const awaitingPersist = new Map<string, string>();
  /** 每 session 的 FIFO 等待队列。 */
  const queues = new Map<string, PendingTask[]>();
  /** connectionId + requestId -> 正在执行它的 session(cancel 定位与归属校验用, 收口即清)。 */
  const runningByRequest = new Map<string, { sessionId: string; connectionId: string }>();
  /** 已请求取消的 connectionId + requestId(execute 收口时据此把结果改写为 cancelled)。 */
  const cancelRequested = new Set<string>();
  let accountActive = accountInitiallyActive ?? true;
  let accountGeneration = 0;
  const executing = new Set<Promise<void>>();
  let accountDeactivation: Promise<void> | null = null;

  function isCurrentGeneration(generation: number): boolean {
    return accountActive && generation === accountGeneration;
  }

  function ackKey(connectionId: string, requestId: string): string {
    return `${connectionId} ${requestId}`;
  }

  function sendOrBuffer(connectionId: string, msg: HookMessage): void {
    const send = sendFns.get(connectionId);
    if (send && send(msg)) return;
    const buf = pendingTurnEnds.get(connectionId) ?? [];
    buf.push(msg);
    if (buf.length > MAX_PENDING_TURN_ENDS) buf.shift();
    pendingTurnEnds.set(connectionId, buf);
    log.warn(`turn.end buffered (connection offline): ${connectionId}`);
  }

  function reply(
    connectionId: string,
    send: (m: HookMessage) => boolean,
    ack: TaskAckPayload,
  ): void {
    const key = ackKey(connectionId, ack.requestId);
    ackHistory.set(key, ack);
    inflightRequests.delete(key);
    if (ackHistory.size > MAX_ACK_HISTORY) {
      const oldest = ackHistory.keys().next().value;
      if (oldest !== undefined) ackHistory.delete(oldest);
    }
    send(makeTaskAck(ack));
  }

  function rejected(requestId: string, reason: TaskRejectReason): TaskAckPayload {
    return { requestId, result: 'rejected', reason, sessionId: null, queuePosition: null };
  }

  /** 执行一个任务并回推 turn.end; 收口后 drain 同 session 队列。 */
  async function execute(task: PendingTask): Promise<void> {
    const sessionId = task.run.sessionId;
    const requestKey = ackKey(task.connectionId, task.requestId);
    if (!isCurrentGeneration(task.accountGeneration)) {
      running.delete(sessionId);
      return;
    }
    runningByRequest.set(requestKey, { sessionId, connectionId: task.connectionId });

    // 进度快照直发不缓存: 断线期间的中间帧没有补发价值(turn.end 会带最终
    // 结果), 发送失败静默丢弃即可
    const onProgress = (text: string): void => {
      if (!isCurrentGeneration(task.accountGeneration)) return;
      const send = sendFns.get(task.connectionId);
      if (send) send(makeTurnProgress({ requestId: task.requestId, text }));
    };
    // 交互卡同样直发不缓存: 连接不在线时用户本来就看不到卡, runner 侧的
    // 交互超时会按安全默认自决, 任务不会卡死
    const onInteraction = (card: {
      interactionId: string;
      kind: string;
      title: string;
      body: string;
      buttons: InteractionButton[];
    }): void => {
      if (!isCurrentGeneration(task.accountGeneration)) return;
      const send = sendFns.get(task.connectionId);
      if (send) send(makeInteractionRequest({ requestId: task.requestId, ...card }));
    };
    const onInteractionCancel = (interactionId: string, reason: string): void => {
      if (!isCurrentGeneration(task.accountGeneration)) return;
      const send = sendFns.get(task.connectionId);
      if (send) send(makeInteractionCancel({ requestId: task.requestId, interactionId, reason }));
    };

    let outcome: HookRunOutcome;
    /**
     * 开跑前按当前映射再确认一次(见 dirStillAllowed)。resolveTarget 到这里之间
     * 隔着排队与若干 await(新建路径还要等 worktree 预建 / 对话目录分配), 映射
     * 随时可能被改/删; 这是"每条消息按映射现场重算"在执行侧的收口。
     *
     * workingDir 就是这一轮要跑的目录(复用/接管路径是 dispatcher 刚校验过的
     * 那个, 新建路径是刚算出来的 runDir)。用 `||` 而非 `??`: 它可能是空串占位,
     * 而空串过 isPathWithin 会 resolve 成 cwd, 那就成了一条假放行。
     */
    const guardDir = task.run.workingDir || null;
    if (guardDir !== null && !dirStillAllowed(task.connectionId, guardDir)) {
      // 路径不进日志(规则: 用集中 PII helper, 而 dispatcher 是不碰 Electron 的
      // 纯逻辑模块, 拿不到它)—— requestId 足够定位。
      log.info(
        `hook task ${task.requestId} aborted before execution: its directory is no longer authorized`,
      );
      // 任务没能进 runner, 刚预建的 worktree 不会有会话来认领 —— 就地回收
      if (task.cleanupWorktree) void task.cleanupWorktree().catch(() => undefined);
      outcome = {
        status: 'error',
        finalText: '',
        errorMessage:
          '这个对话所在的目录已不在工作目录映射里，本条消息没有执行。把它所在的目录加进 设置 → 远程连接 → 工作目录映射 后再发一次。',
        durationMs: 0,
      };
    } else {
      try {
        outcome = await runner.run({
          ...task.run,
          onProgress,
          onInteraction,
          onInteractionCancel,
          // runner 建/取到 session 后, 拿它真正要跑的那个目录回来问一次 ——
          // 那个目录可能与这里校验过的不是同一个(见 isDirAuthorized 的说明)。
          isDirAuthorized: (dir) => dirStillAllowed(task.connectionId, dir),
        });
      } catch (err) {
        outcome = {
          status: 'error',
          finalText: '',
          errorMessage: err instanceof Error ? err.message : String(err),
          durationMs: 0,
        };
      }
    }
    runningByRequest.delete(requestKey);
    if (!isCurrentGeneration(task.accountGeneration)) {
      cancelRequested.delete(requestKey);
      running.delete(sessionId);
      return;
    }
    // 取消收口: 无论 abort 后 runner 以 ok 还是 error 收口, 对上游统一
    // 报 cancelled(用户按下的是"停止", 中断导致的 error 不是真错误)
    const wasCancelled = cancelRequested.delete(requestKey);
    const status: 'ok' | 'error' | 'cancelled' = wasCancelled ? 'cancelled' : outcome.status;
    // 协议约束: error 必须带非空 errorMessage, ok / cancelled 必须为 null
    const isError = status === 'error';
    // 会话定位说明前置到正文: 协议没有系统消息通道, 而"为什么换了个会话 /
    // 目录变了"必须让渠道里的人看见, 否则只能观察到会话莫名重开。
    const finalText = task.notice
      ? outcome.finalText
        ? `${task.notice}\n\n${outcome.finalText}`
        : task.notice
      : outcome.finalText;
    sendOrBuffer(
      task.connectionId,
      makeTurnEnd({
        requestId: task.requestId,
        externalKey: task.externalKey,
        sessionId,
        status,
        finalText,
        errorMessage: isError ? outcome.errorMessage || 'unknown error' : null,
        usage: { durationMs: outcome.durationMs },
        ...(outcome.attachments !== undefined && outcome.attachments.length > 0
          ? { attachments: outcome.attachments }
          : {}),
      }),
    );
    running.delete(sessionId);
    // 本次执行收口, 免检窗口到此为止。注意**不能**断言"session 一定已落库":
    // 上面可能因映射撤权根本没进 runner, runner 也可能在 createSession 之前就
    // 失败(PR #733 review 指出)。这里删掉只是让后续消息回到正常判定 —— 那两种
    // 情况下 inspect 查不到会话, 走的是丢绑定重建的保守侧, 方向正确。
    awaitingPersist.delete(sessionId);
    const queue = queues.get(sessionId);
    const next = queue?.shift();
    if (!queue || queue.length === 0) queues.delete(sessionId);
    if (next) {
      running.add(sessionId);
      startExecution(next);
    }
  }

  /**
   * 这个目录**此刻**还落在该连接的工作目录映射(或内置对话根)内吗。
   *
   * 每次真正开跑之前都要问一遍: 排队期间用户可能把映射改了或删了, 而队列
   * drain 不再走 resolveTarget, 而会话目录本身没变 —— 变的只是"映射还认不认
   * 它", 所以必须在这里重新查一次当前映射, 否则排着的消息会在已撤权的目录里
   * 执行(PR #733 review 指出)。连接本身没了或被停用, 同样按撤权处理。
   */
  function dirStillAllowed(connectionId: string, dir: string): boolean {
    const config = getConnection(connectionId);
    // 连接被停用 = 用户已经切断了这条远端通道。handleDispatch 入口就这么判,
    // 排队中的任务同样不能因为"目录还在映射里"就照跑(PR #733 review 指出)。
    if (!config || !config.enabled) return false;
    if (Object.values(config.workspaces).some((root) => isPathWithin(root, dir))) return true;
    return dialogue !== undefined && isPathWithin(dialogue.rootDir(), dir);
  }

  function startExecution(task: PendingTask): void {
    const promise = execute(task);
    executing.add(promise);
    void promise.finally(() => executing.delete(promise));
  }

  /**
   * 会话定位(接管 / 绑定复用 / 新建), 返回 run 参数或拒绝原因。
   * notice: 需要随本次 turn.end 一并告知渠道用户的一次性说明(会话被移动 /
   * 旧绑定失效换了新会话) —— 协议没有系统消息通道, 由 execute 前置到 finalText。
   */
  async function resolveTarget(
    connectionId: string,
    config: HookConnectionConfig,
    payload: TaskDispatchPayload,
    generation: number,
  ): Promise<
    | { run: HookRunRequest; notice?: string; cleanupWorktree?: () => Promise<void> }
    | { reject: TaskRejectReason }
  > {
    // options 四元组原样透传给 runner —— 空值由 runner 按桌面端草稿默认落值
    // (取值链: Slack 按目录偏好 > 草稿默认, 权限缺省 bypass; 见
    // hook-control/defaults.ts)。复用/接管路径也照传, 消费与否由 runner 决定
    // (session meta 权威)。
    const agentKind = payload.options?.agentKind ?? null;
    const model = payload.options?.model ?? null;
    const effort = payload.options?.effort ?? null;
    const permissionMode = payload.options?.permissionMode ?? null;
    const origin = {
      connectionId,
      connectionName: config.name,
      externalKey: payload.externalKey,
    };
    const whitelistDirs = Object.values(config.workspaces);
    const inWhitelist = (dir: string | null): boolean =>
      dir !== null && whitelistDirs.some((base) => isPathWithin(base, dir));
    /**
     * 同上, 但每次都重读连接配置 —— 撤权判定必须用**此刻**的映射: `config` 是
     * 消息进来那一刻的快照, 而下面要 await `runner.inspect()`。用快照判定的话,
     * 用户在这段时间里刚把目录加回映射(或改回别名)时, 一条此刻完全合法的绑定
     * 会被当成越界删掉, 那条 thread 就白白换了新对话(PR #733 review 指出)。
     */
    const inWhitelistNow = (dir: string | null): boolean =>
      dir !== null &&
      Object.values(getConnection(connectionId)?.workspaces ?? config.workspaces).some((base) =>
        isPathWithin(base, dir),
      );
    /** app 托管对话目录(dialogues 根)内的路径 —— chat 伪目录会话的白名单等价物。 */
    const inDialogueRoot = (dir: string | null): boolean =>
      dir !== null && dialogue !== undefined && isPathWithin(dialogue.rootDir(), dir);
    // 保留别名「对话」: 不查 config.workspaces, 解析成 app 托管对话目录
    const isChat = payload.workspace === HOOK_CHAT_WORKSPACE_ALIAS && dialogue !== undefined;
    /** 旧绑定作废、本次不得不新建会话时, 随 turn.end 回给渠道的说明。 */
    let recreatedNotice: string | null = null;

    const laneKind: 'dm' | 'group' =
      /^telegram:(group|topic):/.test(payload.externalKey) ? 'group' : 'dm';
    // 接管路径: server 显式指定已有 session(对话会话同样可接管)
    if (payload.sessionId !== null) {
      const info = await runner.inspect(payload.sessionId);
      if (!isCurrentGeneration(generation)) return { reject: 'disabled' };
      if (!info || !info.usable) return { reject: 'session_not_found' };
      if (!inWhitelist(info.workingDir) && !inDialogueRoot(info.workingDir)) {
        return { reject: 'workspace_not_allowed' };
      }
      // 接管路径刚校验过白名单, 授权来源恒为 workspace(远端不能凭接管把会话
      // 带出映射 —— 越界的 sessionId 在上面就被 workspace_not_allowed 打回)
      bindings.set(connectionId, payload.externalKey, payload.sessionId);
      return {
        run: {
          sessionId: payload.sessionId,
          isNew: false,
          laneKind,
          workingDir: info.workingDir as string,
          agentKind,
          model,
          effort,
          permissionMode,
          title: null,
          prompt: payload.prompt,
          attachments: payload.attachments,
          origin,
        },
      };
    }

    // 默认路径: 别名解析(映射即白名单); chat 伪目录不走映射, 目录建会话时分配
    const dir = isChat
      ? undefined
      : payload.workspace
        ? Object.hasOwn(config.workspaces, payload.workspace)
          ? config.workspaces[payload.workspace]
          : undefined
        : undefined;
    if (!dir && !isChat) return { reject: 'unknown_workspace' };

    // v1 stored every mapping under the literal "slack" namespace.  A new
    // account/provider namespace may read it only as a candidate; it is moved
    // after current-account DB existence + workspace allowlist checks pass.
    const legacyNamespace = connectionId.endsWith(':slack') ? 'slack' : null;
    const namespacedBound = bindings.get(connectionId, payload.externalKey);
    const legacyBound =
      namespacedBound === null && legacyNamespace !== null
        ? bindings.get(legacyNamespace, payload.externalKey)
        : null;
    const bound = namespacedBound ?? legacyBound;
    const migrateLegacyBinding = (): void => {
      if (!legacyBound || !legacyNamespace) return;
      bindings.set(connectionId, payload.externalKey, legacyBound);
      bindings.remove(legacyNamespace, payload.externalKey);
    };
    if (bound) {
      const info = await runner.inspect(bound);
      if (!isCurrentGeneration(generation)) return { reject: 'disabled' };
      // 查得到 = 已落库, 此后一律走映射校验
      if (info !== null) awaitingPersist.delete(bound);
      /**
       * 免检窗口里那个会话建在哪 —— 必须拿它跟**当前**映射再比一次: 会话还没
       * 落库的这段时间里用户可能已经把别名改指走了(撤权), 只认 id 的话那条消息
       * 会排进一个建在已撤权目录里的会话(PR #733 review 指出)。
       */
      const pendingDir = awaitingPersist.get(bound) ?? null;
      // 同下方的 inAllowedRoot: 用当前映射而不是入口快照 —— inspect 期间用户可能
      // 刚把这个目录加回来(PR #733 review 指出)。
      const pendingStillAllowed =
        pendingDir !== null && (isChat ? inDialogueRoot(pendingDir) : inWhitelistNow(pendingDir));
      /**
       * 关键竞态防护: 绑定的 session 是本 dispatcher 刚建、**尚未落库**的
       * (inspect 查不到)且正在跑/排队时直接复用 —— 否则同 key 的后续消息会各开
       * 新 session, 破坏「同 key 同 session」铁律。
       *
       * 两层收窄, 都是为了不让免检变成绕过映射边界的口子:
       * - 早期版本把「在跑/排队」整个当成免检快路径, 且放在 inspect 之前。用户在
       *   一轮任务执行期间把对话移出映射时, 新消息仍会排进这个 session —— 而
       *   session-runner 的复用路径以 session meta 的 workDir 为权威(会覆盖这里
       *   传的目录), 那条消息就真的在映射外执行了。
       * - 只判 `info === null` 也不够: 这个 null 是多义的, session 不存在是 null,
       *   meta / DB 读取瞬时失败也被吞成 null。一次读库抖动就能让已落库、已被移出
       *   映射的 session 继续收消息。所以改判 awaitingPersist —— 只有本 dispatcher
       *   刚在映射内建出来、还没确认落库的 session 才免检。
       * 两条都由 PR #733 review 指出。
       */
      if (
        info === null &&
        pendingStillAllowed &&
        namespacedBound !== null &&
        (running.has(bound) || (queues.get(bound)?.length ?? 0) > 0)
      ) {
        return {
          run: {
            sessionId: bound,
            isNew: false,
            laneKind,
            // 尚未落库, 没有 meta 可查 —— 用建它时那个刚重新过完映射校验的目录
            workingDir: pendingDir!,
            agentKind,
            model,
            effort,
            permissionMode,
            title: null,
            prompt: payload.prompt,
            attachments: payload.attachments,
            origin,
          },
        };
      }
      // 复用条件: 仍存在、可用、且仍在白名单内(别名映射可能已被用户改过);
      // chat 伪目录的会话住在 dialogues 根下, 按对话根校验
      // 用 inWhitelistNow 而不是入口快照: 见其定义处 —— inspect 期间映射可能刚
      // 被改回来, 拿旧快照判撤权会误杀一条此刻合法的绑定。
      const inAllowedRoot =
        info !== null &&
        (isChat ? inDialogueRoot(info.workingDir) : inWhitelistNow(info.workingDir));
      const usable = info?.usable === true && info.workingDir !== null;
      /**
       * 复用与否只看这一条: 会话当前的工作目录仍落在工作目录映射(或内置对话根)
       * 内。判定完全无状态 —— 绑定里不存快照也不存授权, 每条消息现场重算。
       *
       * 刻意**不**支持「被移出映射后继续跟随」: 那需要在映射之外发放一条例外,
       * 而例外必须跨「绑定文件」与「会话库」两次无事务的写保持一致, 中间还夹着
       * 随时可能到达的 IM 消息 —— PR #653 / #669 为此叠了在途标记、TTL、回滚、
       * CAS、补偿五层状态, 十轮 review 仍在出新的组合边界。现在的语义是: 移出
       * 映射 = 断开绑定, 并向渠道说明怎么恢复(见 NOTICE_SESSION_RECREATED)。
       * 在映射**内**换目录仍然无感跟随, 因为那本就在边界内。
       */
      if (usable && inAllowedRoot) {
        const workingDir = info!.workingDir!;
        migrateLegacyBinding();
        return {
          run: {
            sessionId: bound,
            isNew: false,
            laneKind,
            workingDir,
            agentKind,
            model,
            effort,
            permissionMode,
            title: null,
            prompt: payload.prompt,
            attachments: payload.attachments,
            origin,
          },
        };
      }
      bindings.remove(connectionId, payload.externalKey);
      if (legacyNamespace) bindings.remove(legacyNamespace, payload.externalKey);
      // 旧绑定作废后下面会新建会话 —— 渠道侧只会看到"换了个会话"却无从得知
      // 原因, 因此带一条说明随本次 turn.end 回去(见 execute)。
      recreatedNotice = info?.usable ? NOTICE_SESSION_RECREATED : NOTICE_SESSION_GONE;
      log.info(
        `hook binding for ${payload.externalKey} dropped: session ${bound} ${
          info?.usable ? 'left the workspace map' : 'is gone or archived'
        }`,
      );
    }

    // 新建会话: 默认为它预建独立 git worktree —— 每个 thread/会话一个隔离
    // 工作树, 多任务并发执行互不踩文件。预建失败(非 git 目录 / git 未装 /
    // 建分支失败)回退共享工作区目录, 只记日志不拒单。
    // 守卫: worktree 必须落在别名目录内(isPathWithin), 否则复用路径的白名单
    // 重校验(inWhitelist(info.workingDir))会拒掉它, 导致同 key 每条消息都
    // 重新建会话 —— 别名映射到仓库子目录时 worktree 建在仓库根下就会越界,
    // 这种配置直接回退共享目录。
    let sessionId: string = randomUUID();
    let runDir: string;
    if (isChat) {
      // chat 伪目录: 每会话分配独立的 app 托管对话目录(不落任何仓库);
      // 天然无并发踩踏, 不做 worktree 预建
      runDir = await dialogue!.allocateDir(sessionId);
      if (!isCurrentGeneration(generation)) return { reject: 'disabled' };
      log.info(`hook chat session ${sessionId} gets dialogue dir: ${runDir}`);
    } else {
      runDir = dir as string;
    }
    /** 预建成功的 worktree 回收句柄, 随任务带下去(见 PendingTask.cleanupWorktree)。 */
    let cleanupWorktree: (() => Promise<void>) | undefined;
    if (prepareWorktree && !isChat && dir !== undefined) {
      const prep = await prepareWorktreeSerial(dir);
      if (!isCurrentGeneration(generation)) {
        if (prep.ok) await prep.cleanup().catch(() => undefined);
        return { reject: 'disabled' };
      }
      if (prep.ok && isPathWithin(dir, prep.path)) {
        sessionId = prep.sessionId;
        runDir = prep.path;
        cleanupWorktree = () => prep.cleanup();
        log.info(`hook session ${sessionId} gets dedicated worktree: ${prep.path}`);
      } else {
        const why = prep.ok
          ? `worktree ${prep.path} escapes workspace dir ${dir} (alias maps to a repo subdirectory?)`
          : prep.message;
        log.warn(`worktree unavailable, falling back to shared workspace dir: ${why}`);
        // 越界时回收已创建的 worktree(目录 + 分支 + store 条目), 防孤儿泄漏
        if (prep.ok) void prep.cleanup().catch(() => undefined);
      }
    }
    // 新建会话跑在别名目录(或对话根)里, 是否还能复用每次现场按映射判定
    bindings.set(connectionId, payload.externalKey, sessionId);
    // 落库前的免检窗口从这里开始(见 awaitingPersist 声明处): 此刻这个 session
    // 必定建在映射内, inspect 还查不到它, 同 key 的后续消息要能认出它。记下它
    // 建在哪 —— 免检时要拿这个目录跟当时的映射再比一次。
    awaitingPersist.set(sessionId, runDir);
    // 标题带 provider 名: externalKey 约定为 `<providerId>:<渠道内标识>`,
    // 取前缀作 provider 名(如 team-slack), 比连接名(desktop 侧命名)更能
    // 说明"这条会话是谁驱动的"; 无前缀(非常规 key)时回退连接名
    const colon = payload.externalKey.indexOf(':');
    const providerName =
      payload.source?.im?.trim() || (colon > 0 ? payload.externalKey.slice(0, colon) : config.name);
    const bareKey = colon > 0 ? payload.externalKey.slice(colon + 1) : payload.externalKey;
    return {
      run: {
        sessionId,
        isNew: true,
        laneKind,
        workingDir: runDir,
        agentKind,
        model,
        effort,
        permissionMode,
        ...(isChat ? { workspaceKind: 'dialogue' as const } : {}),
        ...(payload.workspace ? { workspaceAlias: payload.workspace } : {}),
        title: buildHookSessionTitle(
          providerName,
          payload.prompt,
          bareKey,
          payload.source?.teamName ??
            (payload.source?.im === 'telegram' ? payload.source.channelName : null),
        ),
        prompt: payload.prompt,
        attachments: payload.attachments,
        origin,
      },
      ...(recreatedNotice ? { notice: recreatedNotice } : {}),
      ...(cleanupWorktree ? { cleanupWorktree } : {}),
    };
  }

  function handleDispatch(
    connectionId: string,
    payload: TaskDispatchPayload,
    send: (m: HookMessage) => boolean,
  ): void {
    if (!accountActive) return;
    const admittedGeneration = accountGeneration;
    const source = payload.source === undefined ? undefined : normalizeTaskSource(payload.source);
    const dispatchPayload = source === undefined ? payload : { ...payload, source };
    sendFns.set(connectionId, send);

    // 幂等: 已回过 ack 的重投只回放, 不重跑
    const rKey = ackKey(connectionId, payload.requestId);
    const replay = ackHistory.get(rKey);
    if (replay) {
      send(makeTaskAck(replay));
      return;
    }
    // in-flight 窗口(首条还没回 ack)内的重投直接忽略 —— 首条处理完的 ack
    // 即应答; 不占位的话同 tick 重投会完整重跑(验证复现过)
    if (inflightRequests.has(rKey)) return;
    inflightRequests.add(rKey);

    const config = getConnection(connectionId);
    if (!config || !config.enabled) {
      reply(connectionId, send, rejected(payload.requestId, 'disabled'));
      return;
    }

    // 同 key 串行化(见 keyChains 注释) —— 定位+入队作为一个原子段执行
    serializeByKey(`${connectionId} ${payload.externalKey}`, async () => {
      try {
        let contextPrefix = '';
        let commitContextCursor: () => void = () => undefined;
        if (buildContextPrefix) {
          try {
            const assembly = await buildContextPrefix(dispatchPayload);
            contextPrefix = assembly.prefix;
            commitContextCursor = assembly.commit;
          } catch (error) {
            log.warn(`group context prefix failed, dispatching without it: ${String(error)}`);
          }
        }
        const resolved = await resolveTarget(
          connectionId,
          config,
          dispatchPayload,
          admittedGeneration,
        );
        // Account shutdown may complete while inspect/worktree preparation is
        // awaiting.  Suppress both the stale ack and every downstream write.
        if (!isCurrentGeneration(admittedGeneration)) return;
        if ('reject' in resolved) {
          reply(connectionId, send, rejected(payload.requestId, resolved.reject));
          log.info(
            `dispatch rejected (${resolved.reject}): conn=${connectionId} requestId=${payload.requestId}`,
          );
          return;
        }
        const task: PendingTask = {
          connectionId,
          requestId: payload.requestId,
          externalKey: payload.externalKey,
          run: {
            ...resolved.run,
            ...(contextPrefix ? { prompt: `${contextPrefix}${resolved.run.prompt}` } : {}),
            ...(source ? { source } : {}),
          },
          accountGeneration: admittedGeneration,
          ...(resolved.notice ? { notice: resolved.notice } : {}),
          ...(resolved.cleanupWorktree ? { cleanupWorktree: resolved.cleanupWorktree } : {}),
        };
        const sessionId = resolved.run.sessionId;
        const queue = queues.get(sessionId) ?? [];

        if (running.has(sessionId) || runner.isBusy(sessionId) || queue.length > 0) {
          if (queue.length >= MAX_QUEUE_PER_SESSION) {
            reply(connectionId, send, rejected(payload.requestId, 'invalid'));
            log.warn(`dispatch queue overflow: session=${sessionId}`);
            return;
          }
          queue.push(task);
          queues.set(sessionId, queue);
          commitContextCursor();
          reply(connectionId, send, {
            requestId: payload.requestId,
            result: 'queued',
            reason: null,
            sessionId,
            queuePosition: queue.length - 1,
          });
          // 排队时目标 session 可能是 desktop 侧用户手动在跑(runner.isBusy),
          // 没有本模块的收口点 —— 轮询兜底: 空闲即 drain
          if (!running.has(sessionId)) scheduleDrainPoll(sessionId);
          return;
        }

        running.add(sessionId);
        commitContextCursor();
        reply(connectionId, send, {
          requestId: payload.requestId,
          result: 'accepted',
          reason: null,
          sessionId,
          queuePosition: null,
        });
        startExecution(task);
      } catch (err) {
        if (!isCurrentGeneration(admittedGeneration)) return;
        log.warn(`handleDispatch failed: ${err instanceof Error ? err.message : String(err)}`);
        reply(connectionId, send, rejected(payload.requestId, 'invalid'));
      }
    });
  }

  /** 用户手动 turn 占用 session 时的排队兜底: 定时探测空闲后 drain。 */
  const drainPolls = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleDrainPoll(sessionId: string): void {
    if (drainPolls.has(sessionId)) return;
    const timer = setTimeout(() => {
      drainPolls.delete(sessionId);
      if (running.has(sessionId)) return; // 本模块正在跑, 收口时自然 drain
      if (runner.isBusy(sessionId)) {
        scheduleDrainPoll(sessionId);
        return;
      }
      const queue = queues.get(sessionId);
      const next = queue?.shift();
      if (!queue || queue.length === 0) queues.delete(sessionId);
      if (next) {
        running.add(sessionId);
        startExecution(next);
        // execute 收口自己会继续 drain
      }
    }, 2000);
    timer.unref?.();
    drainPolls.set(sessionId, timer);
  }

  return {
    handleDispatch,
    activateAccount() {
      if (accountActive) return;
      if (accountDeactivation !== null) {
        const requestedGeneration = accountGeneration;
        void accountDeactivation.then(() => {
          if (requestedGeneration === accountGeneration) accountActive = true;
        });
        return;
      }
      accountActive = true;
    },
    async deactivateAccount() {
      // Invalidate a deferred activation on every close request, including a
      // duplicate request that arrives while the physical drain is running.
      const wasActive = accountActive;
      accountActive = false;
      accountGeneration += 1;
      if (accountDeactivation !== null) {
        await accountDeactivation;
        return;
      }
      if (!wasActive) return;

      for (const timer of drainPolls.values()) clearTimeout(timer);
      drainPolls.clear();
      queues.clear();
      sendFns.clear();
      pendingTurnEnds.clear();

      const drain = (async (): Promise<void> => {
        const aborts: Promise<void>[] = [];
        if (abortSession) {
          for (const { sessionId } of runningByRequest.values()) {
            aborts.push(
              abortSession(sessionId).catch((err) => {
                log.warn(
                  `account-boundary abort failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              }),
            );
          }
        }
        await Promise.allSettled(aborts);
        await Promise.allSettled([...keyChains.values()]);
        await Promise.allSettled([...executing]);

        ackHistory.clear();
        inflightRequests.clear();
        running.clear();
        runningByRequest.clear();
        cancelRequested.clear();
        // 切账号时 execute() 会在代际检查处提前 return, 走不到收口那行删除 ——
        // 不在这里清的话, 每次切账号都永久留下一条 sessionId + 完整工作目录路径
        // (PR #733 review 指出)。这些会话属于上一个账号, 新账号下本就不该免检。
        awaitingPersist.clear();
        keyChains.clear();
      })();
      accountDeactivation = drain.finally(() => {
        accountDeactivation = null;
      });
      await accountDeactivation;
    },
    handleSessionArchive(connectionId, externalKey) {
      if (!accountActive) return;
      const admittedGeneration = accountGeneration;
      // 与 dispatch 同 key 串行: 避免在途 resolveTarget(即将落绑定建会话)与
      // 归档并发穿插 —— 归档排在其后, 能看到刚落下的绑定。
      serializeByKey(`${connectionId} ${externalKey}`, async () => {
        if (!isCurrentGeneration(admittedGeneration)) return;
        /**
         * 这个会话此刻还归远端管吗 —— 归档同样要过工作目录映射这道边界。
         * 会话已被移出映射(或映射被改/删)时, 远端的 `/new` 不该还能归档它并
         * 触发 worktree 清理: 那是对一个它已无权驱动的本地会话动手
         * (PR #733 review 指出)。
         */
        const stillOurs = async (sessionId: string): Promise<boolean> => {
          const info = await runner.inspect(sessionId);
          if (!isCurrentGeneration(admittedGeneration)) return false;
          // 查得到就以它为准。**只有**真的查不到(会话刚建、还没落库)才退回
          // awaitingPersist 里记的那个目录 —— 该表在整轮 turn 结束前都留着, 拿它
          // 当捷径会让"已落库、随后被移出映射"的会话绕过这道闸
          // (PR #733 review 指出)。
          if (info === null) {
            const pendingDir = awaitingPersist.get(sessionId);
            return pendingDir !== undefined && dirStillAllowed(connectionId, pendingDir);
          }
          return (
            info.usable === true &&
            info.workingDir !== null &&
            dirStillAllowed(connectionId, info.workingDir)
          );
        };
        let bindingNamespace = connectionId;
        let bound = bindings.get(connectionId, externalKey);
        if (!bound && connectionId.endsWith(':slack')) {
          const legacyBound = bindings.get('slack', externalKey);
          if (legacyBound) {
            // `/new` can be the first post-upgrade event, before dispatch had
            // a chance to migrate the v1 mapping. Only act on that mapping
            // after proving it belongs to the current account DB and remains
            // inside today's workspace/dialogue allowlist.
            if (await stillOurs(legacyBound)) {
              bound = legacyBound;
              bindingNamespace = 'slack';
            } else {
              if (!isCurrentGeneration(admittedGeneration)) return;
              bindings.remove('slack', externalKey);
            }
          }
        }
        if (!bound) return; // 该 key 从没建过会话(或已归档清理过), 幂等 no-op
        // 当前命名空间的绑定过同一道闸: 通不过就只丢绑定(下条消息本就会重开
        // 会话), 但不动那个已越界的本地会话。
        const authorized = bindingNamespace === 'slack' || (await stillOurs(bound));
        if (!isCurrentGeneration(admittedGeneration)) return;
        bindings.remove(bindingNamespace, externalKey);
        if (!authorized) {
          log.info(
            `hook archive skipped for ${externalKey}: session ${bound} is no longer inside the workspace map`,
          );
          return;
        }
        if (!archiveSessionRow) return;
        try {
          await archiveSessionRow(bound);
          log.info(`hook session ${bound} archived`);
        } catch (err) {
          // 典型: 会话行尚未建成(任务在跑)或已被删 —— 只记日志, 不回推错误
          log.warn(
            `archive hook session ${bound} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    },
    handleInteractionDecision(connectionId, payload) {
      if (!accountActive) return;
      // 归属校验: requestId 必须是本连接正在执行的任务(排队中的任务不可能有
      // 未决交互 —— 交互只在 turn 执行期产生)
      const runningEntry = runningByRequest.get(ackKey(connectionId, payload.requestId));
      if (runningEntry === undefined || runningEntry.connectionId !== connectionId) {
        log.info(
          `interaction.decision for unknown/foreign requestId ${payload.requestId}, ignored`,
        );
        return;
      }
      if (!resolveInteraction) {
        log.warn('interaction.decision ignored (no resolveInteraction wired)');
        return;
      }
      const resolved = resolveInteraction(payload.interactionId, payload.buttonId);
      log.info(
        `interaction.decision ${payload.interactionId} button=${payload.buttonId} resolved=${resolved}`,
      );
    },
    cancel(connectionId, requestId) {
      if (!accountActive) return;
      // 1) 排队中的: 从队列摘除, 立即回 cancelled(任务从未开始)
      for (const [sessionId, queue] of queues) {
        const idx = queue.findIndex(
          (t) => t.requestId === requestId && t.connectionId === connectionId,
        );
        if (idx >= 0) {
          const [task] = queue.splice(idx, 1);
          if (queue.length === 0) queues.delete(sessionId);
          sendOrBuffer(
            connectionId,
            makeTurnEnd({
              requestId: task.requestId,
              externalKey: task.externalKey,
              sessionId: task.run.sessionId,
              status: 'cancelled',
              finalText: '',
              errorMessage: null,
              usage: { durationMs: null },
            }),
          );
          log.info(`hook task ${requestId} cancelled while queued`);
          return;
        }
      }
      // 2) 执行中的: 标记取消 + abort session, execute 收口时改写为 cancelled
      const requestKey = ackKey(connectionId, requestId);
      const runningEntry = runningByRequest.get(requestKey);
      // 归属校验: 只有派发该任务的连接才能取消它(多连接并存时的授权边界)
      if (runningEntry !== undefined && runningEntry.connectionId === connectionId) {
        const sessionId = runningEntry.sessionId;
        cancelRequested.add(requestKey);
        log.info(`hook task ${requestId} cancel requested (aborting session ${sessionId})`);
        if (abortSession) {
          void abortSession(sessionId).catch((err) => {
            log.warn(
              `abortSession failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
        return;
      }
      // 3) 未知 / 已收口: 静默(server 侧幂等)
      log.info(`hook cancel for unknown/finished requestId ${requestId}, ignored`);
    },
    onDisconnected(connectionId) {
      sendFns.delete(connectionId);
    },
    onConnected(connectionId, send) {
      if (!accountActive) return;
      sendFns.set(connectionId, send);
      const buf = pendingTurnEnds.get(connectionId);
      if (!buf?.length) return;
      // 按序补发; 发送失败(又断了)停下, 剩余留在缓存
      while (buf.length > 0) {
        if (!send(buf[0])) break;
        buf.shift();
      }
      if (buf.length === 0) pendingTurnEnds.delete(connectionId);
    },
  };
}
