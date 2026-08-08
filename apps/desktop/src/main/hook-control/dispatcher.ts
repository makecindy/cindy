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
 *      - 带 sessionId(接管): 可用 session 的工作目录必须落在本连接注册的
 *        别名路径内(白名单不因接管放松), 通过后把 externalKey 重绑到它;
 *        session 已失效时从受管目录静默新建任务并重绑;
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
 *      turn.progress 直发(不缓存不补发, 装饰性信息丢了无害)。**例外**: 续跑轮
 *      (turn.reopen)的 turn.end 也直发不缓存 —— 那条渠道消息在断连瞬间已被
 *      server 的孤儿收口改写并解绑 requestId, 补发只会被当未知 id 丢弃。
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
  type MessageOpResultPayload,
  type TelegramEmojiReactions,
  makeTurnEnd,
  makeTurnProgress,
  makeTurnReopen,
  HOOK_FEATURE_TURN_DELIVERY,
  HOOK_FEATURE_TURN_REOPEN,
  type HookMessage,
  type HookTurnEndMessage,
  type InteractionButton,
  type InteractionDecisionPayload,
  type TaskAckPayload,
  type TaskAttachment,
  type TaskDispatchPayload,
  type TaskRejectReason,
  type TaskSource,
  type TurnDeliveryPayload,
  type TurnEndPayload,
} from '@cindy/slack-hook-protocol';

import { HOOK_CHAT_WORKSPACE_ALIAS } from '../../shared/hookControlIpc.js';
import type { GroupHistoryAccessScope } from '../im/shared/groupHistoryAccess.js';
import { groupHistoryAccessForExternalKey } from './groupHistoryScope.js';
import { isPathWithin } from './paths.js';
import { createAckReactions, type AckReactionTask } from './ackReactions.js';
import type { HookConnectionConfig } from './store.js';
import type { HookBindingStore } from './bindings.js';
import type { HookRequestLedger, HookTerminalRecord } from './requestLedger.js';

/** 会话执行器抽象 —— 生产实现 session-runner.ts(包 maker), 测试注入假的。 */
export interface HookSessionRunner {
  /** 目标 session 是否正在跑 turn。 */
  isBusy(sessionId: string): boolean;
  /**
   * 会话现状: null = 不存在; usable=false = 不可投递(已归档/删除、SSH remote、
   * Orca worker 等);
   * workingDir 用于接管/复用时的白名单校验。检查失败会 reject, 上层必须
   * fail closed 并保留既有 binding, 不能把暂时读不到当成失效任务。
   */
  inspect(sessionId: string): Promise<{ workingDir: string | null; usable: boolean } | null>;
  /** 跑一个完整 turn, 收口(done / terminal error)后返回。 */
  run(req: HookRunRequest): Promise<HookRunOutcome>;
  /**
   * 观察一次「桌面端续跑」并把过程与结果回流(turn.reopen 链路, 见协议阶段 18)。
   * 返回撤销函数(幂等)。未实现 = 该 runner 不支持回流, dispatcher 自动降级为
   * 旧行为(渠道消息停在失败上)。
   */
  watchContinuation?(req: HookContinuationWatchRequest): () => void;
}

/**
 * 一次续跑观察。dispatcher 在收到「用户在桌面端续跑了这个会话」信号后发起,
 * runner 负责挂事件监听。
 *
 * 回调契约(dispatcher 依赖它来保证渠道消息不会卡在假的"进行中"):
 *   - onClaim 最多一次, 在**观察器已就绪、这一轮确实要跑起来**时调。生产实现的调用
 *     点是 pre-dispatch 归属点(dispatcher 已按 clientId 认定目标轮, vendor dispatch
 *     即将发生), 所以不必也不该再等首个事件 —— 事件流是会话级的, 用"首个事件"当
 *     认领判据反而会把别的轮次认成这一轮(那正是本能力早先的误认来源)。
 *     会话已不在进程里 / 目录已撤权这类"压根跑不起来"的情形走 onAbandon;
 *   - onClaim 调过之后, 必然恰好有一次 onEnd(正常收口 / 错误 / 硬超时);
 *   - onClaim 没调过时, 必然恰好有一次 onAbandon(会话已不在 / 目录已撤权 / 被撤销)。
 */
export interface HookContinuationWatchRequest {
  sessionId: string;
  /** 原任务的目录(出站附件的允许根; runner 会用 live session 的实际目录复核)。 */
  workingDir: string;
  /** 原任务的来源标注(决定 Telegram / Slack 的进度渲染差异)。 */
  source?: TaskSource;
  /** 原任务的渠道形态; 与 run() 同判据地决定群轮次是否取 turn lease。 */
  laneKind?: 'dm' | 'group';
  /**
   * "这个目录此刻还在本连接的工作目录映射内吗" —— 与 run() 的同名回调同语义, 用来
   * 复核**真正要观察的那个 live session 的 workDir**。
   *
   * 必须复核: 记账里存的是失败那一轮的持久化目录, 而 live 实例可能仍跑在搬迁前的
   * 旧目录里(run() 因 PR #733 review 已加这道校验)。若旧目录已被移出映射、而新目录
   * 仍在, 只查记账就会放行, 于是续跑的输出与文件从一个已撤销的目录回流到渠道。
   */
  isDirAuthorized?: (dir: string) => boolean;
  /** 观察器已就绪、这一轮就要跑起来 —— 此刻认领渠道那条消息(见上面的回调契约)。 */
  onClaim: () => void;
  /** 执行中渲染快照(仅 onClaim 之后)。 */
  onProgress: (text: string) => void;
  /**
   * 已停止观察, 但终态还没算完(成功收口要先异步收集出站附件)。同步调, 且必然先于
   * onEnd / onAbandon。
   *
   * dispatcher 用它把这一轮从"在观察"的账上摘掉, 从而让「表里还有这一轮」严格等价于
   * 「它仍在观察」—— 有个推断依赖这个等价: 另一条用户轮居然 dispatch 了, 说明我们这轮
   * 已不是活跃轮, 于是判定被 Stop 顶掉并就地收口。少了这一步, 附件收集那段时间里它还
   * 挂在表上, 排在后面的桌面消息一 dispatch 就会被误判成顶替
   * (review: "附件收集期间误判顶替")。发帧的闭包不受影响, 迟到的 onEnd 照样如实收口。
   */
  onSettling?: () => void;
  /** 收口(仅 onClaim 之后)。 */
  onEnd: (outcome: HookRunOutcome) => void;
  /** 一个事件都没等到就放弃(onClaim 未发生)。 */
  onAbandon: () => void;
}

export interface HookRunRequest {
  sessionId: string;
  /**
   * IM lane 形态(externalKey 派生): 'group' = 群/topic, 'dm' = 私聊。
   * runner 据此决定群轮次是否取 turn lease(见 deriveLaneKind 的注释)。
   * 缺省按 'dm' 保守处理。
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
  /** 官方 Telegram 群轮次的 lane-only 群历史检索作用域。 */
  groupHistoryAccess?: GroupHistoryAccessScope;
  /**
   * provider 已实际接受本次发送后的副作用。runner 只在 send outcome
   * 确认为 dispatched 后 await；失败必须由调用方自行降级，不能反转已受理 turn。
   */
  onProviderAccepted?: () => void | Promise<void>;
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
  /** Durable terminal request state, injected by the Electron owner boundary. */
  terminalLedger?: HookRequestLedger;
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
   * 失败或空装配 = 无前缀, 绝不因上下文拒单。两条路径都只在 provider
   * 实际受理后提交；拒单、取消或清队列都不推进窗口游标。
   */
  buildContextPrefix?: (payload: TaskDispatchPayload) => Promise<{
    prefix: string;
    commit: (
      guard?: () => boolean | Promise<boolean>,
    ) =>
      | void
      | { rollback(): void | Promise<void> }
      | Promise<void | { rollback(): void | Promise<void> }>;
  }>;
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
   * 可选: 订阅「用户在桌面端显式续跑了某会话」信号(生产为 maker-ipc 的
   * onUiContinuation)。未注入 = 不做续跑回流, 渠道消息停在失败上(旧行为)。
   * 返回退订函数, dispose 时调用。
   */
  subscribeUiContinuation?: (listener: (sessionId: string, clientId: string) => void) => () => void;
  /**
   * 可选: 订阅「桌面端在某会话里做了与续跑无关的事」(生产为 maker-ipc 的
   * onUiSessionIntervention)。命中即作废该会话的待续跑记账 —— 记账只按 sessionId
   * 记, 而普通桌面 turn 不经本模块; 没有这条, 一笔失败记账会一直躺着, 直到用户在
   * 跑过别的 turn **之后**点重试, 那时会把那个无关 turn 的输出写进渠道原消息。
   */
  subscribeUiSessionIntervention?: (listener: (sessionId: string) => void) => () => void;
  /**
   * 可选: 订阅「这条消息即将 vendor dispatch」(生产为 maker-ipc 的 onUiTurnDispatching)。
   *
   * 这是续跑回流的**权威归属点**。续跑意图信号只说"用户点了重试", 说不出后面哪一轮
   * 才是它 —— 观察器是会话级的, 靠"首个事件"认会把绕过 coordinator 的 turn
   * (silent-stop 自动续跑)误认成目标轮。改用 clientId 匹配: 对上了才挂观察、才认领,
   * 而本回调发生在 dispatch **之前**且被 await, 所以既不丢正文开头, live session 也
   * 必然已就绪(马上就要 dispatch)。
   */
  subscribeUiTurnDispatching?: (
    listener: (sessionId: string, clientId: string) => void,
  ) => () => void;
  /**
   * 可选: 订阅「这条消息落库了却没能 dispatch」(取消 / 派发失败)。目标轮没起来,
   * 记账立刻还回去 —— 不必等任何超时, 也不会把回流永久丢掉。
   */
  subscribeUiTurnUndispatched?: (
    listener: (sessionId: string, clientId: string) => void,
  ) => () => void;
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
  /**
   * 连接握手完成(welcome)后调用: 更新发送函数并补发离线期间积压的 turn.end。
   * features 为该连接本次 welcome 宣告的能力集(缺省 = 空, 按老 server 处理)——
   * turn.reopen 只在 server 宣告支持时才用。
   */
  onConnected(
    connectionId: string,
    send: (m: HookMessage) => boolean,
    features?: readonly string[],
  ): void;
  /** transport 离线或失去已协商能力时调用，禁止继续向旧 socket 发送帧。 */
  onDisconnected(connectionId: string): void;
  /**
   * msg.op.result: 消息操作的回执。当前只有 ack 表情用它 —— 表情是纯装饰,
   * 失败只记一行, 不重试、不影响任务本身。
   */
  onMessageOpResult(payload: MessageOpResultPayload): void;
  /**
   * 用户的表情档位(off / minimal / expressive)。服务端经 provider.behavior.state
   * 下发, manager 收到即转告。
   *
   * `null` = **有效值还不知道**(连接刚起、behavior.state 还没到)。这时一帧都
   * 不发: 拿基线先斩后奏, 设置里关掉表情的用户会在每次重启后又被打一次。
   */
  setEmojiReactionsMode(mode: TelegramEmojiReactions | null): void;
  /**
   * 在 manager 关 transport / 重置档位**之前**结清 👀 欠账。
   *
   * deactivateAccount 里那次 onAccountTeardown 是兜底 —— 走到那里时 manager
   * 已经 reset 了档位(null → 一帧不发)、stopAll 也删光了发送函数, 什么都发
   * 不出去。真正有效的结账必须在两者之前, 由 manager 显式触发。幂等: opId
   * 不变, 服务端去重, 兜底那次重复发也只是同一答复。
   */
  settleAckReactions(): void;
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
  /** X server 对普通 turn.end 的持久接管 / 渠道发布状态回执。 */
  handleTurnDelivery(connectionId: string, payload: TurnDeliveryPayload): void;
  /** Re-open ingress after the next account DB is ready. */
  activateAccount(): void;
  /** Close ingress, abort old-account turns and await their final async boundary. */
  deactivateAccount(): Promise<void>;
  /**
   * 彻底弃用本 dispatcher(退订进程级信号源)。与 deactivateAccount 不同:
   * 后者是账号边界、之后还会 activate 回来, 本方法之后这个实例不再被使用。
   * 幂等。
   */
  dispose(): void;
}

/** 单 session 排队上限 —— 超过按 rejected(invalid) 打回, 防失控上游刷爆。 */
const MAX_QUEUE_PER_SESSION = 20;
/** 单连接离线 turn.end 缓存上限(FIFO 丢最老)。 */
const MAX_PENDING_TURN_ENDS = 100;
/** ACK 能力启用后，普通 turn.end 在未获 server 接管确认前的首轮等待。 */
const TURN_DELIVERY_ACK_TIMEOUT_MS = 10_000;
/** 重发退避封顶；完整正文仍保留到 ACK、账号切换或容量淘汰。 */
const TURN_DELIVERY_ACK_MAX_DELAY_MS = 60_000;

/**
 * 失败任务的续跑记账保留时长。
 *
 * 用户看到渠道里那条失败消息、打开桌面端点「重试」, 中间可能隔很久(下班前失败,
 * 第二天早上才处理)。取 24h 让"当天内回来点重试"都能接回; 更久的意义不大, 而且
 * server 侧那条消息的位置映射也未必还在(它认不出 reopenOf 时会静默忽略, 所以两端
 * TTL 不必对齐, 最坏就是回到"消息停在失败上")。
 */
const REOPEN_TTL_MS = 24 * 60 * 60_000;
/** 续跑记账条数上限(FIFO 淘汰最老), 同 ackHistory 语义: 防长驻进程无界增长。 */
const MAX_PENDING_REOPENS = 200;
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
  'ℹ️ 原任务已不在可用的工作目录里，这条消息起换用了新任务，原任务的上下文不会带过来。' +
  '想接回原任务：先到 Cindy 的 设置 → 远程连接 → 工作目录映射 把它所在的目录加进来，' +
  '再在这里选择任务重新指定它。';
/**
 * 查不到原对话时的说明。措辞刻意留了余地: inspect 返回 null 是多义的 ——
 * 会话真的没了是 null, meta / DB 读取瞬时失败也被吞成 null(session-runner
 * 两路都 catch)。一口咬定"已被归档或删除"会在读库抖动时误导用户
 * (PR #733 review 指出)。
 */
const NOTICE_SESSION_GONE = 'ℹ️ 原任务现在读不到（可能已被归档或删除），这条消息起换用了新任务。';

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
 *
 * **摘要取 `source.userText`, 而不是 `prompt`。** 二者通常一致, 但 server 会在
 * prompt 前面挂 thread 上下文块(Slack 的 `injectThreadContext` 一直如此, X 也
 * 刚接上): 那时 `prompt` 开头是 `<thread_context>` 加一串别人的发言, 截前 24
 * 字得到的标题既看不出是什么任务, 同一 thread 里还条条雷同。`userText` 正是
 * server 为 UI 单独下发的干净原文(协议 `TaskSource.userText`)。
 * 老 server 不下发时回退 prompt, 行为与此前一致。
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

type ContextCursorReceipt = { rollback(): void | Promise<void> };
type ContextCursorCommit = (
  guard?: () => boolean | Promise<boolean>,
) => void | ContextCursorReceipt | Promise<void | ContextCursorReceipt>;

/** 待执行任务(定位已完成, 排队即执行参数就绪)。 */
interface PendingTask {
  connectionId: string;
  requestId: string;
  /** ACK sent when this task was accepted or queued; persisted at terminal state. */
  ack: TaskAckPayload;
  externalKey: string;
  run: HookRunRequest;
  accountGeneration: number;
  /** 群上下文游标提交回调；仅在 provider 实际受理后调用。 */
  commitContextCursor?: ContextCursorCommit;
  /** 会话定位阶段产生的一次性说明, 前置到本次 turn.end 的 finalText。 */
  notice?: string;
  /**
   * 派活被接下那一刻, 这条连接宣告过 turn.reopen 吗。
   *
   * 必须在**接活时**取快照, 不能等失败收口时再查 serverFeatures: 连接可能在 turn 跑到
   * 一半时断掉, 而 onDisconnected 会清掉能力快照(滚动发布时重连可能落到不宣告
   * turn.reopen 的老实例上, 所以那个清理是对的)。此时失败的 turn.end 走 sendOrBuffer
   * 缓存、重连后补发, 渠道里确实会显示失败 —— 却因为查不到能力而没记待续跑, 用户点
   * 重试就接不回来(review: "Preserve reopen state for failures completed while
   * disconnected")。能力在重连后是否仍然成立, 由续跑发起时按当时的 serverFeatures 复核。
   */
  reopenCapable: boolean;
  /**
   * 本次定位为新会话预建的 worktree 的回收句柄。**只在这个任务最终没能进
   * runner 时调用** —— 正常执行时 worktree 归会话所有, 不能回收。少了它,
   * 执行前的映射收口一旦拦下任务, 刚建好的 worktree 目录与分支就成了没有会话
   * 认领的孤儿, 反复改映射会累积(PR #733 review 指出)。
   */
  cleanupWorktree?: () => Promise<void>;
}

interface PendingTurnEnd {
  message: HookTurnEndMessage;
  terminal: Omit<HookTerminalRecord, 'completedAt' | 'delivery'>;
}

/** 一条等待续跑的失败任务(见 pendingReopens)。 */
/**
 * 渠道形态(dm / group)—— 只看 externalKey 的前缀形状, 不查任何状态。
 *
 * **唯一用途**: 官方 Telegram 群轮次在 send 时取 session turn lease, 把
 * 「前台 done → 后台任务续跑」这段空窗也算作本轮独占, 否则 Desktop 轮次会被
 * 放进来与它共享 session 事件流 / origin / 交互路由(codex review #1490)。
 * 与权限档**无关** —— 群轮次不再改用户配的权限模式(见 session-runner)。
 * execute() 与续跑观察共用同一判据, 分叉会让续跑轮丢掉这层独占。
 */
function deriveLaneKind(externalKey: string): 'dm' | 'group' {
  return /^telegram:(group|topic):/.test(externalKey) ? 'group' : 'dm';
}

interface PendingReopen {
  connectionId: string;
  /** 失败那一轮的 requestId —— server 用它定位渠道里那条消息(reopenOf)。 */
  requestId: string;
  externalKey: string;
  /** 那一轮真正跑的目录(执行前还要按当前映射复核一次)。 */
  workingDir: string;
  source?: TaskSource;
  accountGeneration: number;
  expiresAt: number;
}

export function createHookDispatcher(deps: HookDispatcherDeps): HookDispatcher {
  const {
    getConnection,
    bindings,
    terminalLedger,
    runner,
    prepareWorktree,
    buildContextPrefix,
    dialogue,
    abortSession,
    archiveSessionRow,
    resolveInteraction,
    subscribeUiContinuation,
    subscribeUiSessionIntervention,
    subscribeUiTurnDispatching,
    subscribeUiTurnUndispatched,
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

  /** (connectionId, requestId) -> 已回放的 ack(快速幂等表, 进程内)。 */
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
  /** 同一 session 的受理段串行化，避免不同 externalKey 并发判断空闲并同时占槽。 */
  const sessionAdmissionChains = new Map<string, Promise<void>>();
  async function serializeSessionAdmission(
    sessionId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const previous = sessionAdmissionChains.get(sessionId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored = previous
      ? previous.then(
          () => current,
          () => current,
        )
      : current;
    sessionAdmissionChains.set(sessionId, stored);
    try {
      if (previous !== undefined) await previous;
      await fn();
    } finally {
      release();
      if (sessionAdmissionChains.get(sessionId) === stored) {
        sessionAdmissionChains.delete(sessionId);
      }
    }
  }
  /** 每连接当前发送函数(transport 重建后由 onConnected / handleDispatch 刷新)。 */
  const sendFns = new Map<string, (m: HookMessage) => boolean>();
  /** 离线积压的 turn.end, 按连接缓存; durable terminal 先记 pending, 发送成功后标 sent。 */
  const pendingTurnEnds = new Map<string, PendingTurnEnd[]>();
  /** 双向 ACK 已协商时，等待 server durable accepted 的完整 turn.end 副本。 */
  const pendingDeliveryTurnEnds = new Map<
    string,
    {
      connectionId: string;
      message: HookTurnEndMessage;
      attempts: number;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();
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
  /**
   * 当前 externalKey 最近一次失效显式接管的目标与 replacement。显式 stale 请求
   * 必须跳过进场时的无关旧 binding, 但同一消息线随后再次携带同一个 stale id
   * 时要认出刚创建的 replacement；换了 stale id 则必须重新创建任务。
   * 关联随 binding 被替换或归档而删除，生命周期不超过当前 binding。
   */
  const staleTakeoverReplacements = new Map<
    string,
    { staleSessionId: string; replacementSessionId: string }
  >();
  /** 每 session 的 FIFO 等待队列。 */
  const queues = new Map<string, PendingTask[]>();
  /** connectionId + requestId -> 正在执行它的 session(cancel 定位与归属校验用, 收口即清)。 */
  const runningByRequest = new Map<string, { sessionId: string; connectionId: string }>();
  /**
   * 已开始执行但 provider 尚未受理的 Telegram 群任务。账号边界必须把其
   * accepted / queued ACK 收成 cancelled；accepted=true 后消息已交给 agent，
   * 不再按未受理任务处理。
   */
  const pendingGroupAdmissions = new Map<
    string,
    { task: PendingTask; accepted: boolean; cancelled: boolean }
  >();
  /** 已请求取消的 connectionId + requestId(execute 收口时据此把结果改写为 cancelled)。 */
  const cancelRequested = new Set<string>();
  /** 每连接最近一次 welcome 宣告的能力集(turn.reopen 的 feature gate)。 */
  const serverFeatures = new Map<string, readonly string[]>();
  // 官方 bot 的 ack 表情(👀 → 👍/👎) —— 个人 bot 早有, 官方侧靠 msg.op 补上。
  // null = 档位未就绪(见 setEmojiReactionsMode), 就绪前一帧不发。
  let emojiReactionsMode: TelegramEmojiReactions | null = null;
  /** 连接不在时的发送器: 恒失败, 于是终态表情落进待补发队列。 */
  const OFFLINE_SEND = (): boolean => false;
  const ackReactions = createAckReactions({
    serverFeatures,
    emojiReactions: () => emojiReactionsMode,
    log,
  });
  /**
   * 以失败收口、**还等着被续跑**的任务, 按 sessionId 记账(见协议阶段 18)。
   *
   * 只存进程内: app 重启后原 requestId 已随进程消失, server 侧也早已把那一轮当
   * 结束处理, 没有可续的东西。
   *
   * ## 作废时刻(唯一一处"被消费")
   *
   * 记账代表的是"渠道里那条消息此刻仍停在失败态, 还能被接回来"。所以它只在**渠道消息
   * 真的被改写**时删 —— 也就是 claim 帧成功发出的那一刻(见 beginContinuation)。在那之前
   * 无论意图记了多久、中途死了多少次(被意识钩挡掉 / 落库失败 / 排队被丢), 记账都保持
   * 有效, 用户再点一次还能接上; 早先"记意图时就转移走"会让这些静默失败把记账吃掉,
   * 之后谁也接不回来(review: "Restore claims when retries die before persistence")。
   *
   * 另有几处是**明确失效**而非被消费, 各自就地删: 新 hook turn 接管这条消息线、无关桌面
   * turn 推进了会话(enqueue 或 dispatch 任一处观测到)、连接断开 / 换账号 / dispose。
   */
  const pendingReopens = new Map<string, PendingReopen>();
  /**
   * 正在观察的续跑轮, 按 sessionId(同一会话同时只可能有一轮)。
   * 记归属连接是为了在该连接断开时精确撤掉它们 —— 断连是续跑回流的终局
   * (见 onDisconnected), 不能让观察器活到重连后继续用已被 server 解绑的 id 发帧。
   */
  const activeContinuations = new Map<
    string,
    {
      connectionId: string;
      clientId: string;
      isClaimed: () => boolean;
      /** silent=true 时连收口帧都不发(仅连接已断时用, 见 dropContinuation)。 */
      cancel: (silent: boolean, noRemember: boolean) => void;
    }
  >();
  /** 正在因"新任务接管"而撤销的 session —— 它的收口不得再记待续跑(见 dropContinuation)。 */
  let suppressReopenFor: string | null = null;
  // 退订句柄由 dispose() 消费。刻意**不**在 deactivateAccount 里退订: 换账号后
  // 同一个 dispatcher 还要继续服务新账号, 订阅必须跨账号存活(账号边界由记账里的
  // accountGeneration 与 isCurrentGeneration 把关, 不靠摘监听)。
  const unsubscribeUiContinuation =
    subscribeUiContinuation?.((sessionId, clientId) => {
      onUiContinuation(sessionId, clientId);
    }) ?? null;
  /**
   * 已认下"等哪条消息 dispatch"的续跑意图, 按 sessionId。
   *
   * 用户点重试 -> 记这里(带 clientId); 等到那条消息真的要 dispatch 时才挂观察器并
   * 认领渠道消息。中间这段时间任意长(远端会话冷启动、SSH 重连、凭证切换都在
   * dispatch 之前), 所以不需要任何固定窗口去猜。
   *
   * 与 pendingReopens 是**并存**关系, 不是转移: 意图只是"在等哪条消息", 记账要等渠道
   * 消息真被改写(claim 帧发出去)才作废 —— 见 pendingReopens 的作废时刻说明。所以这里
   * 的条目失效时不需要"还回去", 也不怕自己变成孤儿(下一次重试直接覆盖它)。
   */
  const pendingClaims = new Map<string, { clientId: string; entry: PendingReopen }>();

  // 无关介入只作废**记账**与在等的意图, 不碰已认领的那一轮: 它有自己的生命周期
  // (事件流就是渠道消息的当前内容), 由收口 / 撤销 / 超时管。
  const unsubscribeUiIntervention =
    subscribeUiSessionIntervention?.((sessionId) => {
      // 在等 dispatch 的意图直接作废(**不**还记账): 会话已被无关内容推进, 把结果接回
      // 渠道那条旧消息只会显示无关输出。
      if (pendingClaims.delete(sessionId)) {
        log.info(`hook pending claim dropped: an unrelated desktop turn intervened (${sessionId})`);
      }
      if (pendingReopens.delete(sessionId)) {
        log.info(
          `hook pending reopen dropped: an unrelated desktop turn intervened (${sessionId})`,
        );
      }
    }) ?? null;
  // 权威归属: 只有 clientId 对得上的那次 dispatch 才是目标续跑轮。
  const unsubscribeUiTurnDispatching =
    subscribeUiTurnDispatching?.((sessionId, clientId) => {
      const claim = pendingClaims.get(sessionId);
      if (claim && claim.clientId === clientId) {
        pendingClaims.delete(sessionId);
        beginContinuation(sessionId, clientId, claim.entry);
        return;
      }
      // clientId 对不上 = 这个会话正被一条**无关**的桌面消息推进。
      //
      // 这一道不能只靠 enqueue 侧的介入信号: 消息在 hook turn(或在观察的续跑轮)还没
      // 收口时就进了队, 那时记账压根还不存在, 介入信号删了个空; 等那一轮失败再登记
      // 记账时, 队列里那条无关消息已经不会再发第二次介入信号了。它最终 dispatch 时
      // 会到这里 —— 于是"会话被推进"这件事在 enqueue 与 dispatch 两处都能观测到, 不管
      // 记账是在哪一侧先出现的(review: "Preserve interventions that occur before
      // failure registration")。
      //
      // hook turn 自己不经 coordinator(session-runner 直接 session.send), 所以不会误伤:
      // 到这里的 dispatch 一定是桌面端发起的用户轮。
      if (activeContinuations.has(sessionId)) {
        // 已认领的那一轮**被顶掉了**, 而且不会再有终态事件 —— 就地收口。
        //
        // 判据是 coordinator 的派发边界: activeTurn 非空或 isTurnRunning 为真时它不放行
        // 任何 dispatch(插话走 steer, 不发本信号)。所以"另一条用户轮居然 dispatch 了"
        // 等价于"我们这一轮已经不是活跃轮了"。正常收口的话观察器早已在终态事件上 settle
        // 并把自己从表里删掉, 所以还在表里 = 它是被 Stop 之类抢在 vendor dispatch 与
        // sendToAgent 收口检查之间顶掉的 —— coordinator 那条路径直接 return, 不发
        // undispatched(它不能发: 那会顺带 abort 新 turn 的 git 快照)。
        // 不收口就会让渠道消息停在"进行中"直到 1 小时硬超时(review: "Stop 后续跑仍被认领")。
        //
        // 语义与"新 hook 任务接管"完全一致: 发收口帧把那条消息定稿, 但不再记待续跑
        // —— 这条消息线已经交给别人了。
        log.info(`hook continuation superseded by another desktop turn (${sessionId})`);
        dropContinuation(sessionId, { silent: false, remember: false });
        return;
      }
      if (pendingClaims.delete(sessionId)) {
        log.info(`hook pending claim dropped: an unrelated desktop turn dispatched (${sessionId})`);
      }
      if (pendingReopens.delete(sessionId)) {
        log.info(
          `hook pending reopen dropped: an unrelated desktop turn dispatched (${sessionId})`,
        );
      }
    }) ?? null;
  const unsubscribeUiTurnUndispatched =
    subscribeUiTurnUndispatched?.((sessionId, clientId) => {
      const claim = pendingClaims.get(sessionId);
      if (claim && claim.clientId === clientId) {
        // 记账没被动过(它只在 claim 帧发出时才删), 所以这里只丢意图 —— 渠道那条消息
        // 仍是原来的失败态, 用户再点一次重试还能接上。
        log.info(`hook pending claim released: the target turn never dispatched (${sessionId})`);
        pendingClaims.delete(sessionId);
        return;
      }
      // 已经认领了才收到 undispatched: dispatching 信号发在 vendor dispatch **之前**,
      // 而它之后仍有会失败的环节(Stop 抢在持久化之后、gitSnapshotCoordinator.onTurnStart
      // 之类的 pre-vendor hook 抛错)。那一轮压根没跑起来, 但渠道消息已经被改成
      // "进行中" —— 必须撤掉观察让它按失败收口, 否则要挂到 1 小时硬超时。
      const watching = activeContinuations.get(sessionId);
      if (!watching || watching.clientId !== clientId) return;
      log.info(`hook continuation revoked: the claimed turn never dispatched (${sessionId})`);
      // 连接还在 -> 必须发收口帧(否则渠道消息停在假的"进行中"); 且这一轮压根没跑起来,
      // coordinator 那边还留着 active-turn recovery, 用户马上会再点一次重试 —— 记一笔。
      dropContinuation(sessionId, { silent: false, remember: true });
    }) ?? null;
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

  function bindingKey(connectionId: string, externalKey: string): string {
    return `${connectionId}\u0000${externalKey}`;
  }

  function persistTerminalRecord(record: HookTerminalRecord): boolean {
    if (!terminalLedger) return false;
    try {
      if (!terminalLedger.set(record)) {
        log.warn('hook terminal request was not persisted; using in-memory dedupe only');
        return false;
      }
      return true;
    } catch {
      // Storage is a reliability layer, not part of the task result. A disk
      // failure must not hide an answer that is otherwise ready to send.
      log.warn('hook terminal request persistence threw; using in-memory dedupe only');
      return false;
    }
  }

  function persistTerminal(record: Omit<HookTerminalRecord, 'completedAt'>): boolean {
    return persistTerminalRecord({ ...record, completedAt: Date.now() });
  }

  function markTerminalSent(connectionId: string, requestId: string): boolean {
    if (!terminalLedger) return false;
    try {
      if (!terminalLedger.markSent(connectionId, requestId)) {
        log.warn('hook terminal request stayed pending after a transport send');
        return false;
      }
      return true;
    } catch {
      log.warn('hook terminal request delivery update threw; it will be retried after reconnect');
      return false;
    }
  }

  function durableTurnEnd(turnEnd: TurnEndPayload): TurnEndPayload {
    // Binary attachment bytes belong to the existing media/transport path,
    // not a new JSON persistence store. The in-process offline queue keeps the
    // original frame; cross-restart recovery retains the terminal text only.
    const { attachments: _attachments, ...withoutAttachments } = turnEnd;
    return withoutAttachments;
  }

  function supportsDeliveryAck(connectionId: string): boolean {
    return serverFeatures.get(connectionId)?.includes(HOOK_FEATURE_TURN_DELIVERY) === true;
  }

  function clearPendingDelivery(key: string): void {
    const pending = pendingDeliveryTurnEnds.get(key);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingDeliveryTurnEnds.delete(key);
  }

  function enforcePendingDeliveryLimit(connectionId: string): void {
    const keys = [...pendingDeliveryTurnEnds]
      .filter(([, pending]) => pending.connectionId === connectionId)
      .map(([key]) => key);
    while (keys.length > MAX_PENDING_TURN_ENDS) {
      const oldest = keys.shift();
      if (oldest !== undefined) {
        const evictedRequestId = pendingDeliveryTurnEnds.get(oldest)?.message.payload.requestId;
        clearPendingDelivery(oldest);
        log.warn(
          `turn.end ACK buffer full; oldest result evicted: connectionId=${connectionId} requestId=${evictedRequestId ?? 'unknown'}`,
        );
      }
    }
  }

  function sendPendingDelivery(
    key: string,
    pending: NonNullable<ReturnType<typeof pendingDeliveryTurnEnds.get>>,
    sendOverride?: (m: HookMessage) => boolean,
  ): void {
    if (pendingDeliveryTurnEnds.get(key) !== pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    const send = sendOverride ?? sendFns.get(pending.connectionId);
    if (!send || !send(pending.message)) return;
    pending.attempts += 1;
    const delay = Math.min(
      TURN_DELIVERY_ACK_TIMEOUT_MS * 2 ** Math.min(3, Math.max(0, pending.attempts - 1)),
      TURN_DELIVERY_ACK_MAX_DELAY_MS,
    );
    const timer = setTimeout(() => {
      if (pendingDeliveryTurnEnds.get(key) !== pending) return;
      pending.timer = null;
      log.warn(
        `turn.end ACK timed out; replaying unchanged result: ${pending.message.payload.requestId}`,
      );
      sendPendingDelivery(key, pending);
    }, delay);
    timer.unref?.();
    pending.timer = timer;
  }

  function trackPendingDelivery(connectionId: string, msg: HookTurnEndMessage): void {
    const key = ackKey(connectionId, msg.payload.requestId);
    const existing = pendingDeliveryTurnEnds.get(key);
    if (existing !== undefined) {
      sendPendingDelivery(key, existing);
      return;
    }
    const pending = { connectionId, message: msg, attempts: 0, timer: null };
    pendingDeliveryTurnEnds.set(key, pending);
    enforcePendingDeliveryLimit(connectionId);
    if (pendingDeliveryTurnEnds.get(key) === pending) sendPendingDelivery(key, pending);
  }

  function sendOrBuffer(
    connectionId: string,
    message: HookTurnEndMessage,
    terminal: Omit<HookTerminalRecord, 'completedAt' | 'delivery'>,
  ): void {
    const durable = persistTerminal({ ...terminal, delivery: 'pending' });
    if (supportsDeliveryAck(connectionId)) {
      // ACK 模式: 会话内重发由 pendingDeliveryTurnEnds 负责; 账本保持 pending,
      // 收到任一 turn.delivery 回执才收口为 sent(见 handleTurnDelivery), 跨重启
      // 由账本补发兜底「accepted 前进程崩溃」的窗口。
      trackPendingDelivery(connectionId, message);
      return;
    }
    const send = sendFns.get(connectionId);
    if (send && send(message)) {
      if (durable) {
        if (!markTerminalSent(terminal.connectionId, terminal.requestId)) {
          persistTerminal({ ...terminal, delivery: 'sent' });
        }
      } else {
        persistTerminal({ ...terminal, delivery: 'sent' });
      }
      return;
    }
    const buf = pendingTurnEnds.get(connectionId) ?? [];
    buf.push({ message, terminal });
    if (buf.length > MAX_PENDING_TURN_ENDS) buf.shift();
    pendingTurnEnds.set(connectionId, buf);
    log.warn(`turn.end buffered (connection offline): ${connectionId}`);
  }

  function cacheAck(connectionId: string, ack: TaskAckPayload): void {
    const key = ackKey(connectionId, ack.requestId);
    ackHistory.set(key, ack);
    inflightRequests.delete(key);
    if (ackHistory.size > MAX_ACK_HISTORY) {
      const oldest = ackHistory.keys().next().value;
      if (oldest !== undefined) ackHistory.delete(oldest);
    }
  }

  /**
   * ack 表情要的三个字段。triggerMessageId 只有 server 下发了才有 —— 老 server
   * 不发, 此时整个表情动作跳过(而不是猜一个 id)。
   */
  function ackTaskOf(task: PendingTask): AckReactionTask {
    return {
      connectionId: task.connectionId,
      requestId: task.requestId,
      externalKey: task.externalKey,
      triggerMessageId: task.run.source?.triggerMessageId ?? null,
    };
  }

  function reply(
    connectionId: string,
    send: (m: HookMessage) => boolean,
    ack: TaskAckPayload,
  ): void {
    cacheAck(connectionId, ack);
    const delivered = send(makeTaskAck(ack));
    if (ack.result === 'rejected' && delivered) {
      persistTerminal({ connectionId, requestId: ack.requestId, ack, delivery: 'sent' });
    }
  }

  function rejected(requestId: string, reason: TaskRejectReason): TaskAckPayload {
    return { requestId, result: 'rejected', reason, sessionId: null, queuePosition: null };
  }

  /** server 本次握手宣告了 turn.reopen 能力吗(缺席 = 老 server, 不回流)。 */
  function supportsReopen(connectionId: string): boolean {
    return serverFeatures.get(connectionId)?.includes(HOOK_FEATURE_TURN_REOPEN) === true;
  }

  /**
   * 放弃这个 session 的续跑回流: 撤销在观察的那一轮 + 清掉记账。
   *
   * 新的 hook turn 一开跑就必须调 —— 那条渠道消息的"最新一轮"已经换人了, 旧的
   * 观察器若还挂着, 新 turn 的事件会被当成续跑的继续, 把上一条消息改写成不相干
   * 的内容。
   */
  function dropContinuation(
    sessionId: string,
    opts: { silent?: boolean; remember?: boolean } = {},
  ): void {
    const { silent = false, remember = false } = opts;
    if (!remember) {
      pendingReopens.delete(sessionId);
      // 在等 dispatch 的意图一起清掉。它自带一份 entry 快照, 留着的话: 新任务失败后登记了
      // 自己的记账, 而那条迟到的重试(远端冷启动 / 凭证切换期间一直没 dispatch)最终匹配上
      // 这条陈旧意图, 就会拿已被 server 解绑的旧 reopenOf 去认领, 顺带把**新**记账删掉
      // (review: "Clear stale retry claims when hook tasks take over")。
      pendingClaims.delete(sessionId);
    }
    const watching = activeContinuations.get(sessionId);
    if (!watching) return;
    activeContinuations.delete(sessionId);
    // 撤销让 runner 以"已取消"收口(那条 turn.end 是 error)。两个维度要分场景:
    //
    //   silent  —— 连帧都不发。只用于**连接已断**: server 那边已经做过孤儿收口并解绑
    //              这一轮的 requestId, 迟到的帧只会被当未知 id 丢弃(协议阶段 18)。
    //              连接还在的场景一律不能 silent, 否则渠道消息停在假的"进行中"。
    //   remember —— 收口后是否再记一笔待续跑。新任务接管时**不**记(消息线已经交给
    //              别人, 记了会让之后的续跑信号把用户带回一条过期消息); 而"这一轮
    //              压根没 dispatch 起来"时要记, 用户马上就会再点一次重试。
    if (!remember) suppressReopenFor = sessionId;
    try {
      watching.cancel(silent, !remember);
    } finally {
      suppressReopenFor = null;
    }
    if (!remember) pendingReopens.delete(sessionId);
  }

  /** 失败收口后登记"等着被续跑"。只有 server 支持回流时才记, 否则纯占内存。 */
  function rememberForReopen(
    sessionId: string,
    entry: Omit<PendingReopen, 'expiresAt'>,
    reopenCapable: boolean,
  ): void {
    if (suppressReopenFor === sessionId) return;
    if (!runner.watchContinuation || !reopenCapable) return;
    pendingReopens.set(sessionId, { ...entry, expiresAt: Date.now() + REOPEN_TTL_MS });
    if (pendingReopens.size > MAX_PENDING_REOPENS) {
      const oldest = pendingReopens.keys().next().value;
      if (oldest !== undefined) pendingReopens.delete(oldest);
    }
  }

  /**
   * 「用户在桌面端续跑了这个会话」意图到达(带那条消息的 clientId)。
   *
   * 这里只**记下在等哪条消息**, 不挂观察器、不发帧 —— 归属要等到那条消息真的要
   * dispatch 时才成立(见 subscribeUiTurnDispatching)。中间可以隔任意长时间: 远端
   * 会话冷启动、SSH 重连、凭证切换都发生在 dispatch 之前, 所以不需要固定窗口去猜。
   *
   * 记账每被**接回**一次就作废一次(claim 帧发出即删), 不会被两轮同时认领: 续跑轮自己
   * 若又失败, 由它的 onEnd 重新登记(带新 requestId), 于是形成一条每环都有独立 id 的链。
   * 但"意图没走到 dispatch"不算被接回 —— 那种情况记账原样留着, 用户再点一次仍然有效。
   */
  function onUiContinuation(sessionId: string, clientId: string): void {
    const entry = pendingReopens.get(sessionId);
    if (!entry) return;
    if (!runner.watchContinuation) return;
    if (!isCurrentGeneration(entry.accountGeneration)) return;
    if (Date.now() > entry.expiresAt) return;
    // 本模块正跑这个 session 的 hook turn / 已有在观察的续跑: 那一轮才是这条消息线
    // 的主人, 不能被另一条意图顶掉。
    if (running.has(sessionId) || activeContinuations.has(sessionId)) return;
    if (!supportsReopen(entry.connectionId)) return;
    // 刻意**不**动 pendingReopens: 记账要留到渠道消息真被改写才作废(见它的注释)。
    pendingClaims.set(sessionId, { clientId, entry });
    if (pendingClaims.size > MAX_PENDING_REOPENS) {
      const oldest = pendingClaims.keys().next().value;
      if (oldest !== undefined) pendingClaims.delete(oldest);
    }
  }

  /**
   * 目标那条消息即将 dispatch —— 归属已确认, 现在挂观察器并认领渠道那条消息。
   *
   * 调用点在 coordinator 的 beforeDispatchUserTurn 里(被 await), 所以:
   *   - 监听挂在 vendor dispatch **之前**, 不丢正文开头;
   *   - live session 必然已就绪(马上就要 dispatch), 不需要等它出现。
   */
  function beginContinuation(sessionId: string, clientId: string, entry: PendingReopen): void {
    const watch = runner.watchContinuation;
    if (!watch) return;
    if (!isCurrentGeneration(entry.accountGeneration)) return;
    if (running.has(sessionId) || activeContinuations.has(sessionId)) return;
    if (!supportsReopen(entry.connectionId)) return;
    // 目录授权按现场重算(与 execute 同一道收口): 等待期间映射可能已被改删。
    if (!dirStillAllowed(entry.connectionId, entry.workingDir)) {
      log.info(
        `hook continuation skipped: the session directory is no longer authorized (reopenOf=${entry.requestId})`,
      );
      return;
    }
    const requestId = randomUUID();
    const requestKey = ackKey(entry.connectionId, requestId);
    let claimed = false;
    // runner 可能在 watch() 里**同步**收口(会话已不在进程里就直接 onAbandon),
    // 那时 cancelWatch 还没赋值 —— 用这个标记决定要不要登记, 不去碰它。
    let settledEarly = false;
    /**
     * 这一轮已被**外部**撤掉(新任务接管 / 连接断开 / 换账号 / dispose)。
     *
     * 撤销后 runner 会按契约 settle 并停止回调, 但本模块不把正确性外包出去:
     * 撤销与 runner 收口之间存在窗口(已排队的微任务仍可能回调), 而断连场景下
     * server 已经解绑了这一轮的 requestId —— 任何迟到的帧都是拿 stale id 发的,
     * 其中 error 收口还会把它记成下一轮的 reopenOf。置位后一切回调直接短路。
     */
    let revoked = false;
    /**
     * 这一轮收口后**不得**再记一笔待续跑。
     *
     * 与全局 suppressReopenFor 的区别: 那个只在 dropContinuation 的同步窗口内有效,
     * 一旦 runner 的收口跨了微任务就漏。撤销是否允许重新登记属于"这一轮"的属性,
     * 所以钉在闭包里 —— 不依赖任何时序假设。
     */
    let denyRemember = false;
    /**
     * 本轮在 activeContinuations 里的那条记录(注册后赋值)。
     *
     * 收口时**只能按实例删**, 不能只按 sessionId: 成功收口要先异步收集出站附件, onEnd
     * 因此可能落在"这一轮已被接管、用户又续了一次、新一轮已注册"之后。那时无条件
     * delete(sessionId) 会把**新**那一轮从表里抹掉 —— 它的观察器于是躲过断连与后续接管的
     * 撤销, 拿一个已被 server 解绑的 requestId 继续发帧
     * (review: "Delete only the continuation instance being settled")。
     */
    let handle: NonNullable<ReturnType<typeof activeContinuations.get>> | null = null;
    /** 从"在观察"的账上摘掉本轮(只摘自己那条)。 */
    const detach = (): void => {
      settledEarly = true;
      if (handle && activeContinuations.get(sessionId) === handle) {
        activeContinuations.delete(sessionId);
      }
    };
    const cleanup = (): void => {
      runningByRequest.delete(requestKey);
      cancelRequested.delete(requestKey);
      detach();
    };
    const cancelWatch = watch({
      sessionId,
      workingDir: entry.workingDir,
      ...(entry.source ? { source: entry.source } : {}),
      laneKind: deriveLaneKind(entry.externalKey),
      isDirAuthorized: (dir) => dirStillAllowed(entry.connectionId, dir),
      onClaim: () => {
        if (revoked || !isCurrentGeneration(entry.accountGeneration)) return;
        const send = sendFns.get(entry.connectionId);
        // 连接不在线 / 发帧失败(WS 正在 CLOSING 时 send 返回 false): reopen 是"把消息
        // 接回来"的即时动作, 缓存补发没有意义(等重连时那轮早跑完了)。
        // 但**不能只是不认领**: runner 那边已经按契约认为认领发生过, 之后不会再给
        // 第二次机会, 而这一轮的结果又确实没法回流 —— 必须撤掉观察, 并且**保留记账**,
        // 否则用户再点重试也接不上(review: "Restore the reopen when its claim frame
        // is not sent")。渠道消息此刻仍是原来的失败态, 记账依然有效。
        claimed =
          send?.(
            makeTurnReopen({
              requestId,
              reopenOf: entry.requestId,
              externalKey: entry.externalKey,
              sessionId,
            }),
          ) === true;
        if (!claimed) {
          log.warn(
            `hook continuation claim frame not sent; keeping the pending reopen (${sessionId})`,
          );
          revoked = true;
          // 观察器交给调用方在本次返回后撤(cancelWatch 尚未赋值, 这里不能碰它)。
          return;
        }
        // 渠道那条消息从这一刻起归本轮所有(server 已把它的位置转记给 requestId), 记账
        // 就此作废 —— 它存的 reopenOf 已被 server 解绑, 再拿去续只会被静默忽略。
        pendingReopens.delete(sessionId);
        // 认领成功后这一轮就等同于一个在执行的任务: 登记进 runningByRequest,
        // 渠道侧的 /stop 才能用新 requestId 命中它。
        runningByRequest.set(requestKey, { sessionId, connectionId: entry.connectionId });
      },
      onProgress: (text) => {
        if (revoked || !claimed || !isCurrentGeneration(entry.accountGeneration)) return;
        const send = sendFns.get(entry.connectionId);
        if (send) send(makeTurnProgress({ requestId, text }));
      },
      // 停止观察即摘账 —— 成功收口还要异步收集附件, 那段时间它不该再被算作"在观察的
      // 那一轮"(否则排在后面的桌面消息一 dispatch 就被误判成顶替)。发帧的闭包照旧存活。
      onSettling: detach,
      onEnd: (outcome) => {
        const wasCancelled = cancelRequested.has(requestKey);
        cleanup();
        if (revoked || !claimed || !isCurrentGeneration(entry.accountGeneration)) return;
        const status: 'ok' | 'error' | 'cancelled' = wasCancelled ? 'cancelled' : outcome.status;
        const isError = status === 'error';
        // 续跑轮的 turn.end **直发不缓存**, 与普通任务(sendOrBuffer 断线补发)刻意
        // 相反: 普通任务的消息由 server 建、断线期间没人动它, 补发就能定稿; 而续跑
        // 轮的消息在断连那一刻已被 server 的孤儿收口改写并解绑 requestId, 迟到的
        // turn.end 会被当未知 id 丢弃 —— 那反而把"其实跑成功了"显示成"续跑中断"。
        // 断连即这一轮回流的终局, 由 server 收口单方权威(协议阶段 18)。
        const send = sendFns.get(entry.connectionId);
        const delivered =
          send?.(
            makeTurnEnd({
              requestId,
              externalKey: entry.externalKey,
              sessionId,
              status,
              finalText: outcome.finalText,
              errorMessage: isError ? outcome.errorMessage || 'unknown error' : null,
              usage: { durationMs: outcome.durationMs },
              ...(outcome.attachments !== undefined && outcome.attachments.length > 0
                ? { attachments: outcome.attachments }
                : {}),
            }),
          ) === true;
        if (!delivered) {
          // 没发出去 => server 已把这条消息收口并解绑本轮 requestId, 再拿它当
          // reopenOf 只会被静默忽略。这条消息线到此为止, 不再登记可续跑。
          log.warn(`hook continuation turn.end dropped (connection offline): ${requestId}`);
          return;
        }
        // 续跑又失败了 -> 允许再续一次(用户还得再点一次重试, 天然限流)。
        // reopenOf 换成这一轮的 requestId: server 侧那条消息现在挂在它上面。
        if (isError && !denyRemember) {
          rememberForReopen(
            sessionId,
            {
              connectionId: entry.connectionId,
              requestId,
              externalKey: entry.externalKey,
              workingDir: entry.workingDir,
              ...(entry.source ? { source: entry.source } : {}),
              accountGeneration: entry.accountGeneration,
            },
            // 这一轮开跑时已复核过能力(见 beginContinuation), 且它的 turn.end 刚刚
            // 真的发出去了 —— 连接此刻在线, 能力也就仍然成立。
            true,
          );
        }
      },
      onAbandon: () => {
        // 压根没认领(会话已不在进程里 / 目录已撤权 / 被撤销)。渠道那条消息**没被改写
        // 过**, 记账也从未被删 —— 什么都不用做, 用户再点一次重试还能接上。
        //
        // 这里刻意不"还回记账": 撤销与放弃之间可能夹着别的失效(无关 turn 推进了会话、
        // 新 hook turn 接管、连接断开), 那些路径已经把记账删掉了, 再 set 一次等于把
        // 已失效的记账复活。被外部撤销的场景由 dropContinuation 按 remember 维度决定
        // 记账去留, 不由这里兜。
        cleanup();
      },
    });
    if (revoked) {
      // onClaim 在 watch() 内同步跑过且发帧失败: 记账已还回去, 这个观察器不该留着。
      cancelWatch();
      return;
    }
    if (!settledEarly) {
      handle = {
        connectionId: entry.connectionId,
        clientId,
        isClaimed: () => claimed,
        cancel: (silent: boolean, noRemember: boolean) => {
          // revoked 是"连迟到的帧都别发"的开关 —— 只有连接已断时才该置位。
          if (silent) revoked = true;
          if (noRemember) denyRemember = true;
          cancelWatch();
        },
      };
      activeContinuations.set(sessionId, handle);
    }
  }

  /** 执行一个任务并回推 turn.end; 收口后 drain 同 session 队列。 */
  async function execute(task: PendingTask): Promise<void> {
    const sessionId = task.run.sessionId;
    const requestKey = ackKey(task.connectionId, task.requestId);
    if (!isCurrentGeneration(task.accountGeneration)) {
      running.delete(sessionId);
      return;
    }
    const pendingGroupAdmission = task.commitContextCursor
      ? { task, accepted: false, cancelled: false }
      : null;
    if (pendingGroupAdmission) pendingGroupAdmissions.set(requestKey, pendingGroupAdmission);
    // 这条消息线交给新任务了: 撤掉上一轮失败留下的续跑观察与记账。连接还在, 所以要
    // 发收口帧把那条旧消息定稿; 但不再记待续跑(它已经不是"最新一轮"了)。
    dropContinuation(sessionId, { silent: false, remember: false });
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
          '这个任务所在的目录已不在工作目录映射里，本条消息没有执行。把它所在的目录加进 设置 → 远程连接 → 工作目录映射 后再发一次。',
        durationMs: 0,
      };
    } else {
      try {
        outcome = await runner.run({
          ...task.run,
          onProgress,
          onInteraction,
          onInteractionCancel,
          ...(task.commitContextCursor
            ? {
                onProviderAccepted: async () => {
                  if (pendingGroupAdmission?.cancelled) return;
                  if (pendingGroupAdmission) pendingGroupAdmission.accepted = true;
                  await commitTaskContextCursor(task);
                },
              }
            : {}),
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
    pendingGroupAdmissions.delete(requestKey);
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
    const turnEnd: TurnEndPayload = {
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
    };
    // Protocol idempotency replays only the original ACK. The terminal record
    // is written as a pending outbox entry before sending; an offline frame
    // stays buffered in memory until onConnected flushes the full payload.
    sendOrBuffer(task.connectionId, makeTurnEnd(turnEnd), {
      connectionId: task.connectionId,
      requestId: task.requestId,
      ack: task.ack,
      turnEnd: durableTurnEnd(turnEnd),
    });
    // 表情换终态。连接断了也要**调**一次 —— 传一个必然失败的发送器, 让
    // ackReactions 把它记进待补发队列; 直接跳过的话那条消息会永远挂着 👀,
    // 而重连补发拿不到任何东西可补。
    ackReactions.onFinished(ackTaskOf(task), status, sendFns.get(task.connectionId) ?? OFFLINE_SEND);
    running.delete(sessionId);
    // 失败收口 -> 记一笔"等着被续跑"。只有 error 记: cancelled 是用户按了停止,
    // ok 没什么可续的。用户之后在桌面端点「重试」时, 这一轮的进展与结果就能接回
    // 渠道里这条消息(协议阶段 18)。
    if (isError) {
      rememberForReopen(
        sessionId,
        {
          connectionId: task.connectionId,
          requestId: task.requestId,
          externalKey: task.externalKey,
          workingDir: task.run.workingDir,
          ...(task.run.source ? { source: task.run.source } : {}),
          accountGeneration: task.accountGeneration,
        },
        task.reopenCapable,
      );
    }
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
   * provider 已受理后才推进 durable cursor。此时即使账号代次随后失效，消息也
   * 已交给 agent，游标前移是正确的；持久化失败则保留旧游标，下次最多重复携带，
   * 不能为了游标写入失败反转一个已经受理的 turn。
   */
  async function commitTaskContextCursor(
    task: Pick<PendingTask, 'requestId' | 'commitContextCursor'>,
  ): Promise<void> {
    if (!task.commitContextCursor) return;
    try {
      await task.commitContextCursor();
    } catch (error) {
      log.warn(
        `group context cursor commit failed after provider acceptance: requestId=${task.requestId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 已回 ACK 的任务在取消或账号边界被清掉时必须有 durable 终态。 */
  function finishTaskAsCancelled(task: PendingTask): void {
    const turnEnd: TurnEndPayload = {
      requestId: task.requestId,
      externalKey: task.externalKey,
      sessionId: task.run.sessionId,
      status: 'cancelled',
      finalText: '',
      errorMessage: null,
      usage: { durationMs: null },
    };
    sendOrBuffer(task.connectionId, makeTurnEnd(turnEnd), {
      connectionId: task.connectionId,
      requestId: task.requestId,
      ack: task.ack,
      turnEnd: durableTurnEnd(turnEnd),
    });
    // 👀 必须换成终态, 否则取消掉的消息会永远挂着「在做」。取消的三个入口
    // (排队中被 cancel、account deactivation 清队、群上下文 admission 作废)
    // 都收敛到本方法, 所以这一处就覆盖全部 —— 不要在各入口分别补。
    // deactivateAccount 里 sendFns.clear() 在本方法之后, 表情发得出去; 真断线
    // 时同样要调, 让终态进待补发队列而不是消失。
    ackReactions.onFinished(
      ackTaskOf(task),
      'cancelled',
      sendFns.get(task.connectionId) ?? OFFLINE_SEND,
    );
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
    // 显式接管的目标失效时会从旧目录 / 本次别名提示里挑一个安全落点, 然后
    // 复用下方的新建路径。普通派发仍原样使用 payload.workspace。
    let effectiveWorkspace = payload.workspace;
    let effectiveWorkspaces = config.workspaces;
    let forceNew = false;
    /** 旧绑定作废、本次不得不新建会话时, 随 turn.end 回给渠道的说明。 */
    let recreatedNotice: string | null = null;

    const laneKind = deriveLaneKind(payload.externalKey);
    const laneKey = bindingKey(connectionId, payload.externalKey);
    const namespacedBound = bindings.get(connectionId, payload.externalKey);
    // v1 stored every mapping under the literal "slack" namespace.  A new
    // account/provider namespace may read it only as a candidate; it is moved
    // after current-account DB existence + workspace allowlist checks pass.
    const legacyNamespace = connectionId.endsWith(':slack') ? 'slack' : null;

    // 接管路径: server 显式指定已有 session(对话会话同样可接管)
    if (payload.sessionId !== null) {
      const info = await runner.inspect(payload.sessionId);
      if (!isCurrentGeneration(generation)) return { reject: 'disabled' };
      if (info !== null) awaitingPersist.delete(payload.sessionId);
      /**
       * 首次失效接管的 ACK 会把 replacement sessionId 回给 server。若 server 在
       * 首轮落库前就把这个新 id 显式带回来, inspect 仍会查不到；它不是第二个
       * stale 目标, 而是当前消息线刚创建、正在执行的 replacement。只在当前
       * namespaced binding + awaitingPersist + running/queued 三者同时命中、且
       * inspect 确实还查不到时复用，并仍用当前映射重验目录，避免把落库窗口
       * 变成撤权或 usable=false 的旁路。
       */
      const pendingDir = awaitingPersist.get(payload.sessionId) ?? null;
      if (
        info === null &&
        payload.sessionId === namespacedBound &&
        pendingDir !== null &&
        (running.has(payload.sessionId) || (queues.get(payload.sessionId)?.length ?? 0) > 0)
      ) {
        if (!inWhitelistNow(pendingDir) && !inDialogueRoot(pendingDir)) {
          return { reject: 'workspace_not_allowed' };
        }
        return {
          run: {
            sessionId: payload.sessionId,
            isNew: false,
            laneKind,
            workingDir: pendingDir,
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
      if (info?.usable) {
        if (!inWhitelistNow(info.workingDir) && !inDialogueRoot(info.workingDir)) {
          return { reject: 'workspace_not_allowed' };
        }
        // 接管路径刚校验过白名单, 授权来源恒为 workspace(远端不能凭接管把会话
        // 带出映射 —— 越界的 sessionId 在上面就被 workspace_not_allowed 打回)
        staleTakeoverReplacements.delete(laneKey);
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

      // 目标不存在、被归档或不可投递: 用户已经明确发来一条新消息, 因而静默
      // 新建任务并重绑这条外部消息线。旧 workingDir 只能帮助找回逻辑工作区,
      // 绝不能直接拿来运行 —— 归档任务的专属 worktree 可能早已被删除。
      effectiveWorkspaces = getConnection(connectionId)?.workspaces ?? config.workspaces;
      const oldWorkingDir = info?.workingDir ?? null;
      const inferredWorkspace =
        oldWorkingDir === null
          ? null
          : (Object.entries(effectiveWorkspaces)
              .filter(([, root]) => isPathWithin(root, oldWorkingDir))
              .sort(
                ([, left], [, right]) => path.resolve(right).length - path.resolve(left).length,
              )[0]?.[0] ?? null);
      if (inDialogueRoot(oldWorkingDir)) {
        effectiveWorkspace = HOOK_CHAT_WORKSPACE_ALIAS;
      } else if (inferredWorkspace !== null) {
        effectiveWorkspace = inferredWorkspace;
      } else if (payload.workspace === HOOK_CHAT_WORKSPACE_ALIAS && dialogue !== undefined) {
        effectiveWorkspace = HOOK_CHAT_WORKSPACE_ALIAS;
      } else if (
        payload.workspace !== null &&
        Object.hasOwn(effectiveWorkspaces, payload.workspace)
      ) {
        effectiveWorkspace = payload.workspace;
      } else if (dialogue !== undefined) {
        effectiveWorkspace = HOOK_CHAT_WORKSPACE_ALIAS;
      } else {
        // 兼容未注入内置对话目录的旧宿主 / 单测: 没有任何可验证的安全落点时
        // 仍保留旧拒绝语义, 避免凭空选择一个工作目录。
        return { reject: 'session_not_found' };
      }
      forceNew = true;
      log.info(
        `hook takeover target ${payload.sessionId} is gone or archived; creating a fresh session in ${effectiveWorkspace}`,
      );
    }

    // 默认路径: 别名解析(映射即白名单); chat 伪目录不走映射, 目录建会话时分配
    // 保留别名「对话」: 不查 workspaces, 解析成 app 托管对话目录
    const isChat = effectiveWorkspace === HOOK_CHAT_WORKSPACE_ALIAS && dialogue !== undefined;
    const dir = isChat
      ? undefined
      : effectiveWorkspace
        ? Object.hasOwn(effectiveWorkspaces, effectiveWorkspace)
          ? effectiveWorkspaces[effectiveWorkspace]
          : undefined
        : undefined;
    if (!dir && !isChat) return { reject: 'unknown_workspace' };

    const legacyBound =
      namespacedBound === null && legacyNamespace !== null
        ? bindings.get(legacyNamespace, payload.externalKey)
        : null;
    const bound = namespacedBound ?? legacyBound;
    const trackedReplacement = staleTakeoverReplacements.get(laneKey);
    const reusesTrackedReplacement =
      forceNew &&
      payload.sessionId !== null &&
      trackedReplacement?.staleSessionId === payload.sessionId &&
      trackedReplacement.replacementSessionId === bound;
    if (
      trackedReplacement !== undefined &&
      (trackedReplacement.replacementSessionId !== bound ||
        (forceNew && trackedReplacement.staleSessionId !== payload.sessionId))
    ) {
      staleTakeoverReplacements.delete(laneKey);
    }
    const migrateLegacyBinding = (): void => {
      if (!legacyBound || !legacyNamespace) return;
      bindings.set(connectionId, payload.externalKey, legacyBound);
      bindings.remove(legacyNamespace, payload.externalKey);
    };
    if ((!forceNew || reusesTrackedReplacement) && bound) {
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
      if (!forceNew) {
        recreatedNotice = info?.usable ? NOTICE_SESSION_RECREATED : NOTICE_SESSION_GONE;
      }
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
    if (forceNew && payload.sessionId !== null) {
      staleTakeoverReplacements.set(laneKey, {
        staleSessionId: payload.sessionId,
        replacementSessionId: sessionId,
      });
    } else {
      staleTakeoverReplacements.delete(laneKey);
    }
    // 显式接管失效时 forceNew 已跳过旧 binding 复用；等新目录准备成功后才覆盖
    // 当前 binding 并清理旧版 namespace，避免分配失败 / 账号切换时无谓解绑。
    if (forceNew && legacyNamespace) bindings.remove(legacyNamespace, payload.externalKey);
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
    // 标题摘要用 server 单独下发的干净原文, 而不是 prompt —— prompt 可能带
    // thread 上下文块(见 buildHookSessionTitle 注释)。空串按"没有"处理:
    // 纯 @ 无正文时 server 的 userText 为空, 而 prompt 仍是原文, 回退它更有信息。
    const sourceUserText = payload.source?.userText ?? '';
    const titleText = sourceUserText.trim().length > 0 ? sourceUserText : payload.prompt;
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
        ...(effectiveWorkspace ? { workspaceAlias: effectiveWorkspace } : {}),
        title: buildHookSessionTitle(
          providerName,
          titleText,
          bareKey,
          payload.source?.teamName ??
            (payload.source?.im === 'telegram' || payload.source?.im === 'x'
              ? payload.source.channelName
              : null),
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

    // Durable terminal replay comes first: an auto-update restarts the process
    // and clears ackHistory, while the server may still redeliver a completed
    // requestId. Replaying its recorded ACK and terminal payload closes that
    // gap without invoking the runner again. The server owns requestId
    // idempotency, so replaying a persisted terminal frame is safe even when
    // the local transport had already accepted an earlier attempt.
    const rKey = ackKey(connectionId, payload.requestId);
    let terminalReplay: HookTerminalRecord | null = null;
    try {
      terminalReplay = terminalLedger?.get(connectionId, payload.requestId) ?? null;
    } catch {
      log.warn('hook terminal request lookup threw; using in-memory dedupe only');
    }
    if (terminalReplay) {
      cacheAck(connectionId, terminalReplay.ack);
      const ackDelivered = send(makeTaskAck(terminalReplay.ack));
      if (!terminalReplay.turnEnd) return;
      if (supportsDeliveryAck(connectionId)) {
        // ACK 模式的重放帧与 sendOrBuffer 同语义: 经 ACK 缓冲重发, 账本保持
        // pending 直到 turn.delivery 回执收口(handleTurnDelivery)。server 既然
        // 重投了这个 requestId, 就说明它没有该结果的持久收据。
        if (terminalReplay.delivery === 'sent') {
          persistTerminalRecord({ ...terminalReplay, delivery: 'pending' });
        }
        trackPendingDelivery(connectionId, makeTurnEnd(terminalReplay.turnEnd));
        return;
      }
      if (!ackDelivered) {
        persistTerminalRecord({ ...terminalReplay, delivery: 'pending' });
        return;
      }
      if (!send(makeTurnEnd(terminalReplay.turnEnd))) {
        persistTerminalRecord({ ...terminalReplay, delivery: 'pending' });
        return;
      }
      if (
        terminalReplay.delivery === 'pending' &&
        !markTerminalSent(connectionId, payload.requestId)
      ) {
        persistTerminalRecord({ ...terminalReplay, delivery: 'sent' });
      }
      return;
    }

    // 幂等: 已回过 ack 的重投只回放, 不重跑
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
        let commitContextCursor: ContextCursorCommit | undefined;
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
        const groupHistoryAccess = groupHistoryAccessForExternalKey(payload.externalKey);
        const taskBase: Omit<PendingTask, 'ack'> = {
          connectionId,
          requestId: payload.requestId,
          externalKey: payload.externalKey,
          run: {
            ...resolved.run,
            ...(contextPrefix ? { prompt: `${contextPrefix}${resolved.run.prompt}` } : {}),
            ...(source ? { source } : {}),
            ...(groupHistoryAccess ? { groupHistoryAccess } : {}),
          },
          accountGeneration: admittedGeneration,
          reopenCapable: supportsReopen(connectionId),
          ...((payload.externalKey.startsWith('telegram:group:') ||
            payload.externalKey.startsWith('telegram:topic:')) &&
          commitContextCursor
            ? { commitContextCursor }
            : {}),
          ...(resolved.notice ? { notice: resolved.notice } : {}),
          ...(resolved.cleanupWorktree ? { cleanupWorktree: resolved.cleanupWorktree } : {}),
        };
        const sessionId = resolved.run.sessionId;
        await serializeSessionAdmission(sessionId, async () => {
          if (!isCurrentGeneration(admittedGeneration)) return;
          const initialQueue = queues.get(sessionId) ?? [];
          const initiallyBusy =
            running.has(sessionId) || runner.isBusy(sessionId) || initialQueue.length > 0;
          if (initiallyBusy && initialQueue.length >= MAX_QUEUE_PER_SESSION) {
            reply(connectionId, send, rejected(payload.requestId, 'invalid'));
            log.warn(`dispatch queue overflow: session=${sessionId}`);
            return;
          }

          // 排队任务只保存 commit 回调；provider 尚未受理，不得提前推进 durable cursor。
          const queue = queues.get(sessionId) ?? [];
          if (running.has(sessionId) || runner.isBusy(sessionId) || queue.length > 0) {
            const ack: TaskAckPayload = {
              requestId: payload.requestId,
              result: 'queued',
              reason: null,
              sessionId,
              queuePosition: queue.length,
            };
            const task: PendingTask = {
              ...taskBase,
              ack,
            };
            queue.push(task);
            queues.set(sessionId, queue);
            reply(connectionId, send, ack);
            // 排队也要给 👀: 用户看到的是「消息发出去了但没人理」, 分不清是在
            // 排队还是丢了。表情只在**进队列这一刻**发一次 —— 出队启动走的是
            // startExecution, 那里不再补发, 否则同一条消息会被打两次。
            ackReactions.onAccepted(ackTaskOf(task), send);
            // 排队时目标 session 可能是 desktop 侧用户手动在跑(runner.isBusy),
            // 没有本模块的收口点 —— 轮询兜底: 空闲即 drain
            if (!running.has(sessionId)) scheduleDrainPoll(sessionId);
            return;
          }

          running.add(sessionId);
          const ack: TaskAckPayload = {
            requestId: payload.requestId,
            result: 'accepted',
            reason: null,
            sessionId,
            queuePosition: null,
          };
          const task: PendingTask = { ...taskBase, ack };
          reply(connectionId, send, ack);
          ackReactions.onAccepted(ackTaskOf(task), send);
          startExecution(task);
        });
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
      for (const admission of pendingGroupAdmissions.values()) {
        if (admission.accepted || admission.cancelled) continue;
        admission.cancelled = true;
        finishTaskAsCancelled(admission.task);
      }
      // 只收口本 PR 新增的“携带群上下文 commit”任务；Slack/X 普通队列保持
      // 既有账号 teardown 语义。终态必须在 sendFns / delivery buffer 清理前落下。
      for (const queue of queues.values()) {
        for (const task of queue) {
          if (task.commitContextCursor) finishTaskAsCancelled(task);
        }
      }
      // 👀 的欠账要在 sendFns 清理**之前**结: 运行中的任务会因账号代次失效
      // 跳过 onFinished, 排队任务被直接清 —— 直接 reset 会把它们的消息永远留在
      // 处理中。
      ackReactions.onAccountTeardown((cid) => sendFns.get(cid));
      queues.clear();
      sendFns.clear();
      pendingTurnEnds.clear();
      for (const key of [...pendingDeliveryTurnEnds.keys()]) clearPendingDelivery(key);
      // 能力快照按连接存, 而连接身份含账号指纹 —— 换账号后旧条目永远不会再被
      // 命中, 但留着会让 supportsReopen 对"同名连接"给出上一个账号的答案。
      serverFeatures.clear();
      // ack 的待补发与可回落表随账号走 —— 换账号后它们指向的连接与消息都不再
      // 属于当前主人, 留着既补不出去也是一份只涨不落的内存。
      ackReactions.reset();
      // 续跑记账与在观察的续跑轮都属于上一个账号, 一并清掉(记账里带
      // accountGeneration 只是第二道防线, 表本身不该跨账号留存)。
      for (const sessionId of [...activeContinuations.keys()]) {
        dropContinuation(sessionId, { silent: true, remember: false });
      }
      pendingReopens.clear();

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
        await Promise.allSettled([...keyChains.values(), ...sessionAdmissionChains.values()]);
        await Promise.allSettled([...executing]);

        ackHistory.clear();
        inflightRequests.clear();
        running.clear();
        runningByRequest.clear();
        pendingGroupAdmissions.clear();
        cancelRequested.clear();
        // 切账号时 execute() 会在代际检查处提前 return, 走不到收口那行删除 ——
        // 不在这里清的话, 每次切账号都永久留下一条 sessionId + 完整工作目录路径
        // (PR #733 review 指出)。这些会话属于上一个账号, 新账号下本就不该免检。
        awaitingPersist.clear();
        staleTakeoverReplacements.clear();
        keyChains.clear();
        sessionAdmissionChains.clear();
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
        staleTakeoverReplacements.delete(bindingKey(connectionId, externalKey));
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
    handleTurnDelivery(connectionId, payload) {
      if (!accountActive) return;
      const key = ackKey(connectionId, payload.requestId);
      clearPendingDelivery(key);
      // 任一回执都表示 server 已持久接管: 账本从 pending 收口为 sent, 重启后
      // 不再补发。标记失败时保持 pending, 由重连补发 + server 收据幂等兜底。
      if (terminalLedger) markTerminalSent(connectionId, payload.requestId);
      if (payload.state === 'retrying') {
        log.warn(
          `turn.end accepted; X publish retrying: requestId=${payload.requestId} attempt=${payload.attempt} retryAt=${payload.retryAt ?? 'unknown'} code=${payload.error?.code ?? 'unknown'}`,
        );
        return;
      }
      if (payload.state === 'failed') {
        log.warn(
          `turn.end delivery failed: requestId=${payload.requestId} attempt=${payload.attempt} code=${payload.error?.code ?? 'unknown'}`,
        );
        return;
      }
      log.info(
        `turn.end delivery ${payload.state}: requestId=${payload.requestId} attempt=${payload.attempt}`,
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
          finishTaskAsCancelled(task);
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
      for (const pending of pendingDeliveryTurnEnds.values()) {
        if (pending.connectionId !== connectionId || pending.timer === null) continue;
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      // 断连是续跑回流的终局(协议阶段 18): server 此刻会收口那条消息并解绑这一轮
      // 的 requestId。观察器若活到重连后, 它的 progress / turn.end 会带着那个已被
      // 解绑的 id 发到新 socket(dispatchId 在重连间稳定, 所以真的发得出去), 被当
      // 未知 id 丢弃; 更糟的是 error 收口还会把这个 stale id 登记成下一轮的
      // reopenOf。所以在这里就撤掉, 与"turn.end 直发不缓存"同一个决定。
      for (const [sessionId, watching] of [...activeContinuations]) {
        // 连接已断: server 那边已孤儿收口并解绑 requestId, 迟到的帧只会被丢弃。
        if (watching.connectionId === connectionId) {
          dropContinuation(sessionId, { silent: true, remember: false });
        }
      }
      // 能力集只在握手时才权威。断连后不清会留下"上一次连上的那个 server 实例"
      // 的快照: 滚动发布时重连可能落到不宣告 turn.reopen 的老实例上, 而在
      // onConnected 重设之前, supportsReopen 会按旧快照放行发帧。
      serverFeatures.delete(connectionId);
    },
    dispose() {
      unsubscribeUiContinuation?.();
      unsubscribeUiIntervention?.();
      unsubscribeUiTurnDispatching?.();
      unsubscribeUiTurnUndispatched?.();
      pendingClaims.clear();
      for (const sessionId of [...activeContinuations.keys()]) {
        dropContinuation(sessionId, { silent: true, remember: false });
      }
      pendingReopens.clear();
      staleTakeoverReplacements.clear();
      serverFeatures.clear();
      sendFns.clear();
      pendingTurnEnds.clear();
      for (const key of [...pendingDeliveryTurnEnds.keys()]) clearPendingDelivery(key);
    },
    onMessageOpResult(payload: MessageOpResultPayload) {
      // 带上按连接取发送函数的钩子: 群限制了可用表情时要用基础款回落一次,
      // 而该发到哪条连接由 ackReactions 自己记的 task 决定。
      ackReactions.onResult(payload, (connectionId) => sendFns.get(connectionId));
    },
    setEmojiReactionsMode(mode: TelegramEmojiReactions | null) {
      emojiReactionsMode = mode;
    },
    settleAckReactions() {
      ackReactions.onAccountTeardown((cid) => sendFns.get(cid));
    },
    onConnected(connectionId, send, features) {
      if (!accountActive) return;
      // 能力集以最新一次握手为准: 滚动发布时重连可能落到另一版本的实例上,
      // 老实例不宣告 turn.reopen 时必须立刻停用回流, 不能拿上一次的快照发帧。
      serverFeatures.set(connectionId, features ? [...features] : []);
      sendFns.set(connectionId, send);
      // 断线时没送出去的终态表情在这里补 —— 否则那条消息永远挂着 👀。
      // opId 由 requestId 派生, 服务端按它去重, 补发不会打出第二个。
      ackReactions.onReconnected(connectionId, send);
      const deliveryAck = supportsDeliveryAck(connectionId);
      for (const [key, pending] of [...pendingDeliveryTurnEnds]) {
        if (pending.connectionId !== connectionId) continue;
        if (deliveryAck) {
          sendPendingDelivery(key, pending, send);
          continue;
        }
        // 同 socket 能力降级(refreshHello/welcome 重新协商为无 ACK)不经过
        // onDisconnected, ACK 世代武装的退避 timer 可能仍在计时; 若下面这次
        // 回落发送恰好失败, 到点的 timer 会向永远不回 turn.delivery 的老
        // server 无限重放。进入无 ACK 世界先无条件缴械。
        if (pending.timer) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }
        if (send(pending.message)) {
          // 滚动发布回落到老 server：按历史 fire-and-forget 语义收口。
          clearPendingDelivery(key);
        }
      }
      const buf = pendingTurnEnds.get(connectionId);
      const flushedRequestIds = new Set<string>();
      if (buf?.length) {
        // 当前进程的完整帧优先(可能带附件); 发送失败时保留剩余项。
        // 新 server 转入 ACK 缓冲重放, 老 server 沿用 fire-and-forget。
        while (buf.length > 0) {
          const pending = buf[0];
          if (deliveryAck) {
            // 账本保持 pending, 收到 turn.delivery 回执才收口(见 handleTurnDelivery)。
            trackPendingDelivery(connectionId, pending.message);
          } else {
            if (!send(pending.message)) return;
            if (!markTerminalSent(connectionId, pending.terminal.requestId)) {
              persistTerminalRecord({
                ...pending.terminal,
                delivery: 'sent',
                completedAt: Date.now(),
              });
            }
          }
          buf.shift();
          flushedRequestIds.add(pending.terminal.requestId);
        }
        pendingTurnEnds.delete(connectionId);
      }
      let durablePending: HookTerminalRecord[] = [];
      try {
        durablePending = terminalLedger?.listPending(connectionId) ?? [];
      } catch {
        log.warn('hook durable turn.end outbox lookup threw; waiting for request replay');
      }
      for (const pending of durablePending) {
        // The full in-memory frame was already accepted above. If updating the
        // ledger failed, do not immediately duplicate it with the text-only
        // durable frame during the same reconnect attempt.
        if (flushedRequestIds.has(pending.requestId)) continue;
        if (!pending.turnEnd) continue;
        if (deliveryAck) {
          // 已在 ACK 缓冲中的条目由本函数开头的循环重放, 不再用文本帧重复补发。
          if (pendingDeliveryTurnEnds.has(ackKey(connectionId, pending.requestId))) continue;
          trackPendingDelivery(connectionId, makeTurnEnd(pending.turnEnd));
          continue;
        }
        if (!send(makeTurnEnd(pending.turnEnd))) return;
        if (!markTerminalSent(connectionId, pending.requestId)) {
          persistTerminalRecord({ ...pending, delivery: 'sent' });
        }
      }
    },
  };
}
