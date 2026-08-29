import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  MAKER_EVENT_BATCH_CHANNEL,
  SESSION_ACTIVITY_CHANNEL,
  expandMakerEventBatchPayload,
  type SessionActivityPayload,
} from '@cindy/device-link';
import {
  applyAgentTaskUpdateEvent,
  isSameAgentTaskAlias,
  normalizeAgentTaskUpdate,
  type AgentTaskUpdate,
} from '@cindy/maker-shared/agent-task';
import type { MobileGoalStatusPayload } from '@cindy/maker-shared/device-link-contract';
import { applyCodexPlanSnapshotOnDone, markCodexPlanTurnFailed } from '@cindy/maker-shared/message-render';
import type { RemoteSessionLiveActivity } from '@cindy/maker-shared/session-list';
import { buildDeviceIdentity, resolveCanonicalDeviceId } from '@cindy/maker-shared/mobile-home';
import {
  isProductTurnDoneEvent,
  isTurnContinuationBoundaryEvent,
} from '@cindy/maker-shared/turn-continuation';
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { EMPTY_INPUT_PROJECTION, normalizeInputProjection } from '@/session/inputProjection';
import { sortPendingInteractions } from '@/session/interactionModel';
import { applySessionModelPrefPush } from '@/session/sessionModelMirror';
import {
  createLatestWriteGuard,
  createPendingWriteTracker,
  createSessionWriteQueue,
} from '@/session/swipeRowRegistry';
import {
  cacheSessionMessagesIfCurrent,
  captureSessionMessageCacheWriteAuthority,
  getCachedSessionMessages,
  isSessionMessageCacheWriteAuthorityCurrent,
  replaceCachedSessionMessages,
} from '@/session/mobileSessionMessageCache';
import { readComposerDocumentDraftSync, readComposerDraftSync } from '@/session/composerDraftStore';
import { composerDocumentHasContent } from '@/session/composerDocument';
import { getQuotes } from '@/session/chatQuoteStore';
import {
  sessionMessageLifecycle,
  type SessionMessageAuthority,
  type SessionMessageReclaimReason,
  type SessionMessageUnenteredAuthority,
  type SessionMessageWorkLease,
} from '@/session/sessionMessageLifecycle';
import { classifySessionRetention, type SessionRetentionKind } from '@/session/sessionRetention';
import { contentToPreview } from '@/utils/contentPreview';
import type { MobileSystemCardType } from '@/session/systemCard';
import type { InputProjection, PendingInteraction, RemoteMessage, RemoteSession } from '@/session/types';
import { clampLiveRowCreatedAt, compareMessageOrder, MESSAGE_PAGE_SIZE } from '@/session/messagePaging';
import { normalizeRemoteMoney } from '@/session/remoteMoney';

interface DeviceShard {
  deviceId: string;
  deviceName: string;
  sessions: RemoteSession[];
}

export interface RemoteNewMakerWorktreePreference {
  enabled: boolean;
  /**
   * 每次 pull / push / 本机显式点击都递增。新建页用它给在途 one-shot pull 做 fence，
   * 防止较早发出的响应覆盖后来到达的工作端 push 或用户选择。
   */
  revision: number;
}

const EMPTY_NEW_MAKER_WORKTREE_PREFERENCE: RemoteNewMakerWorktreePreference =
  Object.freeze({ enabled: false, revision: 0 });

/**
 * 工作端拥有的 New Maker worktree 源分支镜像。null 表示该 device + canonical
 * baseRepo 尚无显式选择；revision 完全采用工作端快照，手机不自行递增。
 */
export type RemoteNewMakerWorktreeBranchPreference = {
  baseRepo: string;
  sourceBranch: string;
  revision: number;
} | null;

/**
 * 会话元数据在途写登记(app 级单例):首页乐观写(置顶/归档/删除/重命名)begin 时
 * track、settle 时 release;`sessions:patched` push 应用前经 filterPatch 遮蔽在途
 * 字段,防止同字段旧写的 push 回流把本机更新的乐观意图滚回(review P2)。
 */
export const sessionPendingWrites = createPendingWriteTracker();

/**
 * 会话元数据写序守卫与出网队列(app 级单例):首页滑动操作与会话详情页菜单是同一组
 * 元数据写的两个入口,写序状态与同字段串行必须**跨页面共享**(review P1:首页置顶
 * 在退避中,进详情页取消置顶——组件实例级守卫感知不到对方,退避恢复后旧写覆盖新写)。
 */
export const sessionMetaWriteGuard = createLatestWriteGuard();
export const sessionMetaWriteQueue = createSessionWriteQueue();

export interface RemoteSessionRunStatus {
  isRunning: boolean;
  reconnectAttempt: RemoteSessionReconnectAttempt | null;
  sideTaskRunning: boolean;
  startedAt: number | null;
  status: string;
  tokenUsage: number;
  outputTokens: number;
  generationDurationMs: number;
  generationActive: boolean;
  generationReliable: boolean;
}

export interface RemoteSessionReconnectAttempt {
  attempt: number;
  maxAttempts: number;
  /**
   * 重试原因。`'overload'` = 上游模型没有可用容量；`'rate-limit'` = Codex daemon
   * 已耗尽内部 retry budget 后的受限外层重投；缺省 / `'reconnect'` = 传输层重连。
   *
   * 刻意复用同一个字段而不是新加一个: 这个 attempt 有 6 处清理点(turn 边界 / 快照 /
   * 收口 / 活动流), 拆成两个字段就得在每处各清一次, 漏一处就会残留一个假状态。
   */
  kind?: 'reconnect' | 'overload' | 'rate-limit';
}

interface SessionMessageSyncMarker {
  messageCount: number | null;
  updatedAt: string;
}

export interface SetLatestMessageWindowOptions {
  /** 读取发起时捕获的详情代际；失焦或重新聚焦后旧响应必须拒写。 */
  authority?: SessionMessageAuthority;
  /**
   * 本页**上沿之外服务端还有历史**(满页,或被 device-link 裁过行)。
   *
   * 真为真时,早于本页最旧行的缓存段一律不保留 —— 它与本页之间可能隔着从未加载的行,保留就会
   * 在窗口里留下孤岛(详见 `setLatestMessageWindow` 里的说明与 #1222)。调用方用既有的
   * `hasMoreOlderMessages` / `shouldKeepOlderMessagesAffordance` 判定即可,不需要自己数。
   *
   * 省略时按 false 处理(保持旧行为):调用方拿不到分页元信息时不该因此丢历史。
   */
  moreBeyondWindow?: boolean;
}

export interface SessionMessageWriteOptions {
  authority?: SessionMessageAuthority;
  /** 本行是否携带主机时间域的 createdAt；本地临时卡必须显式关闭。 */
  hostTimeAuthoritative?: boolean;
}

interface LivePlanSnapshot {
  content: Record<string, unknown>;
  persistId?: string;
  toolUseId: string;
}

const EMPTY_SESSION_RUN_STATUS: RemoteSessionRunStatus = Object.freeze({
  isRunning: false,
  reconnectAttempt: null,
  sideTaskRunning: false,
  startedAt: null,
  status: '',
  tokenUsage: 0,
  outputTokens: 0,
  generationDurationMs: 0,
  generationActive: false,
  generationReliable: true,
});

const shards = new Map<string, DeviceShard>();
// Per-device list mutation fence. A sessions:list request may start before a live
// sessions:created/patched push and settle after it; that older whole-list snapshot must
// never overwrite the newer push. Epochs stay monotonic across account/store resets.
const deviceSessionListMutationEpochs = new Map<string, number>();
let deviceSessionListMutationEpochFloor = 0;
let nextDeviceSessionListMutationEpoch = 0;

function bumpDeviceSessionListMutationEpoch(deviceId: string): void {
  if (!deviceId) return;
  deviceSessionListMutationEpochs.set(deviceId, ++nextDeviceSessionListMutationEpoch);
}

function readDeviceSessionListMutationEpoch(deviceId: string): number {
  return deviceSessionListMutationEpochs.get(deviceId) ?? deviceSessionListMutationEpochFloor;
}
// 工作端拥有的 New Maker worktree 偏好按设备隔离；这里只是不持久化的显示镜像，
// push 属 sessions topic，无 sessionId。唯一持久副本仍在被控端现有 Cindy 配置里。
const newMakerWorktreePreferences = new Map<string, RemoteNewMakerWorktreePreference>();
// deviceId → canonical baseRepo → 工作端权威分支快照。分支与 checkbox 是两份独立镜像；
// 任一分支 pull / push / write-back 都不得改动 newMakerWorktreePreferences。
const newMakerWorktreeBranchPreferences = new Map<
  string,
  Map<string, Exclude<RemoteNewMakerWorktreeBranchPreference, null>>
>();
const messages = new Map<string, RemoteMessage[]>();
// The maker event is broadcast before its async DB create/update completes. Keep the latest
// plan snapshot briefly in the session mirror so a late initial `messages:created` row cannot
// overwrite a newer live state with the first stale 0/N snapshot.
const livePlanSnapshots = new Map<string, Map<string, LivePlanSnapshot>>();
const pendingInteractions = new Map<string, PendingInteraction[]>();
/**
 * 这个会话的 pending 列表当前是不是**权威**的(来自被控端的一次全量快照)。
 *
 * 空列表有两种来源,消费方光看 `getPendingInteractions()` 分辨不了:
 * - 权威的空:被控端确认所有请求都已回答 / 撤销;
 * - 非权威的空:`markDeviceOffline` / `removeDevice` 按设计清掉了这份投影(它依赖
 *   实时连接),此刻我们其实不知道被控端还在等什么。
 *
 * 凡是「空快照才能做的清理」都必须先问这里,否则短暂离线会被误判成「都处理完了」。
 * 不能退化成看全局 relay status:目标设备 offline 时 relay 仍可能 online(#1493 review)。
 */
const pendingInteractionsAuthoritative = new Set<string>();
/**
 * 乐观 resolve 在途抑制集合:交互卡批准 / 拒绝已在本地乐观撤卡、被控端还没有
 * 确认的 requestId。这个窗口里权威流(全量快照 setPendingInteractions / push
 * 重放 applyInteractionRequest)可能把同一张卡重新灌回来造成「闪回」——凡在
 * 集合中的 request 一律过滤。失败复原时由 InteractionPanel 显式移除;成功时
 * 转入 confirmedInteractionDismissals 延长抑制(见下)。
 * key = `${sessionId}\u0000${requestId}`。
 */
const inFlightInteractionResolves = new Set<string>();
/**
 * 已确认 dismiss 的延长抑制集合:resolve 成功后**不能立即**解除过滤——在决定
 * 提交前发出、resolve 之后才返回的慢权威读取(syncSession 的 getPendingInteractions,
 * 弱网正是高发场景)仍持有含这张卡的旧快照,直接落地会闪回(codex review P2)。
 * 条目留到「一轮不含该 requestId 的全量快照」到达(被控端已确认移除,自然过期)
 * 才删除;interaction-dismissed push **不**提前回收——push 之后仍可能有更早发出
 * 的在途旧快照晚到(见 applyRemotePush 该分支注释)。
 */
const confirmedInteractionDismissals = new Set<string>();

function interactionResolveKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

/**
 * revision 化交互(当前只有 plugin_setup)的**决定下限**:本端已经对某个 revision
 * 提交过决定后,该 request 还能接受的最低 revision。
 *
 * 只有一个来源:本端对 revision R 提交过决定(plugin_setup 取消)→ 下限抬到 R+1。
 * R 及更旧的快照正是我决定之前的那批,滤掉才不会在决定生效后把卡带回来
 * (取消成功的 dismiss push 先到、取消前发出的慢快照后到)。
 *
 * 为什么不是「取消后无条件抑制该 requestId」(confirmedInteractionDismissals 那种):
 * 这类决定不是终局 —— 被控端按 `expectedRevision` 裁决,对不上时改为重新体检并推
 * 更高 revision 的新快照。无条件抑制会让那张仍需用户处理的卡永久隐身;下限则天然
 * 放行 R+1 及以后的快照。
 *
 * 下限只升不降,也**不按单轮快照回收**:一旦允许回落,晚到的旧快照就又拿回了覆盖权
 * (#530 review)。条目数等于会话里被取消过的 plugin_setup 请求数(极小),随
 * removeDevice / clear 清理。
 *
 * 注意它只管「成员能不能回来」。快照之间的乱序(没有任何决定,单纯弱网早发晚到)由
 * pickFresherInteraction 就地比较 revision 解决,不走这张表。
 */
const interactionRevisionFloors = new Map<string, number>();

/**
 * 合法的交互 revision:非负整数,与被控端对 `expectedRevision` 的要求一致
 * (parseGhostSetupInteractionCommand)。负数 / 小数不参与新旧比较与抑制判定,
 * 免得非法快照混进 revision 语义里(#530 review)。
 */
function interactionRevision(item: PendingInteraction): number | null {
  const revision = item.request.revision;
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : null;
}

/**
 * 同一 request 的两份快照取较新者。
 *
 * dedupe 只按 requestId、后写覆盖,所以一份早发晚到的旧快照会把 UI 从 revision 6
 * 换回 4,用户随后点取消还会发出过期的 expectedRevision(#530 review)。成员关系仍
 * 以权威快照为准,这里只保证**内容不回退**。
 */
function pickFresherInteraction(
  incoming: PendingInteraction,
  existing: PendingInteraction | undefined,
): PendingInteraction {
  if (!existing) return incoming;
  const incomingRevision = interactionRevision(incoming);
  const existingRevision = interactionRevision(existing);
  // 手上那份不带 revision(非 revision 化交互)→ 沿用既有的后写覆盖语义。
  if (existingRevision === null) return incoming;
  // 手上那份已进入 revision 语义,而来的一份连 revision 都没有(旧被控端 / 非法
  // 快照)→ 它没有资格覆盖:否则同样会把内容换回旧版本,并让取消发出过期的
  // expectedRevision(#530 review)。
  if (incomingRevision === null) return existing;
  return incomingRevision < existingRevision ? existing : incoming;
}

function isInteractionResolveSuppressed(sessionId: string, item: PendingInteraction): boolean {
  const requestId = item.request.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) return false;
  const key = interactionResolveKey(sessionId, requestId);
  if (inFlightInteractionResolves.has(key) || confirmedInteractionDismissals.has(key)) return true;
  const floor = interactionRevisionFloors.get(key);
  if (floor === undefined) return false;
  const revision = interactionRevision(item);
  // revision 缺失(旧被控端 / 非法快照)时保守过滤:这个 request 已经进入 revision
  // 语义,一份连 revision 都没有的快照没有资格把它带回来。
  return revision === null || revision < floor;
}

function interactionsByRequestId(list: readonly PendingInteraction[]): Map<string, PendingInteraction> {
  const byId = new Map<string, PendingInteraction>();
  for (const item of list) {
    const requestId = item.request.requestId;
    if (typeof requestId === 'string' && requestId.length > 0) byId.set(requestId, item);
  }
  return byId;
}
const inputProjections = new Map<string, InputProjection>();
/**
 * 新建任务第一帧标题预览。权威行在自动起名写库前仍是 New Maker；入队成功后
 * pendingLocalCreation 必须清掉才能解禁，所以预览不能绑在那根标上。权威标题
 * 一旦离开哨兵（智能标题或用户改名）就让位。
 */
const pendingTitlePreview = new Map<string, string>();
// Projection queries can resolve after a newer push or terminal boundary. Keep
// a monotonic per-session authority epoch so late snapshots cannot overwrite
// current queue / continuation state (mirrors Desktop makerChatStore).
const inputProjectionAuthorityEpochs = new Map<string, number>();
let nextInputProjectionAuthorityEpoch = 0;
let inputProjectionAuthorityEpochFloor = 0;
const inputProjectionRemoteEpochs = new Map<string, number>();
let nextInputProjectionRemoteEpoch = 0;
let inputProjectionRemoteEpochFloor = 0;
const inputProjectionRemoteQueuedEvidence = new Map<string, Map<string, number>>();
const INPUT_PROJECTION_REMOTE_EVIDENCE_LIMIT = 256;
const sessionLiveActivity = new Map<string, RemoteSessionLiveActivity>();
const sessionRunning = new Map<string, boolean>();
const sessionRunStatus = new Map<string, RemoteSessionRunStatus>();
// `maker:list-active` snapshots race live maker pushes during reconnect hydration. A snapshot
// may clear an older transient reconnect attempt, but must not erase a newer retry event that
// arrived after the request started.
const sessionMakerActivityEpochs = new Map<string, number>();
let makerActivityEpoch = 0;
const sessionMessageSyncMarkers = new Map<string, SessionMessageSyncMarker>();
/**
 * 每会话「已验证连续覆盖区间」:`[since, until]`(闭区间,ISO createdAt)内的**所有**服务端行都在
 * 窗口里 —— 中间没有服务端有、本地没加载的行。缺省(未登记)= 未知,窗口不被信任为连续。
 *
 * 为什么需要它:`setLatestMessageWindow` 判断"要不要保留早于本页的旧段"时,只有两种旧段
 *  - **来源不明的缓存**(冷开 hydrate 的那页):与本页的关系无从确认,本页上沿之外还有服务端历史
 *    时必须丢弃,否则窗口留下孤岛(#1222);
 *  - **已验证连续的历史**(整窗替换的那一页、用户一路「加载更早」翻出来的、以及订阅未断时收到的
 *    实时 push):与本页确实相接。把它一并丢掉会让用户正在看的历史和滚动锚点凭空消失,而且自动
 *    补齐也不会拉回(裁完窗口里已经没有内部跳变可发现了)——#1210 review 实测到的回归。
 * 区间就是区分这两者的那条线:旧行落在 `[since, until]` 内、**且本页最旧行不晚于 `until`**
 * (两段首尾相接)时才保留。
 *
 * 为什么不能只记下界:下界断言的是"从它到**窗口最新端**连续",而"窗口最新端"会被断流期间漏收的
 * 行悄悄作废 —— 旧窗 1–80,断线漏收 81–200,重连后先到一条 push 201,再收到最新页 122–201:
 * 窗口最新端已经跳到 201,下界仍指着 1,旧结论于是给"1–80 + 122–201"这个孤岛背了书。把上界显式
 * 记下来,这类"接不上"就是一次比较(#1210 review)。
 *
 * `liveTailTrusted`:自 `until` 建立以来实时推送链路没断过 —— 只有这时新到的 push 才能把 `until`
 * 往后推(订阅内的推送是顺序且完整的)。它由**权威页落库那一刻订阅是否已 ACK**决定:屏幕侧的
 * `openAndSubscribe` 与 `startFocusedTopicSubscription` 都是 `void subscribe(...)`,刻意不等 ACK
 * (订阅只管之后的推送,不该挡数据读),所以页比订阅先到是常态 —— 这个空窗里被控端写下的行既不会
 * 进这一页、也不会被推过来,之后一条 push 就会把 `until` 抬过它们,而等尾部涨过一页后最新页已不含
 * 那几行,事实自检也发现不了(#1210 review)。反过来重连补齐路径(`rehydrate`)是 `await subscribe`
 * 之后才拉页的,所以那条路径拿到的是可信尾部。
 * 断流(socket 掉线、退后台释放 session 订阅、离开会话取消订阅)一律清掉信任位与 ACK 记录:之后
 * 收到的 push 与 `until` 之间可能漏了任意多行,不能续算。区间本身保留 —— 断流不会让断流前已验证
 * 的那段失效。信任位只能由「ACK 之后落库的权威页」重新点亮(ACK 本身不行:ACK 之前的空窗里可能
 * 已经漏了行,只有新的权威页能重新确定尾部)。
 *
 * 建立 / 扩展点(都对应"服务端一次给出的连续段"或"订阅内的顺序推送"):整窗替换 `setMessages`、
 * 最新窗口 `setLatestMessageWindow`、「加载更早」`mergeEarlierMessages`、实时 push `appendMessage`。
 * 冷开 hydrate 与空洞补齐 `mergeMessages` 刻意不登记:前者来源不明;后者补的是窗口内部的洞,补完
 * 要算准新区间得先确认窗口里没有别的洞——而这正是补齐本身在解决的问题(保守不动的代价是补回来
 * 的段可能在下一次满页同步时被丢弃,下次打开会重新补,方向上是安全的那一侧)。
 * 清空 / rewind / 会话回收一律删除(重置为未知),下次最新窗口同步会重建。
 *
 * 事实自检:最新页若在 `[since, until]` 内带来窗口没有的行,说明旧结论已被服务端事实推翻(桌面侧
 * 改写历史、迟到落库等),当次按"未知"处置,见 `joinableWindowCoverage`。
 */
type SessionWindowCoverage = {
  /** 区间下界(含)。 */
  since: string;
  /** 区间上界(含)。 */
  until: string;
  /** 见上:实时推送链路自 `until` 建立以来未断过,`until` 可被新 push 续推。 */
  liveTailTrusted: boolean;
};
const sessionWindowCoverage = new Map<string, SessionWindowCoverage>();
/**
 * 远端已 ACK「该会话实时流」订阅(topic `session:<id>`)的会话集合。只用来决定新落库的权威页能否
 * 把尾部标成可信(见 `liveTailTrusted`);由 device-link 的订阅 ACK / 释放两侧记账。
 */
const sessionLiveStreamAcked = new Set<string>();

/** 取一批行里最旧的 createdAt(空列表 → undefined)。 */
function oldestCreatedAt(list: readonly RemoteMessage[]): string | undefined {
  let oldest: string | undefined;
  for (const item of list) {
    if (!item.createdAt) continue;
    if (oldest === undefined || item.createdAt.localeCompare(oldest) < 0) oldest = item.createdAt;
  }
  return oldest;
}

/** 取一批行里最新的 createdAt(空列表 → undefined)。 */
function newestCreatedAt(list: readonly RemoteMessage[]): string | undefined {
  let newest: string | undefined;
  for (const item of list) {
    if (!item.createdAt) continue;
    if (newest === undefined || item.createdAt.localeCompare(newest) > 0) newest = item.createdAt;
  }
  return newest;
}

function forgetWindowCoverage(sessionId: string): void {
  sessionWindowCoverage.delete(sessionId);
}

/**
 * 这一页落库时尾部是否可信:订阅已 ACK → 之后的行会被推过来,`until` 可由 push 续推;订阅还没
 * ACK(页比订阅先到,屏幕侧的常态)→ 空窗里被控端写下的行既不在这一页、也不会被推来,尾部不可信。
 */
function liveTailTrustedForPage(sessionId: string): boolean {
  return sessionLiveStreamAcked.has(sessionId);
}

/** 整窗替换:窗口就是这一页,区间即这一页 —— 不与旧结论求并(旧内容已经不在窗口里了)。 */
function coverReplacedWindow(sessionId: string, list: readonly RemoteMessage[]): void {
  const since = oldestCreatedAt(list);
  const until = newestCreatedAt(list);
  if (!since || !until) {
    forgetWindowCoverage(sessionId);
    return;
  }
  sessionWindowCoverage.set(sessionId, {
    since,
    until,
    liveTailTrusted: liveTailTrustedForPage(sessionId),
  });
}

/**
 * 最新页对账后登记:本页自身是连续段。`joined` 是本次**实际采纳**的旧结论(与本页首尾相接、
 * 因此其覆盖的旧段被保留),undefined 表示旧段没被采纳、区间收敛到本页。
 *
 * 保留判据与这里必须用同一个 `joined`:否则"保留了旧段却不声明覆盖它"(下次同步照丢)或"声明了
 * 覆盖却已经把它丢掉"(凭空背书出一个孤岛)两个方向都会让区间与窗口对不上。
 */
function coverLatestPage(
  sessionId: string,
  pageOldest: string,
  pageNewest: string,
  joined: SessionWindowCoverage | undefined,
): void {
  const since = joined && joined.since.localeCompare(pageOldest) < 0 ? joined.since : pageOldest;
  const until = joined && joined.until.localeCompare(pageNewest) > 0 ? joined.until : pageNewest;
  // 采纳的旧结论若已经是可信尾部(它的 until 就是本次上界),沿用它;否则由本页落库时的 ACK 状态决定。
  const inheritsTrustedTail = joined?.liveTailTrusted === true
    && joined.until.localeCompare(pageNewest) >= 0;
  sessionWindowCoverage.set(sessionId, {
    since,
    until,
    liveTailTrusted: inheritsTrustedTail || liveTailTrustedForPage(sessionId),
  });
}

/**
 * 「加载更早」:沿 `before` 从窗口最旧端连续取的一页,把下界前移。
 *
 * 还没有任何结论时(冷开 hydrate 的窗口上翻),这一页只能证明"从它到它接上的那一行"连续 ——
 * `joinsAt` 就是合并前窗口的最旧行;窗口更上面的部分来源仍然不明,上界不能顺手抬到窗口最新端。
 */
function coverEarlierPage(sessionId: string, pageOldest: string, joinsAt: string | undefined): void {
  const current = sessionWindowCoverage.get(sessionId);
  if (current) {
    if (pageOldest.localeCompare(current.since) < 0) {
      sessionWindowCoverage.set(sessionId, { ...current, since: pageOldest });
    }
    return;
  }
  if (!joinsAt || pageOldest.localeCompare(joinsAt) > 0) return;
  sessionWindowCoverage.set(sessionId, { since: pageOldest, until: joinsAt, liveTailTrusted: false });
}

/** 订阅内到达的实时 push:顺序且完整,可把上界往后推。 */
function coverLiveRow(sessionId: string, message: RemoteMessage): void {
  const current = sessionWindowCoverage.get(sessionId);
  if (!current || !current.liveTailTrusted) return;
  // 本地系统卡(/learn、/context 等)没有服务端对应行:用它推上界等于凭空声明"服务端到这一刻的
  // 行都在窗口里"。
  if (messageKey(message).startsWith('mobile-system-')) return;
  const createdAt = message.createdAt;
  if (!createdAt || createdAt.localeCompare(current.until) <= 0) return;
  sessionWindowCoverage.set(sessionId, { ...current, until: createdAt });
}

/**
 * 实时推送链路中断:ACK 记录作废,上界也不再能被 push 续算(见 `liveTailTrusted`)。区间本身保留。
 * 省略 sessionId = 全部会话(socket 掉线影响所有订阅)。
 */
function noteLiveStreamInterrupted(sessionId?: string): void {
  if (sessionId !== undefined) {
    sessionLiveStreamAcked.delete(sessionId);
    const current = sessionWindowCoverage.get(sessionId);
    if (current?.liveTailTrusted) {
      sessionWindowCoverage.set(sessionId, { ...current, liveTailTrusted: false });
    }
    return;
  }
  sessionLiveStreamAcked.clear();
  for (const [key, current] of sessionWindowCoverage) {
    if (current.liveTailTrusted) {
      sessionWindowCoverage.set(key, { ...current, liveTailTrusted: false });
    }
  }
}

/**
 * 取本次可采纳的旧结论:必须与本页首尾相接(本页最旧行不晚于上界),且没有被本页的事实推翻
 * (本页在区间内带来了窗口里没有的行)。任一不成立 → undefined,按"未知"处置。
 */
function joinableWindowCoverage(
  sessionId: string,
  existingIndex: MessageIdentityIndex,
  latestWindow: readonly RemoteMessage[],
  pageOldest: string,
): SessionWindowCoverage | undefined {
  const coverage = sessionWindowCoverage.get(sessionId);
  if (!coverage) return undefined;
  if (pageOldest.localeCompare(coverage.until) > 0) return undefined;
  for (const item of latestWindow) {
    const createdAt = item.createdAt;
    if (!createdAt) continue;
    if (createdAt.localeCompare(coverage.since) < 0) continue;
    if (createdAt.localeCompare(coverage.until) > 0) continue;
    if (!messageIdentityIndexHas(existingIndex, item)) return undefined;
  }
  return coverage;
}
// Per-session live sub-agent task state, decoded from `agent_task_update` events (live-only,
// never persisted — see @cindy/maker-shared/agent-task). Keyed taskId/parentToolUseId → update.
const sessionTaskUpdates = new Map<string, ReadonlyMap<string, AgentTaskUpdate>>();
// `maker:event` reaches the control phone before the desktop's async DB write completes.
// Keep one temporary assistant row per session and reconcile it with the persisted row by
// clientId/persistId when the database push arrives.
const streamingAssistantClientIds = new Map<string, string>();
// The same persisted streaming identity can be replayed by a stale transport after
// re-link. Track the transport currently assembling that identity so a device switch
// replaces the stale live text instead of concatenating two transports into one row.
const streamingAssistantDeviceIds = new Map<string, Map<string, string>>();
const pendingLiveAssistantClientIds = new Map<string, Set<string>>();
// 首个 live 行可能早于 getSession / listMessages 到达。此时只能暂用手机时间，待第一份
// 主机时间水位到达后重锚；否则快手机时钟会让短且无 persistId 的旧 live 行长期占据尾部。
// value 记录这条 provisional 回复首次关联到的 userSendAt；重连期间 desktop 若已推进到
// 下一轮，旧回复不能被新轮 user 行认领。null 表示 live 行早于任何 session 元数据到达，
// 首份 userSendAt 会在 recomputeSessions 中完成一次性绑定，之后不再随新轮次前移；若
// null 身份先经历软离线，则禁止用重连后的“首份”元数据绑定，因为它可能已经是下一轮。
type PendingHostAnchorIdentity = {
  bindOnMetadata: boolean;
  /** Transports that have produced this provisional identity. */
  deviceIds: ReadonlySet<string>;
  /**
   * Local maker-turn cohort used only while host session metadata is unavailable.
   * Distinct assistant rows emitted by one running turn share this id, so the first
   * authoritative user row can consume the whole reply block without claiming rows
   * from a later turn. Once sendAt is known it remains as the stronger pre-metadata
   * grouping key; identities created with host metadata use sendAt directly.
   */
  unboundRoundId: number | null;
  sendAt: string | null;
};
const pendingHostAnchorLiveAssistantClientIds = new Map<
  string,
  Map<string, PendingHostAnchorIdentity>
>();
const activePendingHostAnchorRoundIds = new Map<string, number>();
let nextPendingHostAnchorRoundId = 0;
let streamingFallbackSequence = 0;
const GENERATED_FALLBACK_MIN_PREFIX_LENGTH = 12;
const TEXT_DELTA_BATCH_INTERVAL_MS = 32;
const DEVICE_LINK_TRUNCATED_FLAG = '__deviceLinkTruncated';
const pendingTextDeltaBatches = new Map<string, {
  text: string;
  persistId?: string;
  deviceId?: string;
  agentMeta: Record<string, unknown> | null;
}>();
let textDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

function streamingAssistantDeviceId(
  sessionId: string,
  clientId: string,
): string | undefined {
  return streamingAssistantDeviceIds.get(sessionId)?.get(clientId);
}

function rememberStreamingAssistantDeviceId(
  sessionId: string,
  clientId: string,
  deviceId: string,
): void {
  const existing = streamingAssistantDeviceIds.get(sessionId) ?? new Map<string, string>();
  existing.set(clientId, deviceId);
  streamingAssistantDeviceIds.set(sessionId, existing);
}

function forgetStreamingAssistantDeviceId(sessionId: string, clientId: string): boolean {
  const existing = streamingAssistantDeviceIds.get(sessionId);
  if (!existing || !existing.delete(clientId)) return false;
  if (existing.size === 0) streamingAssistantDeviceIds.delete(sessionId);
  return true;
}

function clearStreamingAssistantPointer(sessionId: string): boolean {
  return streamingAssistantClientIds.delete(sessionId);
}

function clearStreamingAssistantState(sessionId: string): boolean {
  const clientIdChanged = clearStreamingAssistantPointer(sessionId);
  const deviceIdChanged = streamingAssistantDeviceIds.delete(sessionId);
  return clientIdChanged || deviceIdChanged;
}

// 目标模式状态镜像:null = 已确认无 goal(get-status 拉过 / push 清除);缺项 = 尚未拉取。
const sessionGoalStatus = new Map<string, MobileGoalStatusPayload | null>();
// maker `status` 事件驱动的权威 turn 边界(与 sessionRunning 分开):sessionRunning 还会被
// activity 推送 / 活跃快照置 true,重连或 activity 先到时会污染 false→true 的 turn-start 检测,
// 导致 stale taskUpdates 清理被跳过。孤儿 agent_task 卡的渲染 gate 与 turn-start 清理都只认
// 这份边界,构成闭环:孤儿只在 maker turn 运行中渲染,而 maker turn start 必然先清 stale。
const sessionMakerTurnRunning = new Map<string, boolean>();
const sessionDeviceIndex = new Map<string, string>();
// 已收到 error-persisted 脏信号且缓存消息仍在的会话集合。session 页面监听此 Set,
// 检测到自身 sessionId 被加入时调 load() 触发整窗刷新(含 error 行),避免先清空导致空白帧。
const pendingRefreshSessions = new Set<string>();
const reseedHandlers = new Map<string, Set<() => void>>();
const subs = new Set<() => void>();
const emptyMessages: RemoteMessage[] = [];
const emptyPendingInteractions: PendingInteraction[] = [];
const EMPTY_TASK_UPDATES: ReadonlyMap<string, AgentTaskUpdate> = new Map();
const REGULAR_SESSION_GLOBAL_MESSAGE_BUDGET = 800;
const REGULAR_SESSION_GLOBAL_MESSAGE_BYTES_BUDGET = 64 * 1024 * 1024;
const MESSAGE_STRUCTURAL_BYTES_ESTIMATE = 512;
const messageBytesEstimates = new WeakMap<RemoteMessage, number>();
const sessionLastAccessOrder = new Map<string, number>();
let nextSessionAccessOrder = 0;

function sessionById(sessionId: string): RemoteSession | undefined {
  return mergedSessions.find((session) => session.id === sessionId);
}

function retentionForSession(sessionId: string): SessionRetentionKind {
  return classifySessionRetention(sessionById(sessionId));
}

function touchSessionAccess(sessionId: string): void {
  sessionLastAccessOrder.set(sessionId, ++nextSessionAccessOrder);
}

function estimateMessageBytes(message: RemoteMessage): number {
  const cached = messageBytesEstimates.get(message);
  if (cached !== undefined) return cached;
  let bytes = MESSAGE_STRUCTURAL_BYTES_ESTIMATE;
  if (typeof message.content === 'string') bytes += message.content.length * 2;
  else if (message.content != null) bytes += safeStableStringify(message.content).length * 2;
  if (message.agentMeta) bytes += safeStableStringify(message.agentMeta).length * 2;
  if (message.systemCardData) bytes += safeStableStringify(message.systemCardData).length * 2;
  messageBytesEstimates.set(message, bytes);
  return bytes;
}

function isMessageWindowProtectedRow(sessionId: string, message: RemoteMessage): boolean {
  if (messageKey(message).startsWith('mobile-system-')) return true;
  if (isPendingLiveAssistantMessage(sessionId, message)) return true;
  return message.role === 'user' && !message.id;
}

/**
 * 软窗口：不可重取的本地/在途行全部保留，剩余额度给最新服务端行。保护行较多时
 * 允许略超上限，数据安全优先于精确条数。
 */
function trimMessageWindow(
  sessionId: string,
  list: readonly RemoteMessage[],
  limit = MESSAGE_PAGE_SIZE,
): RemoteMessage[] {
  if (list.length <= limit) return [...list];
  const protectedRows: RemoteMessage[] = [];
  const evictableRows: RemoteMessage[] = [];
  for (const row of list) {
    if (isMessageWindowProtectedRow(sessionId, row)) protectedRows.push(row);
    else evictableRows.push(row);
  }
  const keepEvictable = Math.max(0, limit - protectedRows.length);
  return normalizeMessages([
    ...protectedRows,
    ...evictableRows.slice(Math.max(0, evictableRows.length - keepEvictable)),
  ]);
}

function hasComposerDraft(sessionId: string): boolean {
  if ((readComposerDraftSync(sessionId) ?? '').trim().length > 0) return true;
  const document = readComposerDocumentDraftSync(sessionId);
  if (document && composerDocumentHasContent(document)) return true;
  return getQuotes(sessionId).length > 0;
}

function sessionStoreProtected(sessionId: string, includeVisible = true): boolean {
  if (includeVisible && sessionMessageLifecycle.isVisible(sessionId)) return true;
  if (readSessionRunStatus(sessionId).isRunning) return true;
  if (sessionMakerTurnRunning.get(sessionId) === true) return true;
  if ((pendingInteractions.get(sessionId)?.length ?? 0) > 0) return true;
  if ((inputProjections.get(sessionId)?.pendingQueue.length ?? 0) > 0) return true;
  if (sessionMessageLifecycle.hasLocalWork(sessionId)) return true;
  if (retentionForSession(sessionId) === 'regular' && hasComposerDraft(sessionId)) return true;
  return false;
}

function messageWriteAllowed(
  sessionId: string,
  authority?: SessionMessageAuthority,
): boolean {
  if (authority && (
    authority.sessionId !== sessionId
    || !sessionMessageLifecycle.canCommit(authority)
  )) return false;
  if (
    sessionMessageLifecycle.isVisible(sessionId)
    || sessionMessageLifecycle.hasLocalWork(sessionId)
  ) return true;
  // schedule 从未打开时也不能被全局 push 灌入正文；regular 在详情离场后同样
  // 拒绝旧订阅/流式 flush，未曾打开的普通任务仍保留既有全局镜像行为。
  if (retentionForSession(sessionId) === 'schedule') return false;
  return !sessionMessageLifecycle.hasEntered(sessionId);
}

function normalizeWindowForRetention(
  sessionId: string,
  list: readonly RemoteMessage[],
): RemoteMessage[] {
  return retentionForSession(sessionId) === 'schedule'
    ? trimMessageWindow(sessionId, list)
    : [...list];
}

function clearSessionMessageCache(sessionId: string, deviceId?: string): void {
  const resolvedDeviceId = deviceId ?? sessionDeviceIndex.get(sessionId);
  if (!resolvedDeviceId) return;
  void replaceCachedSessionMessages(resolvedDeviceId, sessionId, []).catch(() => undefined);
}

function invalidateSessionMessageWindowState(
  sessionId: string,
  requestRefresh: boolean,
): boolean {
  let changed = messages.delete(sessionId);
  changed = livePlanSnapshots.delete(sessionId) || changed;
  changed = sessionTaskUpdates.delete(sessionId) || changed;
  changed = sessionParkedTaskUpdates.delete(sessionId) || changed;
  changed = sessionMessageSyncMarkers.delete(sessionId) || changed;
  changed = clearStreamingAssistantState(sessionId) || changed;
  changed = pendingLiveAssistantClientIds.delete(sessionId) || changed;
  changed = pendingHostAnchorLiveAssistantClientIds.delete(sessionId) || changed;
  changed = activePendingHostAnchorRoundIds.delete(sessionId) || changed;
  if (pendingTextDeltaBatches.has(sessionId)) {
    discardPendingTextDelta(sessionId);
    changed = true;
  }
  if (sessionWindowCoverage.has(sessionId)) changed = true;
  forgetWindowCoverage(sessionId);
  changed = sessionLiveStreamAcked.delete(sessionId) || changed;
  sessionLastAccessOrder.delete(sessionId);
  if (requestRefresh && !pendingRefreshSessions.has(sessionId)) {
    pendingRefreshSessions.add(sessionId);
    changed = true;
  } else if (!requestRefresh) {
    changed = pendingRefreshSessions.delete(sessionId) || changed;
  }
  return changed;
}

function removeSessionRuntimeState(sessionId: string): void {
  invalidateSessionMessageWindowState(sessionId, false);
  pendingInteractions.delete(sessionId);
  pendingInteractionsAuthoritative.delete(sessionId);
  inputProjections.delete(sessionId);
  inputProjectionRemoteEpochs.delete(sessionId);
  inputProjectionRemoteQueuedEvidence.delete(sessionId);
  bumpInputProjectionAuthorityEpoch(sessionId);
  sessionLiveActivity.delete(sessionId);
  sessionRunning.delete(sessionId);
  sessionRunStatus.delete(sessionId);
  sessionMakerActivityEpochs.delete(sessionId);
  sessionMakerTurnRunning.delete(sessionId);
  sessionMessageLifecycle.forget(sessionId);
  sessionDeviceIndex.delete(sessionId);
  dropPendingTitlePreview(sessionId);
  // revision 下限按会话回收:它不参与单轮快照回收(那会把覆盖权还给晚到的
  // 旧快照),所以只能在会话本身消失时清,保持有界。
  const sessionPrefix = interactionResolveKey(sessionId, '');
  for (const key of interactionRevisionFloors.keys()) {
    if (key.startsWith(sessionPrefix)) interactionRevisionFloors.delete(key);
  }
}

function discardTransportOwnedPendingSessionState(
  sessionId: string,
  deviceId: string,
): boolean {
  let changed = false;
  const batch = pendingTextDeltaBatches.get(sessionId);
  if (batch?.deviceId === deviceId) {
    discardPendingTextDelta(sessionId);
    changed = true;
  }
  const pendingAnchors = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  const pendingAnchorIds = new Set<string>();
  if (pendingAnchors) {
    for (const [id, identity] of pendingAnchors) {
      if (!identity.deviceIds.has(deviceId)) continue;
      if (identity.deviceIds.size > 1) {
        pendingAnchors.set(id, {
          ...identity,
          deviceIds: new Set([...identity.deviceIds].filter((candidate) => candidate !== deviceId)),
        });
        changed = true;
      } else {
        pendingAnchorIds.add(id);
      }
    }
  }
  const streamingDeviceIds = streamingAssistantDeviceIds.get(sessionId);
  if (streamingDeviceIds) {
    for (const [id, ownerDeviceId] of streamingDeviceIds) {
      if (ownerDeviceId === deviceId) pendingAnchorIds.add(id);
    }
  }
  if (pendingAnchorIds.size === 0) return changed;
  const existingMessages = messages.get(sessionId);
  if (existingMessages && pendingAnchorIds.size > 0) {
    const nextMessages = existingMessages.filter((message) => (
      !pendingAnchorIds.has(message.id) && !pendingAnchorIds.has(message.clientId)
    ));
    if (nextMessages.length !== existingMessages.length) {
      if (nextMessages.length > 0) messages.set(sessionId, nextMessages);
      else messages.delete(sessionId);
      changed = true;
    }
  }
  const pendingLiveIds = pendingLiveAssistantClientIds.get(sessionId);
  if (pendingLiveIds) {
    for (const id of pendingAnchorIds) pendingLiveIds.delete(id);
    if (pendingLiveIds.size === 0) pendingLiveAssistantClientIds.delete(sessionId);
  }
  const streamingClientId = streamingAssistantClientIds.get(sessionId);
  if (streamingClientId && pendingAnchorIds.has(streamingClientId)) {
    streamingAssistantClientIds.delete(sessionId);
  }
  for (const id of pendingAnchorIds) forgetStreamingAssistantDeviceId(sessionId, id);
  if (pendingAnchors) {
    for (const id of pendingAnchorIds) pendingAnchors.delete(id);
    if (pendingAnchors.size === 0) {
      pendingHostAnchorLiveAssistantClientIds.delete(sessionId);
      activePendingHostAnchorRoundIds.delete(sessionId);
    } else {
      const activeRoundId = activePendingHostAnchorRoundIds.get(sessionId);
      if (
        activeRoundId !== undefined
        && ![...pendingAnchors.values()].some((identity) => (
          identity.unboundRoundId === activeRoundId
        ))
      ) {
        activePendingHostAnchorRoundIds.delete(sessionId);
      }
    }
  }
  return true;
}

function hasTransportOwnedSessionStateFromOtherDevice(
  sessionId: string,
  deviceId: string,
): boolean {
  const batchDeviceId = pendingTextDeltaBatches.get(sessionId)?.deviceId;
  if (batchDeviceId !== undefined && batchDeviceId !== deviceId) return true;
  const pendingAnchors = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  if (pendingAnchors && [...pendingAnchors.values()].some((identity) => (
    [...identity.deviceIds].some((ownerDeviceId) => ownerDeviceId !== deviceId)
  ))) return true;
  const streamingDeviceIds = streamingAssistantDeviceIds.get(sessionId);
  return streamingDeviceIds
    ? [...streamingDeviceIds.values()].some((ownerDeviceId) => ownerDeviceId !== deviceId)
    : false;
}

function releaseSessionDetailProjections(sessionId: string): boolean {
  let changed = livePlanSnapshots.delete(sessionId);
  changed = sessionTaskUpdates.delete(sessionId) || changed;
  changed = sessionParkedTaskUpdates.delete(sessionId) || changed;
  changed = inputProjections.delete(sessionId) || changed;
  // 即使投影已经为空也要抬升 authority：离场/LRU 前启动的慢查询不能在下一次
  // 打开同一任务后把旧 pending queue 或 continuation owner 写回来。
  bumpInputProjectionAuthorityEpoch(sessionId);
  return changed;
}

function reclaimScheduleRuntimeMaps(sessionId: string): boolean {
  let changed = invalidateSessionMessageWindowState(sessionId, false);
  changed = releaseSessionDetailProjections(sessionId) || changed;
  return changed;
}

function enforceRegularMessageBudget(): boolean {
  let totalCount = 0;
  let totalBytes = 0;
  const candidates: Array<{
    sessionId: string;
    accessOrder: number;
    count: number;
    bytes: number;
  }> = [];
  for (const [sessionId, list] of messages) {
    if (retentionForSession(sessionId) !== 'regular') continue;
    const bytes = list.reduce((sum, message) => sum + estimateMessageBytes(message), 0);
    totalCount += list.length;
    totalBytes += bytes;
    if (!sessionStoreProtected(sessionId)) {
      const protectedRows = list.filter((message) => isMessageWindowProtectedRow(sessionId, message));
      // LRU 是整窗淘汰；只要含无服务端副本/尚未落库的保护行，就跳过整个会话。
      // 否则保留保护行会被缓存 hook 误当成完整窗口落盘，反而覆盖磁盘上的最新页。
      if (protectedRows.length > 0) continue;
      candidates.push({
        sessionId,
        accessOrder: sessionLastAccessOrder.get(sessionId) ?? 0,
        count: list.length,
        bytes,
      });
    }
  }
  if (
    totalCount <= REGULAR_SESSION_GLOBAL_MESSAGE_BUDGET
    && totalBytes <= REGULAR_SESSION_GLOBAL_MESSAGE_BYTES_BUDGET
  ) return false;
  candidates.sort((left, right) => left.accessOrder - right.accessOrder);
  let changed = false;
  for (const candidate of candidates) {
    if (
      totalCount <= REGULAR_SESSION_GLOBAL_MESSAGE_BUDGET
      && totalBytes <= REGULAR_SESSION_GLOBAL_MESSAGE_BYTES_BUDGET
    ) break;
    if (!messages.delete(candidate.sessionId)) continue;
    forgetWindowCoverage(candidate.sessionId);
    sessionLiveStreamAcked.delete(candidate.sessionId);
    releaseSessionDetailProjections(candidate.sessionId);
    totalCount -= candidate.count;
    totalBytes -= candidate.bytes;
    changed = true;
    // 这里只淘汰内存，不删除磁盘缓存。重开仍可乐观 hydrate 最新窗口。
  }
  return changed;
}

function applyMessageWriteRetention(sessionId: string): void {
  touchSessionAccess(sessionId);
  const current = messages.get(sessionId);
  if (current && retentionForSession(sessionId) === 'schedule') {
    const trimmed = trimMessageWindow(sessionId, current);
    if (!remoteMessageListsEqual(current, trimmed)) {
      forgetWindowCoverage(sessionId);
      messages.set(sessionId, trimmed);
    }
  }
  enforceRegularMessageBudget();
}

let mergedSessions: RemoteSession[] = [];
let messageVersion = 0;
let storeVersion = 0;

type LiveRowCreatedAtAnchor = {
  createdAt: string | undefined;
  /** 会话列表快照可能早于本次发送，只能临时钳制；消息水位才可完成重锚。 */
  provisional: boolean;
};

function liveRowCreatedAtAnchor(sessionId: string): LiveRowCreatedAtAnchor {
  const pendingHostAnchorIds = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  const session = mergedSessions.find((item) => item.id === sessionId);
  const authoritativeMessages = (messages.get(sessionId) ?? []).filter((message) => {
    const isPendingHostAnchor = pendingHostAnchorIds?.has(message.id) === true
      || pendingHostAnchorIds?.has(message.clientId) === true;
    const isLocalSystemCard = message.systemCardType !== undefined
      && (message.id.startsWith('mobile-system-') || message.clientId.startsWith('mobile-system-'));
    return !isPendingHostAnchor && !isLocalSystemCard;
  });
  const messageWatermark = newestCreatedAt(authoritativeMessages);
  if (messageWatermark) {
    const latestAuthoritativeMessage = authoritativeMessages[authoritativeMessages.length - 1];
    const newerUserSendAt = session?.userSendAt
      && session.userSendAt.localeCompare(messageWatermark) > 0
      ? session.userSendAt
      : undefined;
    return {
      createdAt: newerUserSendAt ?? messageWatermark,
      // user 尾行只有在没有更晚的 session.userSendAt 时才可认作本轮问题；否则它
      // 属于旧轮次，当前 user push 仍在途。assistant / tool 尾行同样只能提供临时时间锚。
      provisional: newerUserSendAt !== undefined || latestAuthoritativeMessage?.role !== 'user',
    };
  }
  return {
    createdAt: session?.userSendAt ?? session?.updatedAt ?? session?.createdAt,
    provisional: true,
  };
}

function latestUserSendAt(sessionId: string): string | undefined {
  return mergedSessions.find((item) => item.id === sessionId)?.userSendAt ?? undefined;
}

function authoritativeSessionDeviceId(sessionId: string): string | undefined {
  if (!deviceList) return undefined;
  const session = mergedSessions.find((item) => item.id === sessionId);
  const canonicalDeviceId = session?.canonicalDeviceId;
  if (canonicalDeviceId && deviceList.some((device) => device.deviceId === canonicalDeviceId)) {
    return canonicalDeviceId;
  }
  const indexedDeviceId = sessionDeviceIndex.get(sessionId);
  return indexedDeviceId && deviceList.some((device) => device.deviceId === indexedDeviceId)
    ? indexedDeviceId
    : undefined;
}

function userMessageMatchesLatestSend(sessionId: string, message: RemoteMessage): boolean {
  if (message.role !== 'user') return false;
  const userSendAt = latestUserSendAt(sessionId);
  return Boolean(userSendAt && message.createdAt.localeCompare(userSendAt) >= 0);
}

function userMessageCanConsumePendingLiveReply(
  sessionId: string,
  message: RemoteMessage,
): boolean {
  if (message.role !== 'user') return false;
  const userSendAt = latestUserSendAt(sessionId);
  // Before session metadata arrives, preserve the existing realtime ordering semantics.
  // Once a send marker exists, an older delayed push normally belongs to a previous round.
  // The exception is an unbound reply frozen by an offline transition: only an older user
  // row can identify that reply's original round after reconnect metadata has moved ahead.
  return !userSendAt
    || message.createdAt.localeCompare(userSendAt) >= 0
    || hasOfflineUnboundPendingHostAnchor(sessionId);
}

// 当前权威设备列表(由首页从设备列表 API reconcile 后注入)。每次重算会话时基于它 + 当前 shards(stale 侧)
// 重建身份索引,用于给会话算展示用 canonicalDeviceId(把 re-link 后残留 stale shard 认领回当前设备);
// 为 null 时不归一,安全退化。
let deviceList: readonly { deviceId: string; name: string }[] | null = null;
let conversationSearchDeviceModels: readonly {
  canOpen: boolean;
  deviceId: string;
  name: string | null;
  state: string;
}[] = [];

function emit(): void {
  storeVersion += 1;
  for (const sub of subs) sub();
}

function bumpInputProjectionAuthorityEpoch(sessionId: string): number {
  const epoch = ++nextInputProjectionAuthorityEpoch;
  inputProjectionAuthorityEpochs.set(sessionId, epoch);
  return epoch;
}

function recordInputProjectionRemoteEvidence(sessionId: string, clientIds: Iterable<string>, settled = false): void {
  const epoch = ++nextInputProjectionRemoteEpoch;
  inputProjectionRemoteEpochs.set(sessionId, epoch);
  let evidence = inputProjectionRemoteQueuedEvidence.get(sessionId);
  for (const clientId of clientIds) {
    inputProjectionRemoteQueuedEvidence.set(sessionId, evidence ??= new Map<string, number>());
    evidence.delete(clientId);
    evidence.set(clientId, settled ? -epoch : epoch);
  }
  while (evidence && evidence.size > INPUT_PROJECTION_REMOTE_EVIDENCE_LIMIT) evidence.delete(evidence.keys().next().value!);
}

function settleInputProjectionClientIds(
  sessionId: string,
  settledClientIds: ReadonlySet<string>,
): boolean {
  if (settledClientIds.size === 0) return false;
  recordInputProjectionRemoteEvidence(sessionId, settledClientIds, true);
  const current = inputProjections.get(sessionId);
  const pendingQueue = current?.pendingQueue.filter(
    (item) => !settledClientIds.has(item.clientId),
  );
  const projectionChanged = Boolean(current && pendingQueue?.length !== current.pendingQueue.length);
  if (!projectionChanged || !current || !pendingQueue) return false;
  inputProjections.set(sessionId, { ...current, pendingQueue });
  bumpInputProjectionAuthorityEpoch(sessionId);
  return true;
}

function settleInputProjectionFromMessages(
  sessionId: string, list: readonly RemoteMessage[],
): boolean {
  const tracked = new Set(inputProjections.get(sessionId)?.pendingQueue.map((item) => item.clientId) ?? []);
  for (const [clientId, epoch] of inputProjectionRemoteQueuedEvidence.get(sessionId) ?? []) if (epoch > 0) tracked.add(clientId);
  if (tracked.size === 0) return false;
  const settled = new Set(list
    .filter((message) => message.role === 'user' && tracked.has(message.clientId))
    .map((message) => message.clientId));
  return settleInputProjectionClientIds(sessionId, settled);
}

function invalidateInputProjectionForOffline(sessionId: string): boolean {
  recordInputProjectionRemoteEvidence(sessionId, []);
  return inputProjections.delete(sessionId);
}

function commitInputProjection(sessionId: string, next: InputProjection): boolean {
  if (deepValueEqual(inputProjections.get(sessionId) ?? EMPTY_INPUT_PROJECTION, next)) {
    if (next.pendingQueue.length === 0) sessionMessageLifecycle.retryPendingReclaim(sessionId);
    return false;
  }
  inputProjections.set(sessionId, next);
  if (next.pendingQueue.length === 0) sessionMessageLifecycle.retryPendingReclaim(sessionId);
  emit();
  return true;
}

function recomputeSessions(): void {
  const previousRetention = new Map(
    mergedSessions.map((session) => [session.id, classifySessionRetention(session)] as const),
  );
  sessionDeviceIndex.clear();
  // 跨 shard 去重 + 设备身份归一化。re-link 后同一 session.id 可能同时存在于 stale / current 两个 shard;
  // 保留「物理 deviceId 是当前已知设备」的那条(current shard 优先,它路由正确且是真身),都不是已知设备
  // 时保留先遇到的。canonicalDeviceId 写展示用规范 id(认领回当前设备),deviceLinkDeviceId 保物理不动。
  // sessionDeviceIndex 记保留条的物理 shard —— applySessionPatch / 活动推送按真实来源设备路由。
  // 每次重算都基于当前设备列表 + 当前 shards(stale 侧)重建身份索引:认领要求当前设备侧名字唯一 + stale 侧
  // 同名也唯一(避免把两台同名旧机并到一台当前设备),placeholder 名(unknown / no)不参与匹配。
  const identity = deviceList
    ? buildDeviceIdentity(deviceList, [...shards.values()].map((s) => ({ deviceId: s.deviceId, name: s.deviceName })))
    : null;
  const byId = new Map<string, { session: RemoteSession; physicalDeviceId: string; known: boolean }>();
  for (const shard of shards.values()) {
    const canonicalDeviceId = identity
      ? resolveCanonicalDeviceId(shard.deviceId, shard.deviceName, identity) ?? shard.deviceId
      : shard.deviceId;
    const known = identity ? identity.knownDeviceIds.has(shard.deviceId) : false;
    for (const session of shard.sessions) {
      const existing = byId.get(session.id);
      // 已有记录时,只有「当前 shard 已知、而已存条来自未知 shard」才覆盖(current 顶掉 stale);否则保留先到。
      if (existing && !(known && !existing.known)) continue;
      byId.set(session.id, {
        session: session.canonicalDeviceId === canonicalDeviceId ? session : { ...session, canonicalDeviceId },
        physicalDeviceId: shard.deviceId,
        known,
      });
    }
  }
  // 引用调和:与上一轮 mergedSessions 逐会话浅比较,内容未变的保留旧对象引用。
  // 每次重算若无脑换新引用(尤其身份归一化分支的 {...session, canonicalDeviceId} 会给
  // 所有会话铸新对象),首页/设备详情页会话行的 memo 全部失效——一次 store 更新 =
  // 全列表重渲染;桌面端活跃期 push 高频触发重算,渲染队列滚雪球把 JS 线程打满
  // 10~90s(2026-07-18 风暴 trace 实锤,React DevTools 逐行供词:item.session
  // "referentially unequal but deeply equal, consider memoization")。
  const prevById = new Map(mergedSessions.map((s) => [s.id, s]));
  const next: RemoteSession[] = [];
  for (const { session, physicalDeviceId } of byId.values()) {
    const prev = prevById.get(session.id);
    const projected = applyPendingTitlePreview(session);
    next.push(prev && remoteSessionEqual(prev, projected) ? prev : projected);
    sessionDeviceIndex.set(session.id, physicalDeviceId);
  }
  for (const sessionId of [...sessionLiveActivity.keys()]) {
    if (!sessionDeviceIndex.has(sessionId)) sessionLiveActivity.delete(sessionId);
  }
  // 预览不因列表短暂缺席回收:旧 sessions:list 可能在远端建会话前发出、入队成功后才回来。
  // 权威标题落地、明确失败撤回、归档/删除、设备移除、clear() 才会丢掉。
  // 数组级同样调和:全部元素引用与序都未变时保留旧数组引用——useRemoteSessions 的
  // useSyncExternalStore 快照经 Object.is 即可短路,消费屏对无关 emit 零重渲染。
  mergedSessions = sameElementRefs(mergedSessions, next) ? mergedSessions : next;
  let liveRowsReanchored = false;
  for (const session of mergedSessions) {
    bindPendingHostAnchorSendAt(session.id, session.userSendAt);
    liveRowsReanchored = reanchorPendingLiveAssistantRows(
      session.id,
      session.userSendAt ?? session.updatedAt ?? session.createdAt,
      { consumePending: false },
    ) || liveRowsReanchored;
    const nextRetention = classifySessionRetention(session);
    if (nextRetention !== 'schedule' || previousRetention.get(session.id) === 'schedule') continue;
    // source 晚到后立即切断旧缓存路径。旧 hydrate / debounce 回调还会在提交前
    // 二次检查 retention；这里的串行删除负责收掉已经开始的旧写。
    clearSessionMessageCache(session.id, session.deviceLinkDeviceId);
    const current = messages.get(session.id);
    if (!current) continue;
    if (sessionMessageLifecycle.isVisible(session.id)) {
      const trimmed = trimMessageWindow(session.id, current);
      if (!remoteMessageListsEqual(current, trimmed)) {
        messages.set(session.id, trimmed);
        forgetWindowCoverage(session.id);
        bumpMessageVersion();
      }
    } else {
      sessionMessageLifecycle.leave(session.id, 'session-switch');
    }
  }
  if (liveRowsReanchored) bumpMessageVersion();
  emit();
}

/** 数组元素引用逐位相等(长度 + Object.is)。 */
function sameElementRefs<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

function stamp(session: RemoteSession, deviceId: string, deviceName: string): RemoteSession {
  return { ...session, deviceLinkDeviceId: deviceId, deviceLinkDeviceName: deviceName };
}

function dropPendingTitlePreview(sessionId: string): void {
  pendingTitlePreview.delete(sessionId);
}

function isDraftSentinelTitle(title: string | undefined): boolean {
  return !title
    || isDefaultDraftSessionTitle(title)
    || title === 'New remote session';
}

function applyPendingTitlePreview(session: RemoteSession): RemoteSession {
  const preview = pendingTitlePreview.get(session.id);
  if (!preview) return session;
  // 分片里可能已经是乐观原文(合成行),也可能仍是哨兵。只有权威标题变成
  // 另一串(智能标题 / 用户改名)才让位;不能把「分片 == 预览」当成终态丢掉。
  if (isDraftSentinelTitle(session.title) || session.title === preview) {
    return session.title === preview ? session : { ...session, title: preview };
  }
  dropPendingTitlePreview(session.id);
  return session;
}

/**
 * 老 Desktop 的 SQLite session 快照不包含 main 内存里的 pending Agent intent / runtime
 * projection。全量列表 / getSession 对账只能刷新它实际携带的字段，不能顺手抹掉已由 push /
 * 权威查询写入的运行时镜像；新 Desktop 显式携带这些字段时仍优先（包括 null）。
 */
function preserveSessionRuntimeFields(
  fresh: RemoteSession,
  local: RemoteSession | undefined,
): RemoteSession {
  if (!local) return fresh;
  let next = fresh;
  for (const key of [
    'agentSwitchIntent',
    'runtimeGeneration',
    'runtimeBaseline',
    'runtimeEffective',
    'runtimePending',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(fresh, key) && local[key] !== undefined) {
      next = { ...next, [key]: local[key] };
    }
  }
  return next;
}

function normalizeMessages(list: readonly RemoteMessage[]): RemoteMessage[] {
  return [...list].sort(compareMessageOrder);
}

function messageKey(message: RemoteMessage): string {
  return message.id || message.clientId || `${message.role}:${message.createdAt}`;
}

function rememberLivePlanSnapshot(sessionId: string, snapshot: LivePlanSnapshot): void {
  let sessionSnapshots = livePlanSnapshots.get(sessionId);
  if (!sessionSnapshots) {
    sessionSnapshots = new Map();
    livePlanSnapshots.set(sessionId, sessionSnapshots);
  }
  sessionSnapshots.set(`tool:${snapshot.toolUseId}`, snapshot);
  if (snapshot.persistId) sessionSnapshots.set(`persist:${snapshot.persistId}`, snapshot);
}

function rememberLivePlanContent(
  sessionId: string,
  toolUseId: string,
  content: Record<string, unknown>,
): void {
  const previous = livePlanSnapshots.get(sessionId)?.get(`tool:${toolUseId}`);
  rememberLivePlanSnapshot(sessionId, {
    content,
    toolUseId,
    ...(previous?.persistId ? { persistId: previous.persistId } : {}),
  });
}

function overlayLivePlanSnapshot(sessionId: string, message: RemoteMessage): RemoteMessage {
  if (message.role !== 'tool_use') return message;
  const sessionSnapshots = livePlanSnapshots.get(sessionId);
  if (!sessionSnapshots) return message;
  const contentToolUseId = readString(message.content, 'toolUseId');
  const snapshot = sessionSnapshots.get(`persist:${message.id}`)
    ?? sessionSnapshots.get(`persist:${message.clientId}`)
    ?? (message.toolUseId ? sessionSnapshots.get(`tool:${message.toolUseId}`) : undefined)
    ?? (contentToolUseId ? sessionSnapshots.get(`tool:${contentToolUseId}`) : undefined);
  return snapshot
    ? { ...message, content: snapshot.content, toolUseId: snapshot.toolUseId }
    : message;
}

function completeLivePlanSnapshotOnDone(
  sessionId: string,
  snapshot: unknown,
  turnId: string | null,
  terminalStatus: string | null,
  cancelled: boolean,
): boolean {
  if (!turnId) return false;
  const toolUseId = `plan:${turnId}`;
  const liveSnapshot = livePlanSnapshots.get(sessionId)?.get(`tool:${toolUseId}`);
  if (!liveSnapshot) return false;

  const completed = applyCodexPlanSnapshotOnDone(
    [{ role: 'tool_use', toolUseId, content: liveSnapshot.content }],
    snapshot,
    turnId,
    terminalStatus,
    undefined,
    cancelled,
  );
  const content = completed.messages[0]?.content;
  if (!completed.changed || !isRecord(content)) return false;
  rememberLivePlanContent(sessionId, toolUseId, content);
  return true;
}

/** End any pre-compaction streaming rows without changing the overall running turn. */
function finishMessageStreamingAtCompactBoundary(message: RemoteMessage): RemoteMessage {
  let agentMeta = message.agentMeta;
  let content = message.content;
  let changed = false;
  if (agentMeta?.isStreaming === true || agentMeta?.streaming === true) {
    agentMeta = { ...agentMeta, isStreaming: false, streaming: false };
    changed = true;
  }
  if (isRecord(content) && (content.isStreaming === true || content.streaming === true)) {
    content = { ...content, isStreaming: false, streaming: false };
    changed = true;
  }
  return changed ? { ...message, agentMeta, content } : message;
}

/** Apply a repeated Codex plan snapshot to the one persisted tool row used by desktop. */
interface LivePlanToolUseResult {
  handled: boolean;
  changed: boolean;
}

function applyLivePlanToolUseMessage(
  sessionId: string,
  event: Record<string, unknown>,
  persistId?: string,
): LivePlanToolUseResult {
  const data = isRecord(event.data) ? event.data : {};
  if (readString(data, 'toolName') !== 'update_plan') return { handled: false, changed: false };

  const toolUseId = readString(data, 'toolUseId');
  if (!toolUseId) return { handled: true, changed: false };
  const content = {
    toolUseId,
    toolName: 'update_plan',
    input: data.input,
  };
  rememberLivePlanSnapshot(sessionId, { content, persistId, toolUseId });
  const existing = messages.get(sessionId) ?? [];
  const targetIndex = existing.findIndex((message) => {
    if (message.role !== 'tool_use') return false;
    if (persistId && (message.id === persistId || message.clientId === persistId)) return true;
    if (message.toolUseId === toolUseId) return true;
    return readString(message.content, 'toolUseId') === toolUseId;
  });
  if (targetIndex < 0) return { handled: true, changed: false };

  const current = existing[targetIndex];
  if (current.toolUseId === toolUseId && deepValueEqual(current.content, content)) {
    return { handled: true, changed: false };
  }

  const next = [...existing];
  next[targetIndex] = { ...current, content, toolUseId };
  messages.set(sessionId, next);
  bumpMessageVersion();
  return { handled: true, changed: true };
}

/**
 * 同 key 消息合并时优先保留内容完整的一侧:被控端结果帧超限会把历史行内容截成
 * 占位串并打 agentMeta.remoteContentTruncated 标记(device-link dispatch),这种
 * 截断行不能覆盖已通过实时 push 拿到的完整内容;反向(完整行到达)照常覆盖。
 */
function preferCompleteMessage(existing: RemoteMessage | undefined, incoming: RemoteMessage): RemoteMessage {
  if (!existing) return incoming;
  const incomingTruncated = incoming.agentMeta?.remoteContentTruncated === true;
  const existingTruncated = existing.agentMeta?.remoteContentTruncated === true;
  if (!incomingTruncated || existingTruncated) return incoming;
  // Keep the complete payload, but do not throw away newer authoritative metadata
  // (for example an Agent/Task terminal state patched after the original push).
  return {
    ...existing,
    createdAt: incoming.createdAt,
    agentMeta: {
      ...(existing.agentMeta ?? {}),
      ...(incoming.agentMeta ?? {}),
      remoteContentTruncated: false,
    },
  };
}

function messageIdentityMatches(a: RemoteMessage, b: RemoteMessage): boolean {
  return Boolean(
    (a.id && b.id && a.id === b.id)
      || (a.clientId && b.clientId && a.clientId === b.clientId),
  );
}

function findMessageByIdentity(list: readonly RemoteMessage[], target: RemoteMessage): RemoteMessage | undefined {
  return list.find((item) => messageIdentityMatches(item, target));
}

function findMessageMergeKey(byKey: ReadonlyMap<string, RemoteMessage>, target: RemoteMessage): string | null {
  const directKey = messageKey(target);
  if (byKey.has(directKey)) return directKey;
  for (const [key, item] of byKey) {
    if (messageIdentityMatches(item, target)) return key;
  }
  return null;
}

/**
 * 「这一行在不在那一批里」的线性判据。`messageKey` 是常态路径;单独的 id / clientId 集合保留
 * clientId→id 迁移那一档,不必退回 O(n×m) 嵌套扫描。
 *
 * 交集探测(`messageWindowsOverlap`)与覆盖区间的事实自检(`joinableWindowCoverage`)问的是同一件
 * 事,共用这一份索引 —— 两处各写一遍迟早会在迁移档上分叉。
 */
type MessageIdentityIndex = {
  keys: Set<string>;
  ids: Set<string>;
  clientIds: Set<string>;
};

function buildMessageIdentityIndex(list: readonly RemoteMessage[]): MessageIdentityIndex {
  const index: MessageIdentityIndex = { keys: new Set(), ids: new Set(), clientIds: new Set() };
  for (const message of list) {
    index.keys.add(messageKey(message));
    if (message.id) index.ids.add(message.id);
    if (message.clientId) index.clientIds.add(message.clientId);
  }
  return index;
}

function messageIdentityIndexHas(index: MessageIdentityIndex, message: RemoteMessage): boolean {
  return index.keys.has(messageKey(message))
    || (message.id ? index.ids.has(message.id) : false)
    || (message.clientId ? index.clientIds.has(message.clientId) : false);
}

function messageWindowsOverlap(a: readonly RemoteMessage[], b: readonly RemoteMessage[]): boolean {
  const index = buildMessageIdentityIndex(a);
  return b.some((message) => messageIdentityIndexHas(index, message));
}

function streamingMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return { ...(meta ?? {}), isStreaming: true };
}

function clearStreamingMeta(meta: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!meta) return null;
  const next = { ...meta };
  delete next.isStreaming;
  delete next.streaming;
  return Object.keys(next).length > 0 ? next : null;
}

function isGeneratedStreamingClientId(clientId: string | null | undefined): boolean {
  return typeof clientId === 'string' && clientId.startsWith('mobile-stream-');
}

function rememberPendingLiveAssistantClientId(sessionId: string, clientId: string | null | undefined): void {
  if (!clientId) return;
  const existing = pendingLiveAssistantClientIds.get(sessionId) ?? new Set<string>();
  existing.add(clientId);
  pendingLiveAssistantClientIds.set(sessionId, existing);
}

function rememberPendingHostAnchorLiveAssistantClientId(
  sessionId: string,
  clientId: string | null | undefined,
  sendAt: string | null = latestUserSendAt(sessionId) ?? null,
  bindOnMetadata = true,
  deviceIds?: string | readonly string[],
  unboundRoundId?: number | null,
): void {
  if (!clientId) return;
  const existing = pendingHostAnchorLiveAssistantClientIds.get(sessionId)
    ?? new Map<string, PendingHostAnchorIdentity>();
  const nextDeviceIds = typeof deviceIds === 'string'
    ? [deviceIds]
    : deviceIds ?? [];
  if (!existing.has(clientId)) {
    let resolvedRoundId = unboundRoundId;
    if (resolvedRoundId === undefined) {
      if (sendAt !== null) {
        resolvedRoundId = null;
      } else if (sessionMakerTurnRunning.get(sessionId) === true) {
        resolvedRoundId = activePendingHostAnchorRoundIds.get(sessionId);
        if (resolvedRoundId === undefined) {
          resolvedRoundId = ++nextPendingHostAnchorRoundId;
          activePendingHostAnchorRoundIds.set(sessionId, resolvedRoundId);
        }
      } else {
        // Older producers may omit maker status boundaries. Preserve their historical
        // one-row-per-user fallback instead of grouping unrelated unbound replies.
        resolvedRoundId = ++nextPendingHostAnchorRoundId;
      }
    }
    existing.set(clientId, {
      bindOnMetadata,
      deviceIds: new Set(nextDeviceIds),
      sendAt,
      unboundRoundId: resolvedRoundId,
    });
  } else if (nextDeviceIds.length > 0) {
    const identity = existing.get(clientId);
    if (identity && nextDeviceIds.some((deviceId) => !identity.deviceIds.has(deviceId))) {
      existing.set(clientId, {
        ...identity,
        deviceIds: new Set([...identity.deviceIds, ...nextDeviceIds]),
      });
    }
  }
  pendingHostAnchorLiveAssistantClientIds.set(sessionId, existing);
}

function pendingHostAnchorIdentity(
  sessionId: string,
  ...ids: Array<string | null | undefined>
): PendingHostAnchorIdentity | undefined {
  const existing = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  if (!existing) return undefined;
  for (const id of ids) {
    if (id && existing.has(id)) return existing.get(id);
  }
  return undefined;
}

function bindPendingHostAnchorSendAt(sessionId: string, sendAt: string | null | undefined): void {
  if (!sendAt) return;
  const existing = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  if (!existing) return;
  for (const [id, identity] of existing) {
    if (identity.sendAt === null && identity.bindOnMetadata) {
      existing.set(id, { ...identity, sendAt });
    }
  }
}

function freezeUnboundPendingHostAnchorsForOffline(sessionId: string, deviceId: string): boolean {
  const existing = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  if (!existing) return false;
  let changed = false;
  for (const [id, identity] of existing) {
    if (!identity.deviceIds.has(deviceId)) continue;
    if (identity.sendAt !== null || !identity.bindOnMetadata) continue;
    existing.set(id, { ...identity, bindOnMetadata: false });
    changed = true;
  }
  return changed;
}

function hasOfflineUnboundPendingHostAnchor(sessionId: string): boolean {
  const existing = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  return existing
    ? [...existing.values()].some((identity) => (
      identity.sendAt === null && !identity.bindOnMetadata
    ))
    : false;
}

function forgetPendingLiveAssistantClientId(sessionId: string, clientId: string | null | undefined): void {
  if (!clientId) return;
  const existing = pendingLiveAssistantClientIds.get(sessionId);
  if (existing) {
    existing.delete(clientId);
    if (existing.size === 0) pendingLiveAssistantClientIds.delete(sessionId);
  }
  const pendingHostAnchorIds = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  if (pendingHostAnchorIds) {
    pendingHostAnchorIds.delete(clientId);
    if (pendingHostAnchorIds.size === 0) {
      pendingHostAnchorLiveAssistantClientIds.delete(sessionId);
    }
  }
  forgetStreamingAssistantDeviceId(sessionId, clientId);
}

function forgetPendingLiveAssistantMessageIdentity(
  sessionId: string,
  ...ids: Array<string | null | undefined>
): void {
  for (const id of ids) forgetPendingLiveAssistantClientId(sessionId, id);
}

function forgetGeneratedPendingLiveAssistantClientIds(sessionId: string): void {
  const existing = pendingLiveAssistantClientIds.get(sessionId);
  if (!existing) return;
  for (const id of [...existing]) {
    if (isGeneratedStreamingClientId(id)) forgetPendingLiveAssistantClientId(sessionId, id);
  }
}

function reanchorPendingLiveAssistantRows(
  sessionId: string,
  hostCreatedAtWatermark: string | undefined,
  options: {
    /** 快照默认只临时重锚；实时消息或已匹配最新 userSendAt 的窗口才可消费身份。 */
    consumePending?: boolean;
    /** user 行与 live 回复同戳时，明确把回复放在触发它的 user 行之后。 */
    afterMessage?: RemoteMessage;
    /** 权威窗口可一次带回多轮 user；从窗口尾部向前与 pending 回复按序一对一配对。 */
    afterMessages?: readonly RemoteMessage[];
    /** 权威窗口已覆盖到会话起点；否则最旧 user 可能已被窗口上沿截断。 */
    afterMessagesStartIsComplete?: boolean;
    /** 已知本轮发送标记时，实时 user push 也只认领最新的 pending 回复。 */
    pairPendingFromEnd?: boolean;
  } = {},
): boolean {
  if (!hostCreatedAtWatermark) return false;
  const pendingIds = pendingHostAnchorLiveAssistantClientIds.get(sessionId);
  if (!pendingIds || pendingIds.size === 0) return false;
  const existing = messages.get(sessionId);
  if (!existing) return false;
  const pendingRows: Array<{
    identity: PendingHostAnchorIdentity;
    message: RemoteMessage;
  }> = [];
  for (const [pendingId, identity] of pendingIds) {
    const match = existing.find((message) => (
      message.role === 'assistant'
      && (message.id === pendingId || message.clientId === pendingId)
    ));
    if (match && !pendingRows.some((row) => row.message === match)) {
      pendingRows.push({ message: match, identity });
    }
  }
  const afterMessages = options.afterMessages
    ?? (options.afterMessage ? [options.afterMessage] : []);
  const pairsPendingFromEnd = options.afterMessages !== undefined
    || options.pairPendingFromEnd === true;
  const latestSendAt = latestUserSendAt(sessionId);
  const knownSendAts = [...new Set([
    ...pendingRows
      .map((row) => row.identity.sendAt)
      .filter((sendAt): sendAt is string => sendAt !== null),
    ...afterMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.createdAt),
    ...(latestSendAt ? [latestSendAt] : []),
  ])].sort((left, right) => left.localeCompare(right));
  const hasOfflineUnboundPendingRow = pendingRows.some((row) => (
    row.identity.sendAt === null && !row.identity.bindOnMetadata
  ));
  const pendingRowCanPairMessage = (
    row: (typeof pendingRows)[number],
    message: RemoteMessage,
  ): boolean => {
    const rowSendAt = row.identity.sendAt;
    if (
      hasOfflineUnboundPendingRow
      && latestSendAt
      && message.createdAt.localeCompare(latestSendAt) < 0
    ) {
      return rowSendAt === null && !row.identity.bindOnMetadata;
    }
    if (rowSendAt === null && !row.identity.bindOnMetadata) {
      return Boolean(latestSendAt && message.createdAt.localeCompare(latestSendAt) < 0);
    }
    if (!rowSendAt || !latestSendAt || rowSendAt.localeCompare(latestSendAt) >= 0) return true;
    const nextSendAt = knownSendAts.find((sendAt) => sendAt.localeCompare(rowSendAt) > 0);
    return message.createdAt.localeCompare(rowSendAt) >= 0
      && (!nextSendAt || message.createdAt.localeCompare(nextSendAt) < 0);
  };
  const pairs: Array<{
    pendingRow: (typeof pendingRows)[number];
    afterMessage: RemoteMessage;
  }> = [];
  const pairsOfflineUnboundFromStart = options.afterMessages === undefined
    && afterMessages.length === 1
    && afterMessages[0].role === 'user'
    && hasOfflineUnboundPendingRow
    && Boolean(latestSendAt)
    && afterMessages[0].createdAt.localeCompare(latestSendAt ?? '') < 0;
  const offlineUnboundRoundGroups = new Map<
    number,
    Array<(typeof pendingRows)[number]>
  >();
  for (const row of pendingRows) {
    if (
      row.identity.sendAt !== null
      || row.identity.bindOnMetadata
      || row.identity.unboundRoundId === null
    ) continue;
    const group = offlineUnboundRoundGroups.get(row.identity.unboundRoundId) ?? [];
    group.push(row);
    offlineUnboundRoundGroups.set(row.identity.unboundRoundId, group);
  }
  const orderedOfflineUnboundRoundGroups = [...offlineUnboundRoundGroups]
    .sort(([leftRoundId], [rightRoundId]) => leftRoundId - rightRoundId)
    .map(([, rows]) => rows);
  const reconnectWindowUsers = afterMessages.filter((message) => (
    message.role === 'user'
    && (!latestSendAt || message.createdAt.localeCompare(latestSendAt) <= 0)
  ));
  const pairsOfflineUnboundWindowInOrder = options.afterMessages !== undefined
    && orderedOfflineUnboundRoundGroups.length > 1
    && orderedOfflineUnboundRoundGroups.reduce((count, rows) => count + rows.length, 0)
      === pendingRows.length
    && reconnectWindowUsers.length > 0;
  // A bounded latest window represents the newest user rows, so pair it with the
  // newest pending replies. Realtime pushes do the same once the latest send marker
  // is known, except delayed users restoring multiple offline-unbound rounds: those
  // must consume the oldest eligible cohort first to preserve arrival order.
  if (pairsPendingFromEnd && pairsOfflineUnboundWindowInOrder) {
    // A reconnect window can deliver several delayed users in one authoritative page.
    // Pair only when that page accounts for every offline cohort; a truncated latest
    // suffix cannot prove whether its first user belongs to the oldest pending round.
    if (
      options.afterMessagesStartIsComplete === true
      && reconnectWindowUsers.length === orderedOfflineUnboundRoundGroups.length
    ) {
      const pairedUsers = reconnectWindowUsers;
      for (let index = 0; index < orderedOfflineUnboundRoundGroups.length; index += 1) {
        for (const pendingRow of orderedOfflineUnboundRoundGroups[index]) {
          pairs.push({ pendingRow, afterMessage: pairedUsers[index] });
        }
      }
    }
  } else if (pairsPendingFromEnd && pairsOfflineUnboundFromStart) {
    const afterMessage = afterMessages[0];
    const pendingRow = pendingRows
      .filter((row) => pendingRowCanPairMessage(row, afterMessage))
      .reduce<(typeof pendingRows)[number] | undefined>((oldest, row) => {
        if (!oldest) return row;
        const oldestRoundId = oldest.identity.unboundRoundId ?? Number.MAX_SAFE_INTEGER;
        const rowRoundId = row.identity.unboundRoundId ?? Number.MAX_SAFE_INTEGER;
        return rowRoundId < oldestRoundId ? row : oldest;
      }, undefined);
    if (pendingRow) pairs.push({ pendingRow, afterMessage });
  } else if (pairsPendingFromEnd) {
    let maxRowIndex = pendingRows.length - 1;
    for (let afterIndex = afterMessages.length - 1; afterIndex >= 0 && maxRowIndex >= 0; afterIndex -= 1) {
      let matchedRowIndex = -1;
      for (let rowIndex = maxRowIndex; rowIndex >= 0; rowIndex -= 1) {
        if (pendingRowCanPairMessage(pendingRows[rowIndex], afterMessages[afterIndex])) {
          matchedRowIndex = rowIndex;
          break;
        }
      }
      if (matchedRowIndex < 0) continue;
      pairs.unshift({
        pendingRow: pendingRows[matchedRowIndex],
        afterMessage: afterMessages[afterIndex],
      });
      maxRowIndex = matchedRowIndex - 1;
    }
  } else {
    const pairCount = Math.min(pendingRows.length, afterMessages.length);
    for (let index = 0; index < pairCount; index += 1) {
      pairs.push({ pendingRow: pendingRows[index], afterMessage: afterMessages[index] });
    }
  }
  // A single realtime/latest-window user row identifies one send round. All live
  // assistant blocks carrying that non-null send marker belong after the same user;
  // move them as one ordered block instead of consuming only the last block.
  if (afterMessages.length === 1 && pairs.length === 1) {
    const groupedIdentity = pairs[0].pendingRow.identity;
    if (groupedIdentity.unboundRoundId !== null || groupedIdentity.sendAt !== null) {
      const afterMessage = afterMessages[0];
      const groupedRows = pendingRows.filter((row) => (
        (groupedIdentity.unboundRoundId !== null
          ? row.identity.unboundRoundId === groupedIdentity.unboundRoundId
          : row.identity.sendAt === groupedIdentity.sendAt)
        && pendingRowCanPairMessage(row, afterMessage)
      ));
      pairs.splice(0, pairs.length, ...groupedRows.map((pendingRow) => ({
        pendingRow,
        afterMessage,
      })));
    }
  }
  const pairedCreatedAtById = new Map<string, string>();
  for (const pair of pairs) {
    const pendingRow = pair.pendingRow.message;
    const createdAt = pair.afterMessage.createdAt;
    pairedCreatedAtById.set(pendingRow.id, createdAt);
    pairedCreatedAtById.set(pendingRow.clientId, createdAt);
  }
  const reanchored = existing.map((message) => {
    if (
      message.role !== 'assistant'
      || (!pendingIds.has(message.id) && !pendingIds.has(message.clientId))
    ) return message;
    const pairedCreatedAt = pairedCreatedAtById.get(message.id)
      ?? pairedCreatedAtById.get(message.clientId);
    if (pairsPendingFromEnd && pairedCreatedAt === undefined) return message;
    const pendingIdentity = pendingHostAnchorIdentity(sessionId, message.id, message.clientId);
    if (
      pairedCreatedAt === undefined
      && pendingIdentity?.sendAt === null
      && !pendingIdentity.bindOnMetadata
    ) return message;
    if (
      pairedCreatedAt === undefined
      && pendingIdentity?.sendAt
      && latestSendAt
      && pendingIdentity.sendAt.localeCompare(latestSendAt) < 0
      && hostCreatedAtWatermark.localeCompare(latestSendAt) >= 0
    ) return message;
    const createdAt = pairedCreatedAt ?? hostCreatedAtWatermark;
    return message.createdAt === createdAt ? message : { ...message, createdAt };
  });
  let next = normalizeMessages(reanchored);
  const pairGroups: Array<{
    afterMessage: RemoteMessage;
    pendingRows: Array<(typeof pendingRows)[number]>;
  }> = [];
  for (const pair of pairs) {
    const group = pairGroups.find((candidate) => (
      messageIdentityMatches(candidate.afterMessage, pair.afterMessage)
    ));
    if (group) group.pendingRows.push(pair.pendingRow);
    else pairGroups.push({ afterMessage: pair.afterMessage, pendingRows: [pair.pendingRow] });
  }
  const consumedPendingRows: RemoteMessage[] = [];
  for (const group of pairGroups) {
    const groupedRows = next.filter((message) => group.pendingRows.some((row) => (
      messageIdentityMatches(message, row.message)
    )));
    if (groupedRows.length === 0) continue;
    const withoutPending = next.filter((message) => !group.pendingRows.some((row) => (
      messageIdentityMatches(message, row.message)
    )));
    const anchorIndex = withoutPending.findIndex((message) => (
      messageIdentityMatches(message, group.afterMessage)
    ));
    if (anchorIndex < 0) continue;
    next = [
      ...withoutPending.slice(0, anchorIndex + 1),
      ...groupedRows,
      ...withoutPending.slice(anchorIndex + 1),
    ];
    consumedPendingRows.push(...groupedRows);
  }
  if (options.consumePending !== false) {
    if (afterMessages.length > 0) {
      for (const pendingRow of consumedPendingRows) {
        pendingIds.delete(pendingRow.id);
        pendingIds.delete(pendingRow.clientId);
      }
      if (pendingIds.size === 0) {
        pendingHostAnchorLiveAssistantClientIds.delete(sessionId);
      }
    } else {
      pendingHostAnchorLiveAssistantClientIds.delete(sessionId);
    }
  }
  if (remoteMessageListsEqual(existing, next)) return false;
  messages.set(sessionId, next);
  return true;
}

function retireGeneratedStreamingFallback(sessionId: string): void {
  const current = streamingAssistantClientIds.get(sessionId);
  if (isGeneratedStreamingClientId(current)) streamingAssistantClientIds.delete(sessionId);
  forgetGeneratedPendingLiveAssistantClientIds(sessionId);
}

function isPersistedAssistantMessage(message: RemoteMessage): boolean {
  return message.role === 'assistant'
    && message.agentMeta?.isStreaming !== true
    && !isGeneratedStreamingClientId(message.id)
    && !isGeneratedStreamingClientId(message.clientId)
    && Boolean(message.id || message.clientId);
}

function findPendingGeneratedStreamingFallbackIndex(
  sessionId: string,
  existing: readonly RemoteMessage[],
): number {
  const pendingIds = pendingLiveAssistantClientIds.get(sessionId);
  if (!pendingIds || pendingIds.size === 0) return -1;
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const message = existing[index];
    if (
      message.role === 'assistant'
      && isGeneratedStreamingClientId(message.id)
      && pendingIds.has(message.id)
    ) {
      return index;
    }
    if (
      message.role === 'assistant'
      && isGeneratedStreamingClientId(message.clientId)
      && pendingIds.has(message.clientId)
    ) {
      return index;
    }
  }
  return -1;
}

function generatedFallbackMatchesPersistedMessage(
  fallback: RemoteMessage,
  persisted: RemoteMessage,
): boolean {
  const liveText = contentToPreview(fallback.content);
  const persistedText = contentToPreview(persisted.content);
  if (!liveText || !persistedText) return false;
  // A short common prefix is not enough evidence: a delayed row from an older
  // assistant block can easily start with the same token (for example `Sure`).
  // Only let a persisted row retire a generated fallback when the DB row is an
  // authoritative continuation with enough accumulated text to make the prefix
  // unambiguous. Never replace a longer live row with a shorter persisted prefix.
  return liveText.length >= GENERATED_FALLBACK_MIN_PREFIX_LENGTH
    && persistedText.startsWith(liveText);
}

interface StreamingClientIdResolution {
  clientId: string;
  changed: boolean;
}

function migrateGeneratedStreamingClientId(sessionId: string, generatedClientId: string, persistId: string): boolean {
  streamingAssistantClientIds.set(sessionId, persistId);

  const hadPendingLiveId = pendingLiveAssistantClientIds.get(sessionId)?.has(generatedClientId) === true;
  const streamingDeviceId = streamingAssistantDeviceId(sessionId, generatedClientId);
  const neededHostAnchor = pendingHostAnchorLiveAssistantClientIds
    .get(sessionId)
    ?.has(generatedClientId) === true;
  const hostAnchorIdentity = pendingHostAnchorIdentity(sessionId, generatedClientId);
  forgetPendingLiveAssistantClientId(sessionId, generatedClientId);
  if (hadPendingLiveId) rememberPendingLiveAssistantClientId(sessionId, persistId);
  if (streamingDeviceId) {
    rememberStreamingAssistantDeviceId(sessionId, persistId, streamingDeviceId);
  }
  if (neededHostAnchor && hostAnchorIdentity) {
    rememberPendingHostAnchorLiveAssistantClientId(
      sessionId,
      persistId,
      hostAnchorIdentity.sendAt,
      hostAnchorIdentity.bindOnMetadata,
      [...hostAnchorIdentity.deviceIds],
      hostAnchorIdentity.unboundRoundId,
    );
  }

  const existing = messages.get(sessionId);
  if (!existing) return false;
  const generatedIndex = existing.findIndex((message) => (
    message.role === 'assistant'
      && (message.id === generatedClientId || message.clientId === generatedClientId)
  ));
  if (generatedIndex < 0) return false;

  const migrated = {
    ...existing[generatedIndex],
    id: existing[generatedIndex].id === generatedClientId ? persistId : existing[generatedIndex].id,
    clientId: persistId,
  };
  const targetIndex = existing.findIndex((message, index) => (
    index !== generatedIndex && messageIdentityMatches(message, migrated)
  ));
  const next = existing.slice();
  if (targetIndex >= 0) next.splice(generatedIndex, 1);
  else next[generatedIndex] = migrated;
  messages.set(sessionId, normalizeMessages(next));
  bumpMessageVersion();
  return true;
}

function streamingClientIdFor(sessionId: string, persistId: string | undefined): StreamingClientIdResolution {
  const normalizedPersistId = persistId?.trim();
  if (normalizedPersistId) {
    const existing = streamingAssistantClientIds.get(sessionId);
    if (existing && isGeneratedStreamingClientId(existing)) {
      return {
        clientId: normalizedPersistId,
        changed: migrateGeneratedStreamingClientId(sessionId, existing, normalizedPersistId),
      };
    }
    streamingAssistantClientIds.set(sessionId, normalizedPersistId);
    return { clientId: normalizedPersistId, changed: false };
  }
  const existing = streamingAssistantClientIds.get(sessionId);
  if (existing) return { clientId: existing, changed: false };
  const generated = `mobile-stream-${++streamingFallbackSequence}`;
  streamingAssistantClientIds.set(sessionId, generated);
  return { clientId: generated, changed: false };
}

function upsertMessage(
  sessionId: string,
  message: RemoteMessage,
  options: { retirePendingAssistantIdentityOnEqual?: boolean } = {},
): boolean {
  const existing = messages.get(sessionId) ?? [];
  const index = existing.findIndex((item) => messageIdentityMatches(item, message));
  let fallbackIndex = -1;
  if (index < 0 && isPersistedAssistantMessage(message)) {
    fallbackIndex = findPendingGeneratedStreamingFallbackIndex(sessionId, existing);
    if (
      fallbackIndex >= 0
      && generatedFallbackMatchesPersistedMessage(existing[fallbackIndex], message)
    ) {
      // A producer without persistId creates a temporary mobile-stream-* row. The
      // matching DB create is authoritative even though its id cannot match that row.
      const next = existing.slice();
      next[fallbackIndex] = message;
      messages.set(sessionId, normalizeMessages(next));
      applyMessageWriteRetention(sessionId);
      retireGeneratedStreamingFallback(sessionId);
      bumpMessageVersion();
      return true;
    }
  }
  if (index < 0) {
    messages.set(sessionId, normalizeMessages([...existing, message]));
    applyMessageWriteRetention(sessionId);
    if (isPersistedAssistantMessage(message) && fallbackIndex < 0) {
      retireGeneratedStreamingFallback(sessionId);
    }
    bumpMessageVersion();
    return true;
  }
  const replacement = preferCompleteMessage(existing[index], message);
  if (remoteMessageEqual(existing[index], replacement)) {
    if (
      message.role !== 'assistant'
      || options.retirePendingAssistantIdentityOnEqual !== true
    ) return false;
    const hadPendingIdentity = isPendingLiveAssistantMessage(sessionId, existing[index])
      || pendingHostAnchorIdentity(
        sessionId,
        existing[index].id,
        existing[index].clientId,
        message.id,
        message.clientId,
      ) !== undefined;
    forgetPendingLiveAssistantMessageIdentity(
      sessionId,
      existing[index].id,
      existing[index].clientId,
      message.id,
      message.clientId,
    );
    if (isPersistedAssistantMessage(message)) retireGeneratedStreamingFallback(sessionId);
    return hadPendingIdentity;
  }
  const next = existing.slice();
  next[index] = replacement;
  messages.set(sessionId, normalizeMessages(next));
  applyMessageWriteRetention(sessionId);
  if (message.role === 'assistant') {
    forgetPendingLiveAssistantMessageIdentity(
      sessionId,
      existing[index]?.id,
      existing[index]?.clientId,
      message.id,
      message.clientId,
    );
    if (isPersistedAssistantMessage(message)) retireGeneratedStreamingFallback(sessionId);
  }
  bumpMessageVersion();
  return true;
}

function applyRemoteTextEvent(
  sessionId: string,
  event: Record<string, unknown>,
  persistId?: string,
  deviceId?: string,
): boolean {
  const data = isRecord(event.data) ? event.data : null;
  const text = typeof data?.text === 'string' ? data.text : '';
  const isFinal = data?.isFinal === true;
  if (!text) return false;

  const authoritativeDeviceId = authoritativeSessionDeviceId(sessionId);
  const currentMessages = messages.get(sessionId) ?? [];
  const hasAuthoritativePendingAssembly = authoritativeDeviceId !== undefined
    && [...(streamingAssistantDeviceIds.get(sessionId) ?? [])].some(([ownedClientId, ownerDeviceId]) => {
      if (ownerDeviceId !== authoritativeDeviceId) return false;
      const ownedMessage = currentMessages.find((message) => (
        message.id === ownedClientId || message.clientId === ownedClientId
      ));
      if (!ownedMessage || !isPendingLiveAssistantMessage(sessionId, ownedMessage)) return false;
      const ownedHostAnchorIdentity = pendingHostAnchorIdentity(
        sessionId,
        ownedMessage.id,
        ownedMessage.clientId,
        ownedClientId,
      );
      return !(
        ownedHostAnchorIdentity?.bindOnMetadata === false
        && ownedHostAnchorIdentity.deviceIds.has(ownerDeviceId)
      );
    });
  const rejectsBeforeClientIdMutation = deviceId !== undefined
    && authoritativeDeviceId !== undefined
    && deviceId !== authoritativeDeviceId
    && hasAuthoritativePendingAssembly;
  if (rejectsBeforeClientIdMutation) return false;

  const clientIdResolution = streamingClientIdFor(sessionId, persistId);
  const { clientId } = clientIdResolution;
  const previousStreamingDeviceId = streamingAssistantDeviceId(sessionId, clientId);
  const matchedExisting = messages.get(sessionId)?.find((message) => message.clientId === clientId);
  const matchedHostAnchorIdentity = matchedExisting
    ? pendingHostAnchorIdentity(
        sessionId,
        matchedExisting.id,
        matchedExisting.clientId,
        clientId,
      )
    : undefined;
  const previousTransportWasSoftOffline = previousStreamingDeviceId !== undefined
    && matchedHostAnchorIdentity?.bindOnMetadata === false
    && matchedHostAnchorIdentity.deviceIds.has(previousStreamingDeviceId);
  const matchedExistingIsPending = matchedExisting !== undefined
    && isPendingLiveAssistantMessage(sessionId, matchedExisting);
  const matchedExistingIsPersisted = matchedExisting !== undefined
    && !matchedExistingIsPending
    && isPersistedAssistantMessage(matchedExisting);
  const rejectsNonAuthoritativeTransportReplay = deviceId !== undefined
    && authoritativeDeviceId !== undefined
    && deviceId !== authoritativeDeviceId
    && (
      matchedExistingIsPersisted
      || (
        previousStreamingDeviceId !== undefined
        && previousStreamingDeviceId !== deviceId
        && previousStreamingDeviceId === authoritativeDeviceId
        && !previousTransportWasSoftOffline
        && matchedExistingIsPending
      )
    );
  if (rejectsNonAuthoritativeTransportReplay) return clientIdResolution.changed;
  const resetsTransportAssembly = previousStreamingDeviceId !== undefined
    && deviceId !== undefined
    && previousStreamingDeviceId !== deviceId
    && matchedExisting !== undefined
    && isPendingLiveAssistantMessage(sessionId, matchedExisting);
  const resetHostAnchorIdentity = resetsTransportAssembly
    ? pendingHostAnchorIdentity(
        sessionId,
        matchedExisting.id,
        matchedExisting.clientId,
        clientId,
      )
    : undefined;
  const existing = resetsTransportAssembly ? undefined : matchedExisting;
  const finalTextWasTruncated = isFinal && (
    hasDeviceLinkTruncationMarker(event) || hasDeviceLinkTruncationMarker(data)
  );
  if (isFinal && !existing) {
    // Device-clock stamp on a brand-new live row: anchor it to the newest known message,
    // or to host-domain session activity when the message window is still empty. Otherwise
    // an ahead device clock can dominate the first later host-persisted row.
    const hostCreatedAtAnchor = liveRowCreatedAtAnchor(sessionId);
    const createdAt = clampLiveRowCreatedAt(
      new Date().toISOString(),
      hostCreatedAtAnchor.createdAt,
    );
    const changed = upsertMessage(sessionId, {
      id: clientId,
      clientId,
      sessionId,
      role: 'assistant',
      content: text,
      toolUseId: null,
      agentMeta: isRecord(event.agentMeta) ? event.agentMeta : null,
      createdAt,
    });
    if (resetsTransportAssembly && !changed) {
      forgetPendingLiveAssistantMessageIdentity(
        sessionId,
        matchedExisting.id,
        matchedExisting.clientId,
        clientId,
      );
    }
    if (changed || resetsTransportAssembly) {
      rememberPendingLiveAssistantClientId(sessionId, clientId);
      if (hostCreatedAtAnchor.provisional || resetHostAnchorIdentity) {
        rememberPendingHostAnchorLiveAssistantClientId(
          sessionId,
          clientId,
          resetHostAnchorIdentity?.sendAt,
          resetHostAnchorIdentity?.bindOnMetadata ?? true,
          deviceId,
          resetHostAnchorIdentity?.unboundRoundId,
        );
      }
    }
    if (
      deviceId !== undefined
      && pendingLiveAssistantClientIds.get(sessionId)?.has(clientId) === true
    ) {
      rememberStreamingAssistantDeviceId(sessionId, clientId, deviceId);
    }
    return changed || clientIdResolution.changed;
  }

  const currentText = existing ? contentToPreview(existing.content) : '';
  const nextText = isFinal
    ? (finalTextWasTruncated && existing
      ? currentText
      : existing && currentText
        ? (text.startsWith(currentText)
          ? text
          : currentText.startsWith(text)
            ? currentText
            : `${currentText}${text}`)
        : text)
    : currentText + text;
  const nextMeta = isFinal
    ? (isRecord(event.agentMeta)
      ? { ...(existing?.agentMeta ?? {}), ...event.agentMeta }
      : existing?.agentMeta ?? null)
    : streamingMeta(isRecord(event.agentMeta)
      ? { ...(existing?.agentMeta ?? {}), ...event.agentMeta }
      : existing?.agentMeta);
  const hostCreatedAtAnchor = existing ? undefined : liveRowCreatedAtAnchor(sessionId);
  const needsHostAnchor = existing
    ? [existing.id, existing.clientId, clientId].some((id) => (
      Boolean(id) && pendingHostAnchorLiveAssistantClientIds.get(sessionId)?.has(id) === true
    ))
    : hostCreatedAtAnchor?.provisional === true || resetHostAnchorIdentity !== undefined;
  const hostAnchorIdentity = existing
    ? pendingHostAnchorIdentity(sessionId, existing.id, existing.clientId, clientId)
    : resetHostAnchorIdentity;
  const changed = upsertMessage(sessionId, {
    id: existing?.id ?? clientId,
    clientId,
    sessionId,
    role: 'assistant',
    content: nextText,
    toolUseId: null,
    agentMeta: nextMeta,
    // Existing rows keep their already-stamped createdAt unchanged (it may already be a
    // clamped value from the first delta). Only a brand-new row's fresh device-clock stamp
    // needs the clamp — see clampLiveRowCreatedAt doc comment in messagePaging.ts.
    createdAt: existing?.createdAt ?? clampLiveRowCreatedAt(
      new Date().toISOString(),
      hostCreatedAtAnchor?.createdAt,
    ),
  });
  if (resetsTransportAssembly && !changed) {
    forgetPendingLiveAssistantMessageIdentity(
      sessionId,
      matchedExisting.id,
      matchedExisting.clientId,
      clientId,
    );
  }
  if (changed || resetsTransportAssembly) {
    rememberPendingLiveAssistantClientId(sessionId, clientId);
  }
  // upsertMessage intentionally clears pending reconciliation identities when it
  // replaces an assistant row. A live delta/final is not host-authoritative, so
  // carry the provisional anchor forward until metadata or a persisted row lands.
  // Even an unchanged replay can add a second transport owner for the same identity.
  if (needsHostAnchor) {
    rememberPendingHostAnchorLiveAssistantClientId(
      sessionId,
      clientId,
      hostAnchorIdentity?.sendAt ?? latestUserSendAt(sessionId) ?? null,
      hostAnchorIdentity?.bindOnMetadata ?? true,
      deviceId,
      hostAnchorIdentity?.unboundRoundId,
    );
  }
  if (
    deviceId !== undefined
    && pendingLiveAssistantClientIds.get(sessionId)?.has(clientId) === true
  ) {
    rememberStreamingAssistantDeviceId(sessionId, clientId, deviceId);
  }
  return changed || clientIdResolution.changed;
}

function isRemoteTextDeltaEvent(event: Record<string, unknown>): boolean {
  if (readString(event, 'type') !== 'text') return false;
  const data = isRecord(event.data) ? event.data : null;
  return typeof data?.text === 'string' && data.text.length > 0 && data.isFinal === false;
}

function enqueueRemoteTextDelta(
  sessionId: string,
  event: Record<string, unknown>,
  persistId?: string,
  deviceId?: string,
): boolean {
  const data = isRecord(event.data) ? event.data : null;
  const text = typeof data?.text === 'string' ? data.text : '';
  if (!text) return false;

  let changed = false;
  const existing = pendingTextDeltaBatches.get(sessionId);
  if (
    existing
    && (
      (existing.persistId && persistId && existing.persistId !== persistId)
      || existing.deviceId !== deviceId
    )
  ) {
    changed = flushPendingTextDelta(sessionId);
  }
  const current = pendingTextDeltaBatches.get(sessionId);
  const incomingMeta = isRecord(event.agentMeta) ? event.agentMeta : null;
  pendingTextDeltaBatches.set(sessionId, {
    text: `${current?.text ?? ''}${text}`,
    persistId: current?.persistId ?? persistId,
    deviceId: current?.deviceId ?? deviceId,
    agentMeta: incomingMeta
      ? { ...(current?.agentMeta ?? {}), ...incomingMeta }
      : current?.agentMeta ?? null,
  });
  scheduleTextDeltaFlush();
  return changed;
}

function flushPendingTextDelta(sessionId: string): boolean {
  const batch = pendingTextDeltaBatches.get(sessionId);
  if (!batch) return false;
  pendingTextDeltaBatches.delete(sessionId);
  if (pendingTextDeltaBatches.size === 0) clearTextDeltaFlushTimer();
  return applyRemoteTextEvent(
    sessionId,
    {
      type: 'text',
      data: { text: batch.text, isFinal: false },
      ...(batch.agentMeta ? { agentMeta: batch.agentMeta } : {}),
    },
    batch.persistId,
    batch.deviceId,
  );
}

function flushAndFinalizeRemoteStreamingMessages(
  sessionId: string,
  boundaryAgentMeta?: Record<string, unknown> | null,
): boolean {
  let changed = flushPendingTextDelta(sessionId);
  changed = finalizeRemoteStreamingMessages(sessionId, boundaryAgentMeta) || changed;
  return changed;
}

function hasLiveAssistantMessage(sessionId: string): boolean {
  return (messages.get(sessionId) ?? []).some((message) => (
    isPendingLiveAssistantMessage(sessionId, message)
  ));
}

function isPendingLiveAssistantMessage(
  sessionId: string,
  message: RemoteMessage,
): boolean {
  const pendingLiveIds = pendingLiveAssistantClientIds.get(sessionId);
  return message.role === 'assistant'
    && pendingLiveIds !== undefined
    && (pendingLiveIds.has(message.clientId) || pendingLiveIds.has(message.id));
}

function flushPendingTextDeltas(): void {
  let changed = false;
  for (const sessionId of [...pendingTextDeltaBatches.keys()]) {
    changed = flushPendingTextDelta(sessionId) || changed;
  }
  if (changed) emit();
}

function scheduleTextDeltaFlush(): void {
  if (textDeltaFlushTimer !== null) return;
  textDeltaFlushTimer = setTimeout(() => {
    textDeltaFlushTimer = null;
    flushPendingTextDeltas();
  }, TEXT_DELTA_BATCH_INTERVAL_MS);
}

function clearTextDeltaFlushTimer(): void {
  if (textDeltaFlushTimer === null) return;
  clearTimeout(textDeltaFlushTimer);
  textDeltaFlushTimer = null;
}

function discardPendingTextDelta(sessionId: string): void {
  pendingTextDeltaBatches.delete(sessionId);
  if (pendingTextDeltaBatches.size === 0) clearTextDeltaFlushTimer();
}

function finalizeRemoteStreamingMessages(
  sessionId: string,
  boundaryAgentMeta?: Record<string, unknown> | null,
): boolean {
  clearStreamingAssistantPointer(sessionId);
  const existing = messages.get(sessionId);
  if (!existing) return false;
  let changed = false;
  const next = existing.map((message) => {
    if (message.role !== 'assistant' || message.agentMeta?.isStreaming !== true) return message;
    changed = true;
    // Match desktop persistence semantics: metadata already observed on the
    // streaming block wins, while metadata carried only by the boundary event
    // fills missing fields (parentUuid/uuid are needed for rewind/fork).
    const mergedMeta = boundaryAgentMeta
      ? { ...boundaryAgentMeta, ...(message.agentMeta ?? {}) }
      : message.agentMeta;
    return { ...message, agentMeta: clearStreamingMeta(mergedMeta) };
  });
  if (!changed) return false;
  messages.set(sessionId, next);
  bumpMessageVersion();
  return true;
}

function bumpMessageVersion(): void {
  messageVersion += 1;
}

// turn start 时暂存的 running codex collab worker 条目:map key → update。核心不变量是
// 「孤儿卡只渲染当前 maker turn 边界打开之后到达的 update(post-boundary evidence)」——
// 错过终态推送的 stale running 与活 worker 在数据上不可区分,任何按新鲜度/宽限的近似都
// 留有重放窗口。暂存条目不出现在 getSessionTaskUpdates(不渲染、inline 也不吃,inline 卡
// 状态由持久化的 tool_use/tool_result 自行推断);边界后收到同任务的新 update 即被召回参
// 与 merge(保住 title/description 等历史字段);到下一次 turn start 仍未被召回的直接丢弃
// (跨两个边界无任何存活证据)。live-only,随 removeDevice / clear 一起清。
const sessionParkedTaskUpdates = new Map<string, Map<string, AgentTaskUpdate>>();

// maker turn 边界 false→true 时的清扫:每个 turn 的 live task 状态从零开始。claude
// Task/Agent 子代理不跨 turn,残留即 stale,直接清;终态条目的 spawn tool_use / tool_result
// 已持久化,inline 渲染可接管,直接清;running codex collab worker(跑在独立会话、跨 turn
// 存活,update 推到主会话事件流——codex 的 agent_task_update 只由 collab:* 工具产生,见
// codex translator 的 handleCollabAgentToolCall)挪进暂存区等待 post-boundary 存活证据,
// 活 worker 的下一条 update 会立即召回它,卡片仅在边界到该条 update 之间短暂缺席。
function sweepStaleTaskUpdates(sessionId: string): boolean {
  // 上一轮暂存的条目到此作废:跨两个边界都没有等到任何新 update,判死。
  sessionParkedTaskUpdates.delete(sessionId);
  const map = sessionTaskUpdates.get(sessionId);
  if (!map || map.size === 0) return false;
  const parked = new Map<string, AgentTaskUpdate>();
  for (const [key, update] of map) {
    if (update.provider === 'codex' && update.status === 'running') parked.set(key, update);
  }
  if (parked.size > 0) sessionParkedTaskUpdates.set(sessionId, parked);
  sessionTaskUpdates.delete(sessionId);
  return true;
}

// 暂存召回:边界后到达的 update 是同任务仍存活的证据。把暂存里按 alias 匹配的历史条目
// 取回并入 prevMap,让 applyAgentTaskUpdateEvent 的 merge 吃到历史字段;未匹配的留在暂存。
function recallParkedTaskUpdates(
  sessionId: string,
  data: unknown,
  source: 'claude-code' | 'codex' | 'pi' | undefined,
  prevMap: ReadonlyMap<string, AgentTaskUpdate> | undefined,
): ReadonlyMap<string, AgentTaskUpdate> | undefined {
  const parkedMap = sessionParkedTaskUpdates.get(sessionId);
  if (!parkedMap || parkedMap.size === 0) return prevMap;
  const probe = normalizeAgentTaskUpdate(data, source);
  if (!probe) return prevMap;
  let recalled: Map<string, AgentTaskUpdate> | null = null;
  for (const [key, parked] of parkedMap) {
    if (!isSameAgentTaskAlias(parked, probe)) continue;
    if (!recalled) recalled = new Map(prevMap ?? []);
    recalled.set(key, parked);
    parkedMap.delete(key);
  }
  if (parkedMap.size === 0) sessionParkedTaskUpdates.delete(sessionId);
  return recalled ?? prevMap;
}

export const remoteSessionStore = {
  /**
   * 新建任务第一帧标题预览。只盖哨兵,权威标题一旦离开哨兵就让位。
   * 失败撤回走 {@link clearPendingTitlePreview}。
   */
  setPendingTitlePreview(sessionId: string, title: string): void {
    const next = title.trim();
    if (!sessionId || !next) return;
    if (pendingTitlePreview.get(sessionId) === next) return;
    pendingTitlePreview.set(sessionId, next);
    recomputeSessions();
  },

  clearPendingTitlePreview(sessionId: string): void {
    if (!sessionId || !pendingTitlePreview.has(sessionId)) return;
    dropPendingTitlePreview(sessionId);
    recomputeSessions();
  },

  /**
   * 读当前权威设备身份列表(setDeviceIdentity 注入的那份;未注入过为空)。
   * 会话页抽屉等在首页之外调 buildMobileHomePresentation 时传入,保证展示归一化
   * (canonicalDeviceId 认领)与首页/本 store 同一口径——不传 devices 的空列表会把
   * store 已算好的规范 id 覆盖成仅凭会话内嵌名字推出的弱结果(re-link 后路由错设备)。
   */
  getDeviceIdentity(): readonly { deviceId: string; name: string }[] {
    return deviceList ?? [];
  },

  getConversationSearchDeviceModels(): readonly {
    canOpen: boolean;
    deviceId: string;
    name: string | null;
    state: string;
  }[] {
    return conversationSearchDeviceModels;
  },

  setConversationSearchDeviceModels(models: readonly {
    canOpen: boolean;
    deviceId: string;
    name: string | null;
    state: string;
  }[]): void {
    if (conversationSearchDeviceModelsEqual(conversationSearchDeviceModels, models)) return;
    conversationSearchDeviceModels = models.map((item) => ({
      canOpen: item.canOpen,
      deviceId: item.deviceId,
      name: item.name,
      state: item.state,
    }));
    emit();
  },

  getSessionRetention(sessionId: string): SessionRetentionKind {
    return retentionForSession(sessionId);
  },

  enterSessionMessageDetail(sessionId: string): SessionMessageAuthority {
    const authority = sessionMessageLifecycle.enter(sessionId);
    touchSessionAccess(sessionId);
    if (enforceRegularMessageBudget()) {
      bumpMessageVersion();
      emit();
    }
    return authority;
  },

  leaveSessionMessageDetail(
    sessionId: string,
    reason: SessionMessageReclaimReason,
    authority?: SessionMessageAuthority | null,
  ): boolean {
    const left = sessionMessageLifecycle.leave(sessionId, reason, authority);
    if (left) {
      noteLiveStreamInterrupted(sessionId);
      discardPendingTextDelta(sessionId);
    }
    return left;
  },

  /**
   * rewind 等远端权威改写后，目标详情已不再拥有可证明正确的连续窗口。
   * 清内存与磁盘预览并登记一次刷新；页面可见时立即 load，隐藏时下次打开再拉。
   */
  invalidateSessionMessageWindow(sessionId: string, deviceId?: string): void {
    const changed = invalidateSessionMessageWindowState(sessionId, true);
    clearSessionMessageCache(sessionId, deviceId);
    if (changed) {
      bumpMessageVersion();
      emit();
    }
  },

  captureSessionMessageAuthority(sessionId: string): SessionMessageAuthority {
    return sessionMessageLifecycle.capture(sessionId);
  },

  isSessionMessageAuthorityCurrent(authority: SessionMessageAuthority): boolean {
    return sessionMessageLifecycle.canCommit(authority);
  },

  isSessionMessageDetailVisible(sessionId: string): boolean {
    return sessionMessageLifecycle.isVisible(sessionId);
  },

  hasSessionMessageDetailEntered(sessionId: string): boolean {
    return sessionMessageLifecycle.hasEntered(sessionId);
  },

  captureUnenteredSessionMessageAuthority(sessionId: string): SessionMessageUnenteredAuthority {
    return sessionMessageLifecycle.captureUnentered(sessionId);
  },

  canCommitUnenteredSessionMessageWindow(
    authority: SessionMessageUnenteredAuthority,
    deviceId: string,
  ): boolean {
    return retentionForSession(authority.sessionId) === 'regular'
      && sessionDeviceIndex.get(authority.sessionId) === deviceId
      && sessionMessageLifecycle.canCommitUnentered(authority);
  },

  acquireSessionMessageWork(sessionId: string, active = false): SessionMessageWorkLease {
    return sessionMessageLifecycle.acquireWork(sessionId, active);
  },

  releaseSessionRuntimeState(
    sessionId: string,
    options: { reason: SessionMessageReclaimReason },
  ): boolean {
    if (!sessionId || sessionMessageLifecycle.isVisible(sessionId)) return true;
    if (sessionStoreProtected(sessionId, false)) return false;
    if (retentionForSession(sessionId) === 'schedule') {
      const changed = reclaimScheduleRuntimeMaps(sessionId);
      clearSessionMessageCache(sessionId);
      if (changed) {
        bumpMessageVersion();
        emit();
      }
      return true;
    }

    const current = messages.get(sessionId);
    let changed = releaseSessionDetailProjections(sessionId);
    if (current && current.length > MESSAGE_PAGE_SIZE) {
      const compacted = trimMessageWindow(sessionId, current);
      if (!remoteMessageListsEqual(current, compacted)) {
        messages.set(sessionId, compacted);
        forgetWindowCoverage(sessionId);
        changed = true;
      }
    }
    changed = enforceRegularMessageBudget() || changed;
    if (changed) {
      bumpMessageVersion();
      emit();
    }
    void options.reason;
    return true;
  },

  // 注入当前权威设备列表(首页从 /api/device-link/devices reconcile 后调用),用于设备身份归一化。
  // 仅在身份索引实际变化时重算,避免每次设备列表引用变动都刷新全部会话。
  setDeviceIdentity(devices: readonly { deviceId: string; name: string }[]): void {
    if (deviceListsEqual(deviceList, devices)) return;
    deviceList = devices.map((d) => ({ deviceId: d.deviceId, name: d.name }));
    recomputeSessions();
  },

  setDeviceSessions(deviceId: string, deviceName: string, rawSessions: readonly RemoteSession[]): void {
    let nextSessions = rawSessions.map((s) => stamp(s, deviceId, deviceName));
    const existing = shards.get(deviceId);
    if (existing) {
      const localById = new Map(existing.sessions.map((session) => [session.id, session]));
      nextSessions = nextSessions.map((session) => preserveSessionRuntimeFields(
        session,
        localById.get(session.id),
      ));
    }
    // 在途乐观创建行保护:pendingLocalCreation 行由 newSessionCreation 管线负责生命
    // 周期(enqueue 落定清标 / 失败撤行),全量列表对账不能越权处置——(a) 比被控端
    // 建成更早发出的旧列表不含该 id,直接替换会让刚进入的会话从列表消失;(b) 建成后
    // enqueue 落定前的新列表含该 id 但无标,直接替换会提前解开禁发通道。缓存 hydrate
    // 白名单不含此标(mobileHomeListCache.coerceCachedSession),标只存在于本进程内存,
    // 不会出现「无管线接管的孤儿标」。
    const pendingRows = existing?.sessions.filter((s) => s.pendingLocalCreation === true) ?? [];
    if (pendingRows.length > 0) {
      const pendingIds = new Set(pendingRows.map((s) => s.id));
      const nextIds = new Set(nextSessions.map((s) => s.id));
      nextSessions = nextSessions.map((s) => (pendingIds.has(s.id) ? { ...s, pendingLocalCreation: true } : s));
      const missingRows = pendingRows.filter((s) => !nextIds.has(s.id));
      if (missingRows.length > 0) nextSessions = [...missingRows, ...nextSessions];
    }
    // 在途元数据写保护(review P1):重连触发的全量对账 / reseed 拉到的可能是被控端
    // 尚未处理本机写的旧快照,整表替换不得冲掉乐观意图——
    //  - 行仍在本地:在途字段用本地当前值覆盖快照值(其余字段照常吃快照);
    //  - 行已被本地乐观移出(归档/删除在途):不随旧快照复活,终态由该写的结局负责
    //    (失败回滚 upsert 插回 + reseed;成功后新快照自然无此行)。
    nextSessions = nextSessions.flatMap((s) => {
      const pendingFields = sessionPendingWrites.pendingFields(s.id);
      if (pendingFields.length === 0) return [s];
      const local = existing?.sessions.find((row) => row.id === s.id);
      if (!local) return [];
      const overlay: Record<string, unknown> = {};
      for (const field of pendingFields) {
        const localValue = (local as unknown as Record<string, unknown>)[field];
        overlay[field] = localValue;
        // overlay 藏起的权威快照值与 push 遮蔽同样可能是外部并发更新:差异留痕,
        // 由对应写的结局 consume 后 reseed 收敛(review P2)。
        sessionPendingWrites.noteMaskedValue(
          s.id,
          field,
          (s as unknown as Record<string, unknown>)[field],
          localValue,
        );
      }
      return [{ ...s, ...overlay } as RemoteSession];
    });
    // 对称保护(review P2):restore 在途把行乐观加回了当前列表,旧快照(被控端未
    // 处理该写)不含它——status 在途且本地有行、快照缺失时保留本地行,终态由该写
    // 的结局负责(成功后新快照自然包含;失败回滚还原 status,applySessionPatch 会
    // 把行移出)。其它字段在途的缺失行照常吃快照删除(外部删除是权威)。
    {
      const snapshotIds = new Set(nextSessions.map((s) => s.id));
      const pendingStatusRows = (existing?.sessions ?? []).filter((row) =>
        !snapshotIds.has(row.id) && sessionPendingWrites.pendingFields(row.id).includes('status'));
      if (pendingStatusRows.length > 0) nextSessions = [...pendingStatusRows, ...nextSessions];
    }
    if (
      existing
      && existing.deviceName === deviceName
      && remoteSessionListsEqual(existing.sessions, nextSessions)
    ) {
      return;
    }
    shards.set(deviceId, { deviceId, deviceName, sessions: nextSessions });
    recomputeSessions();
  },

  // 冷启动乐观 hydrate:仅当该设备 shard 尚不存在时,用本地首页快照缓存种入(先画缓存)。
  // 「if absent」是关键不变量——fresh loadHome 数据若已先到则绝不覆盖;fresh 之后到会走
  // setDeviceSessions 正常对账替换。与 hydrateMessagesIfEmpty 同一套语义,只作用于会话 shard。
  hydrateDeviceSessionsIfEmpty(deviceId: string, deviceName: string, rawSessions: readonly RemoteSession[]): void {
    if (!deviceId || rawSessions.length === 0 || shards.has(deviceId)) return;
    shards.set(deviceId, {
      deviceId,
      deviceName,
      // cacheSeeded 打标:缓存行字段经瘦身/截断(240 字符),只能撑首屏渲染与跳转,
      // 不能作为发送参数;会话页据此在 fresh 元数据到达前禁发(codex review R15)。
      // fresh 路径(setDeviceSessions / upsertDeviceSession)用服务器新对象,天然无标自净。
      sessions: rawSessions.map((s) => stamp({ ...s, cacheSeeded: true }, deviceId, deviceName)),
    });
    recomputeSessions();
  },

  upsertDeviceSession(deviceId: string, deviceName: string, rawSession: RemoteSession): void {
    let stamped = stamp(rawSession, deviceId, deviceName);
    const shard = shards.get(deviceId);
    if (!shard) {
      shards.set(deviceId, { deviceId, deviceName, sessions: [stamped] });
      recomputeSessions();
      return;
    }
    const next = shard.sessions.filter((s) => s.id !== rawSession.id);
    const existing = shard.sessions.find((s) => s.id === rawSession.id);
    stamped = preserveSessionRuntimeFields(stamped, existing);
    if (
      existing
      && shard.deviceName === deviceName
      && remoteSessionEqual(existing, stamped)
      && shard.sessions[0]?.id === rawSession.id
    ) {
      return;
    }
    shard.deviceName = deviceName;
    shard.sessions = [stamped, ...next];
    recomputeSessions();
  },

  renameDevice(deviceId: string, deviceName: string): void {
    const shard = shards.get(deviceId);
    if (!shard || shard.deviceName === deviceName) return;
    shard.deviceName = deviceName;
    shard.sessions = shard.sessions.map((session) => stamp(session, deviceId, deviceName));
    recomputeSessions();
  },

  applySessionPatch(deviceId: string, sessionId: string, patch: Partial<RemoteSession>): void {
    const shard = shards.get(deviceId);
    if (!shard) {
      if (patch.status === 'active') reseedHandlers.get(deviceId)?.forEach((handler) => handler());
      return;
    }
    const idx = shard.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) {
      if (patch.status === 'active') reseedHandlers.get(deviceId)?.forEach((handler) => handler());
      return;
    }
    let shouldReseedAfterPatch = false;
    if (patch.status === 'deleted' || patch.status === 'archived') {
      shard.sessions = shard.sessions.filter((s) => s.id !== sessionId);
      sessionLiveActivity.delete(sessionId);
      dropPendingTitlePreview(sessionId);
      let messageStateChanged = invalidateSessionMessageWindowState(sessionId, false);
      messageStateChanged = releaseSessionDetailProjections(sessionId) || messageStateChanged;
      sessionMessageLifecycle.forget(sessionId);
      if (patch.status === 'deleted') clearSessionMessageCache(sessionId, deviceId);
      if (messageStateChanged) bumpMessageVersion();
    } else {
      const wasPinned = shard.sessions[idx].pinnedAt != null;
      const unpinned = Object.prototype.hasOwnProperty.call(patch, 'pinnedAt') && patch.pinnedAt == null;
      const patched = preserveSessionRuntimeFields(
        { ...shard.sessions[idx], ...patch } as RemoteSession,
        shard.sessions[idx],
      );
      if (remoteSessionEqual(shard.sessions[idx], patched)) return;
      shard.sessions = shard.sessions.map((s) => (s.id === sessionId ? patched : s));
      shouldReseedAfterPatch = wasPinned && unpinned;
    }
    recomputeSessions();
    if (shouldReseedAfterPatch) this.requestReseed(deviceId);
  },

  setMessages(
    sessionId: string,
    list: readonly RemoteMessage[],
    options: SessionMessageWriteOptions = {},
  ): void {
    if (!messageWriteAllowed(sessionId, options.authority)) return;
    const textFlushed = flushPendingTextDelta(sessionId);
    const next = normalizeWindowForRetention(sessionId, normalizeMessages(list));
    const projectionSettled = settleInputProjectionFromMessages(sessionId, next);
    // 记账在相等早退**之前**:这一页是服务端一次给出的连续段,它带来的连续性结论与"窗口内容有没有
    // 变"无关。冷开缓存恰好与服务端最新页逐行相同时(常态)若被早退跳过,这次权威响应就白来了 ——
    // 之后会话涨过一页、再遇一次满页重连刷新,本可保留的历史会被当成来源不明全丢(#1210 review)。
    coverReplacedWindow(sessionId, next);
    if (next.length === 0) clearSessionMessageCache(sessionId);
    if (remoteMessageListsEqual(messages.get(sessionId) ?? emptyMessages, next)) {
      if (textFlushed || projectionSettled) emit();
      return;
    }
    messages.set(sessionId, next);
    applyMessageWriteRetention(sessionId);
    bumpMessageVersion();
    emit();
  },

  // 乐观 hydrate:仅当该会话当前还没有任何消息时,用本地缓存(冷开预览)种入。
  // 「if empty」是关键不变量——fresh 数据若已先到则不覆盖;fresh 之后到也会按 messageKey 对账替换。
  hydrateMessagesIfEmpty(
    sessionId: string,
    list: readonly RemoteMessage[],
    options: SessionMessageWriteOptions = {},
  ): void {
    // schedule 从不读取长期完整消息缓存，即使当前详情可见也不例外。
    if (retentionForSession(sessionId) === 'schedule') return;
    if (!messageWriteAllowed(sessionId, options.authority)) return;
    const textFlushed = flushPendingTextDelta(sessionId);
    if ((messages.get(sessionId)?.length ?? 0) > 0) {
      if (textFlushed) emit();
      return;
    }
    const next = normalizeMessages(list);
    if (next.length === 0) {
      if (textFlushed) emit();
      return;
    }
    messages.set(sessionId, next);
    applyMessageWriteRetention(sessionId);
    bumpMessageVersion();
    emit();
  },

  setLatestMessageWindow(
    sessionId: string,
    list: readonly RemoteMessage[],
    options: SetLatestMessageWindowOptions = {},
  ): void {
    if (!messageWriteAllowed(sessionId, options.authority)) return;
    const textFlushed = flushPendingTextDelta(sessionId);
    const latestWindow = normalizeWindowForRetention(sessionId, normalizeMessages(list));
    const projectionSettled = settleInputProjectionFromMessages(sessionId, latestWindow);
    if (latestWindow.length === 0) {
      // 空窗口仍需保留本地系统卡(mobile-system-*):新会话首条消息发出后服务端
      // 消息列表可能仍为空,下一次 setLatestMessageWindow 传空数组不能把刚追加的
      // 本地卡擦掉。
      const existing = messages.get(sessionId) ?? [];
      // A live assistant row is not yet represented in the DB window. Do not erase it
      // while the persistence push is still in flight.
      if (hasLiveAssistantMessage(sessionId)) {
        if (textFlushed || projectionSettled) emit();
        return;
      }
      const preserved = existing.filter((item) => messageKey(item).startsWith('mobile-system-'));
      const next = preserved.length > 0 ? preserved : [];
      if (!remoteMessageListsEqual(existing, next)) {
        // 服务端行被清空(只余本地卡):旧覆盖区间连同它背书的那些行一起没了,不能留着背书。
        forgetWindowCoverage(sessionId);
        messages.set(sessionId, next);
        applyMessageWriteRetention(sessionId);
        if (next.length === 0) clearSessionMessageCache(sessionId);
        bumpMessageVersion();
        emit();
      } else if (textFlushed || projectionSettled) {
        emit();
      }
      return;
    }

    const latestOldestCreatedAt = latestWindow[0].createdAt;
    const latestNewestCreatedAt = latestWindow[latestWindow.length - 1].createdAt;
    // A triggering user row must be inserted before its live assistant reply is
    // tied to the same host timestamp. Other authoritative tail rows keep the
    // existing live-before-persisted arrival order when their timestamps tie.
    const latestTailMessage = latestWindow[latestWindow.length - 1];
    const latestTailIsUser = latestTailMessage.role === 'user';
    const latestSendAt = latestUserSendAt(sessionId);
    const latestTailMatchesSend = userMessageMatchesLatestSend(sessionId, latestTailMessage);
    const latestTailIsKnownStaleUser = latestTailIsUser
      && latestSendAt !== undefined
      && !latestTailMatchesSend;
    const reanchorAfterMerge = latestTailIsUser && !latestTailIsKnownStaleUser;
    // A latest-window request may have started before the current send. Only a user tail
    // at/after the session's send marker may move or finish this pending identity; an older
    // user tail belongs to a previous round and leaves the current reply untouched.
    const consumeReanchorAfterMerge = reanchorAfterMerge && latestTailMatchesSend;
    const reanchorAfterMessages = consumeReanchorAfterMerge
      ? latestWindow.filter((message) => message.role === 'user')
      : undefined;
    const liveRowsReanchoredBeforeMerge = !reanchorAfterMerge
      && !latestTailIsKnownStaleUser
      && reanchorPendingLiveAssistantRows(
        sessionId,
        latestNewestCreatedAt,
        { consumePending: false },
      );
    const existing = messages.get(sessionId) ?? [];
    const existingIdentityIndex = buildMessageIdentityIndex(existing);
    const hasOverlap = latestWindow.some((item) => messageIdentityIndexHas(existingIdentityIndex, item));
    const byKey = new Map<string, RemoteMessage>();
    // 截断保护的比较基准必须覆盖全部 existing 行:下面的循环只把窗口外(更新/更旧)
    // 的行 seed 进 byKey,窗口内重叠的完整行若不在基准里,payload 超限的窗口刷新
    // (remoteContentTruncated)会拿 undefined 比较而照样覆盖它们。
    const existingByKey = new Map(existing.map((item) => [messageKey(item), item] as const));

    // A latest-page sync is authoritative for the tail of the conversation.
    // Only keep older cached pages when they overlap that page; otherwise stale
    // old windows can be rendered as if they were adjacent to fresh pushes.
    //
    // 「有交集」这个判据不足以保证**连续**:交集只说明两段有共同的行,不排除更早那一段与本页
    // 之间还隔着服务端仍有、本地从未加载的行。于是窗口会留下"首段 + 尾段"的孤岛,中间几百行
    // 缺失(手机端实测:整场会话的 6 轮对话在界面上凭空消失)。
    //
    // `moreBeyondWindow` 是调用方给的结构信号:本页是满页、或被 device-link 裁过行 —— 两者都
    // 意味着**本页上沿之外服务端还有历史**。这时任何早于本页最旧行的缓存段都无法确认与本页
    // 相接,一律丢弃,窗口于是始终是"某点 → 最新"的连续区间。代价是用户可见的历史变少(丢掉的
    // 是不可信的那一段),「加载更早」入口仍在、可以按连续分页重新取回。
    //
    // 反之本页不满页时,服务端从会话起点到最新已经全给了,不存在中间缺口,旧段照原判据保留。
    //
    // 为什么不靠时间阈值判断空洞:那只能发现"两侧间隔很久"的孤岛。断连期间漏收几十上百条、
    // 而它们在半小时内快速产生时(一个长 turn 里的连续工具调用就是),两侧间隔根本不大,检测不到
    // (#1222)。从源头保证连续区间才覆盖得住。
    //
    // 例外(#1210 review):已验证连续的历史(整窗替换的那页、用户一路「加载更早」翻出来的、订阅
    // 未断时收到的实时 push)与本页确实相接 —— 它由 `sessionWindowCoverage` 的覆盖区间标出。把这种
    // 段也丢掉会让用户正在看的历史与滚动锚点凭空消失,而且补齐不会拉回它(裁完已无内部跳变可
    // 发现)。所以判据是"在已验证覆盖区间内、且本页与该区间首尾相接 → 保留;否则才按
    // moreBeyondWindow 处置"。
    const keepUnverifiedOlderPages = hasOverlap && options.moreBeyondWindow !== true;
    // 相接与否是一次判断,保留判据与下面的记账共用它:两处分开算迟早会让区间与窗口对不上。
    const joinedCoverage = joinableWindowCoverage(
      sessionId,
      existingIdentityIndex,
      latestWindow,
      latestOldestCreatedAt,
    );
    for (const item of existing) {
      const createdAt = item.createdAt;
      const isNewerThanLatestPage = createdAt.localeCompare(latestNewestCreatedAt) >= 0;
      const isVerifiedContiguous = joinedCoverage !== undefined
        && createdAt.localeCompare(joinedCoverage.since) >= 0;
      const isOlderLoadedPage = createdAt.localeCompare(latestOldestCreatedAt) < 0
        && (isVerifiedContiguous || keepUnverifiedOlderPages);
      // 本地系统卡(/learn、/context 等)没有服务端对应行:不管时序落在窗口哪里都
      // 不会出现在 latestKeys 里,若不单独保留会被 window 刷新时静默丢弃。
      const isLocalSystemCard = messageKey(item).startsWith('mobile-system-');
      const isPendingLiveAssistant = isPendingLiveAssistantMessage(sessionId, item);
      if (
        isNewerThanLatestPage
        || isOlderLoadedPage
        || isLocalSystemCard
        || isPendingLiveAssistant
      ) {
        byKey.set(messageKey(item), item);
      }
    }
    for (const rawItem of latestWindow) {
      const item = overlayLivePlanSnapshot(sessionId, rawItem);
      if (isPersistedAssistantMessage(item)) {
        const fallbackIndex = findPendingGeneratedStreamingFallbackIndex(sessionId, existing);
        const fallback = fallbackIndex >= 0 ? existing[fallbackIndex] : undefined;
        if (fallback && generatedFallbackMatchesPersistedMessage(fallback, item)) {
          // History sync may be the first place the authoritative DB identity
          // arrives. Remove the generated key before inserting the persisted row;
          // otherwise the newer temporary row is kept as a tail and the DB row
          // becomes a duplicate assistant bubble.
          byKey.delete(messageKey(fallback));
          const directKey = messageKey(item);
          const existingMatch = byKey.get(directKey) ?? findMessageByIdentity(existing, item);
          byKey.set(directKey, preferCompleteMessage(existingMatch, item));
          forgetPendingLiveAssistantMessageIdentity(
            sessionId,
            fallback.id,
            fallback.clientId,
            item.id,
            item.clientId,
          );
          retireGeneratedStreamingFallback(sessionId);
          continue;
        }
      }
      const directKey = messageKey(item);
      const identityKey = findMessageMergeKey(byKey, item);
      const key = identityKey ?? directKey;
      const existingMatch = byKey.get(key)
        ?? existingByKey.get(directKey)
        ?? findMessageByIdentity(existing, item);
      byKey.set(key, preferCompleteMessage(existingMatch, item));
      if (item.role === 'assistant') {
        forgetPendingLiveAssistantMessageIdentity(
          sessionId,
          key,
          existingMatch?.id,
          existingMatch?.clientId,
          item.id,
          item.clientId,
        );
      }
    }

    const next = normalizeWindowForRetention(sessionId, normalizeMessages([...byKey.values()]));
    // 记账在相等早退**之前**(同 setMessages):这一页是服务端一次给出的连续段,它带来的结论与
    // "窗口内容有没有变"无关。被早退跳过时这次权威响应就白来了(#1210 review)。
    coverLatestPage(sessionId, latestOldestCreatedAt, latestNewestCreatedAt, joinedCoverage);
    if (remoteMessageListsEqual(existing, next)) {
      const liveRowsReanchoredAfterMerge = reanchorAfterMerge
        && reanchorPendingLiveAssistantRows(
          sessionId,
          latestNewestCreatedAt,
          {
            afterMessage: consumeReanchorAfterMerge ? undefined : latestTailMessage,
            afterMessages: reanchorAfterMessages,
            afterMessagesStartIsComplete: options.moreBeyondWindow !== true,
            consumePending: consumeReanchorAfterMerge,
          },
        );
      if (liveRowsReanchoredBeforeMerge || liveRowsReanchoredAfterMerge) bumpMessageVersion();
      if (textFlushed || liveRowsReanchoredBeforeMerge || liveRowsReanchoredAfterMerge) emit();
      return;
    }
    messages.set(sessionId, next);
    if (reanchorAfterMerge) {
      reanchorPendingLiveAssistantRows(
        sessionId,
        latestNewestCreatedAt,
        {
          afterMessage: consumeReanchorAfterMerge ? undefined : latestTailMessage,
          afterMessages: reanchorAfterMessages,
          afterMessagesStartIsComplete: options.moreBeyondWindow !== true,
          consumePending: consumeReanchorAfterMerge,
        },
      );
    }
    applyMessageWriteRetention(sessionId);
    bumpMessageVersion();
    emit();
  },

  markSessionMessagesSynced(sessionId: string, session: Pick<RemoteSession, '_count' | 'updatedAt'>): void {
    if (!sessionId) return;
    sessionMessageSyncMarkers.set(sessionId, buildSessionMessageSyncMarker(session));
  },

  isSessionMessageWindowSynced(sessionId: string, session: Pick<RemoteSession, '_count' | 'updatedAt'>): boolean {
    const marker = sessionMessageSyncMarkers.get(sessionId);
    if (!marker) return false;
    return sessionMessageSyncMarkersEqual(marker, buildSessionMessageSyncMarker(session));
  },

  /** session 页面检测自身是否需要整窗刷新(收到 error-persisted 但消息未被清空)。 */
  hasPendingRefresh(sessionId: string): boolean {
    return pendingRefreshSessions.has(sessionId);
  },

  /** 消费 pending refresh 标记,返回 true 表示确实有待刷新,由调用方触发 load()。 */
  consumePendingRefresh(sessionId: string): boolean {
    if (!pendingRefreshSessions.has(sessionId)) return false;
    pendingRefreshSessions.delete(sessionId);
    return true;
  },

  mergeMessages(
    sessionId: string,
    list: readonly RemoteMessage[],
    options: SessionMessageWriteOptions = {},
  ): void {
    if (!messageWriteAllowed(sessionId, options.authority)) return;
    const textFlushed = flushPendingTextDelta(sessionId);
    const projectionSettled = settleInputProjectionFromMessages(sessionId, list);
    const byKey = new Map<string, RemoteMessage>();
    for (const item of messages.get(sessionId) ?? []) {
      byKey.set(messageKey(item), item);
    }
    for (const rawItem of list) {
      const item = overlayLivePlanSnapshot(sessionId, rawItem);
      const identityKey = findMessageMergeKey(byKey, item);
      const key = identityKey ?? messageKey(item);
      const existingMatch = byKey.get(key);
      byKey.set(key, preferCompleteMessage(existingMatch, item));
      if (item.role === 'assistant') {
        forgetPendingLiveAssistantMessageIdentity(
          sessionId,
          key,
          existingMatch?.id,
          existingMatch?.clientId,
          item.id,
          item.clientId,
        );
      }
    }
    const next = normalizeWindowForRetention(sessionId, normalizeMessages([...byKey.values()]));
    if (remoteMessageListsEqual(messages.get(sessionId) ?? emptyMessages, next)) {
      if (textFlushed || projectionSettled) emit();
      return;
    }
    messages.set(sessionId, next);
    applyMessageWriteRetention(sessionId);
    bumpMessageVersion();
    emit();
  },

  /**
   * 「加载更早」拉回的一页:沿 `before` 游标**从窗口最旧端连续**往前取,所以它与既有窗口相接。
   *
   * 与 `mergeMessages` 的唯一差别是它会把「已验证连续」覆盖区间的下界前移到这一页的最旧行
   * (见 `sessionWindowCoverage`):这样后续满页的最新窗口同步就不会把用户一路翻出来的历史
   * 当成来源不明的缓存丢掉(#1210 review 实测到的回归)。
   *
   * 只有真正沿窗口最旧端连续翻页的调用方可以用它;补内部空洞请继续用 `mergeMessages`。
   */
  mergeEarlierMessages(
    sessionId: string,
    list: readonly RemoteMessage[],
    options: SessionMessageWriteOptions = {},
  ): void {
    if (retentionForSession(sessionId) === 'schedule') return;
    if (!messageWriteAllowed(sessionId, options.authority)) return;
    // 合并前窗口的最旧行 = 这一页接上的那一行,尚无结论时它就是区间上界(见 coverEarlierPage)。
    const joinsAt = oldestCreatedAt(messages.get(sessionId) ?? emptyMessages);
    this.mergeMessages(sessionId, list, options);
    const pageOldest = oldestCreatedAt(list);
    if (pageOldest) coverEarlierPage(sessionId, pageOldest, joinsAt);
  },

  appendMessage(
    sessionId: string,
    message: RemoteMessage,
    options: SessionMessageWriteOptions = {},
  ): void {
    if (!messageWriteAllowed(sessionId, options.authority)) return;
    let changed = flushPendingTextDelta(sessionId);
    changed = settleInputProjectionFromMessages(sessionId, [message]) || changed;
    const reanchorAfterMessage = options.hostTimeAuthoritative !== false && message.role === 'user';
    const userCanReanchorPendingLiveReply = reanchorAfterMessage
      && userMessageCanConsumePendingLiveReply(sessionId, message);
    if (
      options.hostTimeAuthoritative !== false
      && !reanchorAfterMessage
      && reanchorPendingLiveAssistantRows(
        sessionId,
        message.createdAt,
        { consumePending: false },
      )
    ) {
      bumpMessageVersion();
      changed = true;
    }
    changed = upsertMessage(
      sessionId,
      overlayLivePlanSnapshot(sessionId, message),
      { retirePendingAssistantIdentityOnEqual: options.hostTimeAuthoritative !== false },
    ) || changed;
    if (
      userCanReanchorPendingLiveReply
      && reanchorPendingLiveAssistantRows(
        sessionId,
        message.createdAt,
        {
          afterMessage: message,
          consumePending: true,
          pairPendingFromEnd: latestUserSendAt(sessionId) !== undefined,
        },
      )
    ) {
      bumpMessageVersion();
      changed = true;
    }
    // 订阅内到达的实时行可以把覆盖区间的上界往后推;断流后收到的不行(见 liveTailTrusted)。
    coverLiveRow(sessionId, message);
    if (changed) {
      applyMessageWriteRetention(sessionId);
      emit();
    }
  },

  /**
   * 该会话的实时流订阅已被远端 ACK。只影响**此后**落库的权威页能否把尾部标成可信 —— ACK 之前的
   * 空窗里可能已经漏了行,所以 ACK 本身不点亮既有区间的信任位(见 `sessionWindowCoverage`)。
   */
  noteLiveStreamAcked(sessionId: string): void {
    if (sessionId) sessionLiveStreamAcked.add(sessionId);
  },

  /**
   * 实时推送链路中断:socket 掉线(省略 sessionId = 全部会话)、退后台释放 `session:<id>` 订阅、
   * 或离开会话取消订阅。此后到达的 push 与覆盖区间上界之间可能漏了任意多行,不能再续算
   * (见 `sessionWindowCoverage` 的 `liveTailTrusted`)。
   */
  noteLiveStreamInterrupted(sessionId?: string): void {
    noteLiveStreamInterrupted(sessionId);
  },

  /**
   * 被控端已原子清除一轮消息后，按稳定 clientId 集合移除控制端镜像。
   * 同时失效 latest-window marker；sessions patch 与 deletion push 无顺序保证，
   * 不能让旧 marker 把已变更的窗口误判为已同步。
   */
  removeMessages(sessionId: string, clientIds: readonly string[], deviceId?: string): void {
    const deletedClientIds = new Set(clientIds.filter(Boolean));
    if (!sessionId || deletedClientIds.size === 0) return;
    const tracked = new Set(inputProjections.get(sessionId)?.pendingQueue.map((item) => item.clientId) ?? []);
    for (const [clientId, epoch] of inputProjectionRemoteQueuedEvidence.get(sessionId) ?? []) if (epoch > 0) tracked.add(clientId);
    const settled = new Set([...deletedClientIds].filter((clientId) => tracked.has(clientId)));
    const projectionSettled = settleInputProjectionClientIds(sessionId, settled);
    const existing = messages.get(sessionId) ?? emptyMessages;
    const removed = existing.filter((message) => (
      deletedClientIds.has(message.clientId) || deletedClientIds.has(message.id)
    ));
    const next = existing.filter((message) => (
      !deletedClientIds.has(message.clientId) && !deletedClientIds.has(message.id)
    ));
    sessionMessageSyncMarkers.delete(sessionId);
    // 连续性结论随窗口一起失效:rewind 可能删掉中间的行,清空/回收更是整窗重来。
    // 重置为未知,下一次最新窗口同步会重建(见 sessionWindowCoverage)。
    forgetWindowCoverage(sessionId);
    const messagesChanged = next.length !== existing.length;
    if (messagesChanged) messages.set(sessionId, next);
    const deletedTaskAliases = new Set<string>(deletedClientIds);
    for (const message of removed) {
      if (message.toolUseId) deletedTaskAliases.add(message.toolUseId);
      const parentToolUseId = message.agentMeta?.parentUuid;
      if (typeof parentToolUseId === 'string') deletedTaskAliases.add(parentToolUseId);
    }
    let tasksChanged = false;
    for (const taskMap of [sessionTaskUpdates, sessionParkedTaskUpdates]) {
      const existingTasks = taskMap.get(sessionId);
      if (!existingTasks) continue;
      const nextTasks = new Map<string, AgentTaskUpdate>();
      for (const [key, task] of existingTasks) {
        if (
          deletedTaskAliases.has(key) ||
          deletedTaskAliases.has(task.taskId) ||
          (task.parentToolUseId !== undefined &&
            deletedTaskAliases.has(task.parentToolUseId))
        ) {
          continue;
        }
        nextTasks.set(key, task);
      }
      if (nextTasks.size !== existingTasks.size) {
        tasksChanged = true;
        if (nextTasks.size === 0) taskMap.delete(sessionId);
        else taskMap.set(sessionId, nextTasks);
      }
    }
    for (const deletedClientId of deletedClientIds) {
      forgetPendingLiveAssistantMessageIdentity(sessionId, deletedClientId);
    }
    // 磁盘窗口可能在 regular LRU 后仍存在，即使当前内存里找不到被删行，也必须
    // 失效缓存，避免下次 hydrate 把远端已删除的正文复活。显式替换会推进 cache
    // epoch，使更晚触发的旧 debounce/unmount flush 失去提交资格。
    if (retentionForSession(sessionId) === 'schedule' || !messagesChanged) {
      clearSessionMessageCache(sessionId, deviceId);
    } else {
      const resolvedDeviceId = deviceId ?? sessionDeviceIndex.get(sessionId);
      if (resolvedDeviceId) {
        void replaceCachedSessionMessages(resolvedDeviceId, sessionId, next).catch(() => undefined);
      }
    }
    if (messagesChanged) {
      applyMessageWriteRetention(sessionId);
    }
    if (!messagesChanged && !tasksChanged && !projectionSettled) return;
    bumpMessageVersion();
    emit();
  },

  /** 旧调用点兼容：精确移除一个 clientId。 */
  removeMessage(sessionId: string, clientId: string, deviceId?: string): void {
    this.removeMessages(sessionId, [clientId], deviceId);
  },

  appendLocalSystemCard(
    sessionId: string,
    cardType: MobileSystemCardType,
    data: Record<string, unknown> = {},
    createdAt = new Date(),
  ): string {
    const clientId = `mobile-system-${cardType}-${createdAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    this.appendMessage(sessionId, {
      id: clientId,
      clientId,
      sessionId,
      role: 'system',
      content: '',
      toolUseId: null,
      agentMeta: null,
      createdAt: createdAt.toISOString(),
      systemCardType: cardType,
      systemCardData: data,
    }, { hostTimeAuthoritative: false });
    return clientId;
  },

  patchMessageAgentMeta(sessionId: string, clientId: string, patch: Record<string, unknown>): void {
    const existing = messages.get(sessionId);
    if (!existing) return;
    let changed = false;
    const next = existing.map((message) => {
      if (message.clientId !== clientId && message.id !== clientId) return message;
      changed = true;
      return { ...message, agentMeta: { ...(message.agentMeta ?? {}), ...patch } };
    });
    if (!changed) return;
    messages.set(sessionId, next);
    emit();
  },

  setPendingInteractions(
    sessionId: string,
    list: readonly PendingInteraction[],
    options: { finalizeStreaming?: boolean } = {},
  ): void {
    // 已确认 dismiss 的延长抑制条目按「缺席即过期」回收:本轮快照不含该
    // requestId = 被控端已确认移除,慢的旧快照此后不可能再带着它(权威读取按
    // 请求序返回),条目可以安全解除;仍含 = 这是 resolve 前发出的旧快照,保留
    // 抑制继续过滤(codex review P2「早发晚到」闪回)。
    const sessionPrefix = interactionResolveKey(sessionId, '');
    const presentIds = new Set(list
      .map((item) => item.request.requestId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0));
    for (const key of [...confirmedInteractionDismissals]) {
      if (!key.startsWith(sessionPrefix)) continue;
      if (!presentIds.has(key.slice(sessionPrefix.length))) confirmedInteractionDismissals.delete(key);
    }
    // 全量快照也要过在途抑制:决定已乐观提交、被控端还没确认时,快照仍会带着
    // 这张卡,不过滤就闪回。成员关系仍以本轮快照为准(缺席 = 被控端已移除),但
    // revision 化的条目取较新者,避免早发晚到的旧快照把内容换回旧版本。
    const currentByRequestId = interactionsByRequestId(pendingInteractions.get(sessionId) ?? emptyPendingInteractions);
    const next = dedupeInteractions(list
      .filter((item) => !isInteractionResolveSuppressed(sessionId, item))
      .map((item) => {
        const requestId = item.request.requestId;
        return pickFresherInteraction(
          item,
          typeof requestId === 'string' ? currentByRequestId.get(requestId) : undefined,
        );
      }));
    // Only a reconnect snapshot that actually restores a visible pending card may
    // finalize streaming. A snapshot containing only an already-dismissed stale
    // request must not close the current assistant row.
    const streamingChanged = options.finalizeStreaming === true && next.length > 0
      ? flushAndFinalizeRemoteStreamingMessages(sessionId)
      : false;
    // 权威性先落:哪怕内容一字未变(典型是重连后的 [] → []),消费方也必须知道
    // 「这份空列表已经被被控端确认过」——否则离线期收起态的清理永远等不到时机
    // (#1493 review)。因此 authority 的翻转本身就是一次需要通知的变化。
    const authorityChanged = !pendingInteractionsAuthoritative.has(sessionId);
    pendingInteractionsAuthoritative.add(sessionId);
    if (next.length === 0) sessionMessageLifecycle.retryPendingReclaim(sessionId);
    if (deepValueEqual(pendingInteractions.get(sessionId) ?? emptyPendingInteractions, next)) {
      if (streamingChanged || authorityChanged) emit();
      return;
    }
    pendingInteractions.set(sessionId, next);
    emit();
  },

  setInputProjection(sessionId: string, projection: unknown): void {
    const next = normalizeInputProjection(projection, sessionId);
    bumpInputProjectionAuthorityEpoch(sessionId);
    recordInputProjectionRemoteEvidence(sessionId, next.pendingQueue.map((item) => item.clientId));
    commitInputProjection(sessionId, next);
  },

  /** Apply local UI state without claiming that the controlled device accepted it. */
  setInputProjectionOptimistically(sessionId: string, projection: unknown): void {
    const next = normalizeInputProjection(projection, sessionId);
    bumpInputProjectionAuthorityEpoch(sessionId);
    commitInputProjection(sessionId, next);
  },

  captureInputProjectionAuthorityEpoch(sessionId: string): number {
    return inputProjectionAuthorityEpochs.get(sessionId) ?? inputProjectionAuthorityEpochFloor;
  },

  captureInputProjectionRemoteEpoch(sessionId: string): number {
    return inputProjectionRemoteEpochs.get(sessionId) ?? inputProjectionRemoteEpochFloor;
  },

  hasAuthoritativeQueuedItemSince(sessionId: string, clientId: string, expectedRemoteEpoch: number): boolean {
    return Math.abs(inputProjectionRemoteQueuedEvidence.get(sessionId)?.get(clientId) ?? 0)
      > expectedRemoteEpoch;
  },

  setInputProjectionIfCurrent(
    sessionId: string,
    projection: unknown,
    expectedEpoch: number,
    expectedRemoteEpoch?: number,
    acceptedClientId?: string,
  ): boolean {
    const remoteEpoch = inputProjectionRemoteEpochs.get(sessionId) ?? inputProjectionRemoteEpochFloor;
    const currentEpoch = inputProjectionAuthorityEpochs.get(sessionId) ?? inputProjectionAuthorityEpochFloor;
    const authorityStale = currentEpoch !== expectedEpoch;
    const remoteStale = expectedRemoteEpoch !== undefined && remoteEpoch !== expectedRemoteEpoch;
    if (authorityStale || remoteStale) {
      if (acceptedClientId) {
        recordInputProjectionRemoteEvidence(sessionId, [acceptedClientId]);
      }
      return false;
    }
    const next = normalizeInputProjection(projection, sessionId);
    const queuedClientIds = new Set(next.pendingQueue.map((item) => item.clientId));
    if (acceptedClientId) queuedClientIds.add(acceptedClientId);
    recordInputProjectionRemoteEvidence(sessionId, queuedClientIds);
    bumpInputProjectionAuthorityEpoch(sessionId);
    commitInputProjection(sessionId, next);
    return true;
  },

  invalidateInputProjectionAuthority(sessionId: string): void {
    bumpInputProjectionAuthorityEpoch(sessionId);
  },

  setSessionRunning(
    sessionId: string,
    running: boolean,
    boundaryAgentMeta?: Record<string, unknown> | null,
  ): void {
    if (!sessionId) return;
    recordInputProjectionRemoteEvidence(sessionId, []);
    // A maker turn boundary supersedes any projection query that started
    // before it. This is the terminal fence for late owner snapshots.
    bumpInputProjectionAuthorityEpoch(sessionId);
    // The terminal event is also authoritative for the continuation owner. A
    // paired projection clear push may be lost during a disconnect, so clear a
    // known owner here instead of leaving the mobile row live until rehydrate.
    let continuationOwnerCleared = false;
    if (!running) {
      const currentProjection = inputProjections.get(sessionId);
      if (currentProjection?.continuationTurnClientId) {
        const nextProjection: InputProjection = {
          ...currentProjection,
          continuationTurnClientId: null,
        };
        continuationOwnerCleared = !deepValueEqual(currentProjection, nextProjection);
        if (continuationOwnerCleared) inputProjections.set(sessionId, nextProjection);
      }
    }
    // 本方法只被 maker 权威信号调用(done / terminal error / status-changed closed),
    // 与 maker turn 边界同步;activity / 快照流走 writeSessionRunStatus,不经过这里。
    // 边界变化必须独立参与 emit 判定:activity 流可能已把宽 run status 置 false,此时
    // writeSessionRunStatus 无变化,若不 emit,useSessionMakerTurnRunning 的订阅者会卡旧值。
    const streamingChanged = running
      ? false
      : flushAndFinalizeRemoteStreamingMessages(sessionId, boundaryAgentMeta);
    const turnBoundaryChanged = writeMakerTurnRunning(sessionId, running);
    const current = readSessionRunStatus(sessionId);
    const next = clearLiveGenerationOnWideRunStart(current, {
      ...current,
      isRunning: running,
      reconnectAttempt: running ? current.reconnectAttempt : null,
      sideTaskRunning: running ? current.sideTaskRunning : false,
      startedAt: running ? (current.startedAt ?? Date.now()) : null,
    });
    if (writeSessionRunStatus(sessionId, next)
      || turnBoundaryChanged
      || streamingChanged
      || continuationOwnerCleared) emit();
  },

  captureActiveSessionSnapshotEpoch(): number {
    return makerActivityEpoch;
  },

  captureDeviceSessionListMutationEpoch(deviceId: string): number {
    return readDeviceSessionListMutationEpoch(deviceId);
  },

  isDeviceSessionListMutationEpochCurrent(deviceId: string, epoch: number): boolean {
    return readDeviceSessionListMutationEpoch(deviceId) === epoch;
  },

  setActiveSessionSnapshots(
    deviceId: string,
    list: readonly unknown[],
    activityEpochAtFetchStart = makerActivityEpoch,
  ): void {
    // `maker:list-active` returns only currently active sessions. Absence is not
    // an idle assertion: the request can have started before a turn and complete
    // after a live delta, or a stale reconnect response can race a newer push.
    // Only explicit boolean states in the snapshot may change a session's run
    // state; terminal maker/activity events remain the idle authority.
    const snapshotStates = new Map<string, boolean>();
    for (const item of list) {
      if (!isRecord(item)) continue;
      const sessionId = readString(item, 'sessionId');
      if (sessionId && typeof item.isTurnRunning === 'boolean') {
        const indexedDeviceId = sessionDeviceIndex.get(sessionId);
        if (indexedDeviceId && indexedDeviceId !== deviceId) continue;
        snapshotStates.set(sessionId, item.isTurnRunning);
      }
    }
    let changed = false;
    for (const [sessionId, running] of snapshotStates) {
      if (!running) {
        changed = flushAndFinalizeRemoteStreamingMessages(sessionId) || changed;
        changed = writeMakerTurnRunning(sessionId, false) || changed;
      }
      const current = readSessionRunStatus(sessionId);
      const hasNewerMakerActivity = (sessionMakerActivityEpochs.get(sessionId) ?? 0)
        > activityEpochAtFetchStart;
      const next = clearLiveGenerationOnWideRunStart(current, {
        ...current,
        isRunning: running,
        reconnectAttempt: running && hasNewerMakerActivity ? current.reconnectAttempt : null,
        sideTaskRunning: running ? current.sideTaskRunning : false,
        startedAt: running ? (current.startedAt ?? Date.now()) : null,
      });
      changed = writeSessionRunStatus(sessionId, next) || changed;
    }
    if (changed) emit();
  },

  applyInteractionRequest(sessionId: string, item: PendingInteraction): void {
    // push 重放 / reseed 在乐观提交窗口内不得复活这张卡(见 inFlightInteractionResolves);
    // 本端已对某 revision 做过决定时,更旧的快照也不得把它带回来(见 interactionRevisionFloors)。
    if (isInteractionResolveSuppressed(sessionId, item)) return;
    const streamingChanged = flushAndFinalizeRemoteStreamingMessages(sessionId);
    const reconnectCleared = clearSessionReconnectAttempt(sessionId);
    const existing = pendingInteractions.get(sessionId) ?? [];
    // 早发晚到的旧 push 不得把手上更新的那份换回旧版本。
    const requestId = item.request.requestId;
    const fresher = pickFresherInteraction(
      item,
      typeof requestId === 'string' && requestId.length > 0
        ? existing.find((candidate) => candidate.request.requestId === requestId)
        : undefined,
    );
    const next = dedupeInteractions([...existing, fresher]);
    if (deepValueEqual(existing, next)) {
      if (streamingChanged || reconnectCleared) emit();
      return;
    }
    pendingInteractions.set(sessionId, next);
    emit();
  },

  dismissInteraction(sessionId: string, requestId: string): void {
    const existing = pendingInteractions.get(sessionId) ?? [];
    const next = existing.filter((i) => i.request.requestId !== requestId);
    if (next.length === existing.length) return;
    pendingInteractions.set(sessionId, next);
    if (next.length === 0) sessionMessageLifecycle.retryPendingReclaim(sessionId);
    emit();
  },

  /**
   * 交互卡乐观 dismiss(批准 / 拒绝点击即撤卡):撤卡 + 登记在途抑制,让权威流
   * 在被控端确认前无法把同一张卡灌回来。结果落定后必须调 settleOptimistic-
   * InteractionDismiss 收口,否则该 requestId 的卡被永久抑制。
   */
  beginOptimisticInteractionDismiss(sessionId: string, requestId: string): void {
    if (!requestId) return;
    inFlightInteractionResolves.add(interactionResolveKey(sessionId, requestId));
    this.dismissInteraction(sessionId, requestId);
  },

  /**
   * 乐观 dismiss 收口:失败(restore)解除抑制并把原卡复原回面板供重试;成功
   * (confirmed)**不立即解除**——转入延长抑制集合,挡「resolve 前发出、resolve
   * 后才返回」的慢权威快照(否则旧快照会把已解决的卡灌回面板闪回),条目仅由
   * setPendingInteractions 的「缺席即过期」回收。
   */
  settleOptimisticInteractionDismiss(
    sessionId: string,
    requestId: string,
    outcome: { kind: 'confirmed' } | { kind: 'restore'; item: PendingInteraction },
  ): void {
    const key = interactionResolveKey(sessionId, requestId);
    inFlightInteractionResolves.delete(key);
    if (outcome.kind === 'restore') {
      this.applyInteractionRequest(sessionId, outcome.item);
    } else {
      confirmedInteractionDismissals.add(key);
    }
  },

  /**
   * 非乐观提交(revision 化交互,当前只有 plugin_setup)的收口:不撤卡,只把下限
   * 抬到 revision+1,让本次决定作用的那份快照及更旧的都失去覆盖权。
   *
   * 为什么不能复用 settleOptimisticInteractionDismiss 的 confirmed:那是无条件
   * 抑制该 requestId,而这里的决定可能没生效(被控端按 expectedRevision 裁决,
   * 对不上就改为重新体检并推更高 revision),无条件抑制会让卡永久隐身。判据见
   * interactionRevisionFloors。
   */
  markInteractionRevisionResolved(sessionId: string, requestId: string, revision: number): void {
    // 同 interactionRevision:只接受非负整数,与被控端 expectedRevision 契约一致。
    if (!requestId || !Number.isInteger(revision) || revision < 0) return;
    const key = interactionResolveKey(sessionId, requestId);
    const floor = revision + 1;
    const current = interactionRevisionFloors.get(key);
    // 只升不降:重复取消 / 乱序收口都不能把下限拉回去。
    if (current !== undefined && current >= floor) return;
    interactionRevisionFloors.set(key, floor);
    // 下限只挡「后来写入」的过期快照,列表里可能已经躺着一份:dismiss push 早于
    // resolve promise 落定时,一份在途旧快照能在这个方法跑到之前把 revision R 重新
    // 填回去。不一起清掉,那张卡会继续显示,而对它点取消只是「看起来成功」的
    // no-op(被控端已 complete,resolve 不再受理)。见 #530 review。
    const existing = pendingInteractions.get(sessionId);
    if (!existing?.length) return;
    const next = existing.filter((item) => item.request.requestId !== requestId
      || !isInteractionResolveSuppressed(sessionId, item));
    if (next.length === existing.length) return;
    pendingInteractions.set(sessionId, next);
    if (next.length === 0) sessionMessageLifecycle.retryPendingReclaim(sessionId);
    emit();
  },

  /**
   * 单条 maker:event push payload 的消费(逐帧与微批拆包**共用**唯一实现——
   * 两条路径若各自解析,批的语义就会随逐帧演进而漂移)。
   */
  applyMakerEventPush(payload: Record<string, unknown>, deviceId?: string): void {
    const sessionId = readString(payload, 'sessionId');
    const event = isRecord(payload.event) ? payload.event : null;
    const persistId = readString(payload, 'persistId') ?? undefined;
    if (sessionId && event) this.applyMakerEvent(sessionId, event, persistId, deviceId);
  },

  applyRemotePush(deviceId: string, channel: string, payload: unknown): void {
    if (channel === SESSION_ACTIVITY_CHANNEL) {
      this.applySessionActivity(deviceId, payload);
      return;
    }
    if (channel === 'maker:new-maker-draft:changed') {
      const enabled = readPushedNewMakerWorktreeEnabled(payload);
      if (enabled !== null) this.setNewMakerWorktreePreference(deviceId, enabled);
      return;
    }
    if (channel === 'maker:new-maker-worktree-branch:changed') {
      const snapshot = readPushedNewMakerWorktreeBranchPreference(payload);
      if (snapshot !== null) this.setNewMakerWorktreeBranchPreference(deviceId, snapshot);
      return;
    }
    if (channel === 'local-db:sessions:created') {
      bumpDeviceSessionListMutationEpoch(deviceId);
      reseedHandlers.get(deviceId)?.forEach((handler) => handler());
      return;
    }
    if (channel === 'maker:session-model-pref:changed') {
      // 被控端会话「非选中模型」effort/fast 变更(被控端本地改 / 应用了任一控制端写穿)→
      // 刷新会话模型列表镜像(payload 自带 sessionId,镜像按会话隔离,非法 payload 静默忽略)。
      applySessionModelPrefPush(payload);
      return;
    }
    if (channel === 'local-db:sessions:patched' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const patch = isRecord(payload.patch) ? payload.patch : null;
      if (sessionId && patch) {
        bumpDeviceSessionListMutationEpoch(deviceId);
        // 遮蔽本机在途写的字段:旧写的无差别 push 回流不得滚回更新的乐观意图,
        // 被遮字段的终态由对应写的对账 / 后续 push 收敛;全部被遮时跳过应用。
        // localRow 供差异留痕判定:本笔 echo push(同值)不留痕,避免每次成功写
        // 都误触发 reseed(review P2)。
        const localRow = shards.get(deviceId)?.sessions.find((s) => s.id === sessionId);
        const filtered = sessionPendingWrites.filterPatch(
          sessionId,
          patch,
          localRow as unknown as Record<string, unknown> | undefined,
        );
        if (Object.keys(filtered).length > 0) {
          this.applySessionPatch(deviceId, sessionId, filtered as Partial<RemoteSession>);
        }
      }
      return;
    }
    if (channel === 'local-db:messages:created' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const message = isRecord(payload.message) ? (payload.message as unknown as RemoteMessage) : null;
      if (sessionId && message) this.appendMessage(sessionId, message);
      return;
    }
    if (channel === 'local-db:messages:deleted' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const clientId = readString(payload, 'clientId');
      const clientIds = Array.isArray(payload.clientIds)
        ? payload.clientIds.filter((value): value is string =>
            typeof value === 'string' && value.length > 0,
          )
        : clientId
          ? [clientId]
          : [];
      if (sessionId && clientIds.length > 0) {
        this.removeMessages(sessionId, clientIds, deviceId);
      }
      return;
    }
    if (channel === 'local-db:session:error-persisted' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      if (sessionId) {
        if (messages.has(sessionId)) {
          // 会话有缓存消息:保留消息(避免先清空导致空白帧),仅失效 sync marker + 标记待刷新。
          // session 页面监听到 pendingRefreshSessions 变化后调 load(),走 reopen 路径:
          // sync marker 已失效 → metaChanged=true → 拉最新消息窗口(含 error 行)整窗替换。
          sessionMessageSyncMarkers.delete(sessionId);
          // 连续性结论随窗口一起失效:rewind 可能删掉中间的行,清空/回收更是整窗重来。
          // 重置为未知,下一次最新窗口同步会重建(见 sessionWindowCoverage)。
          forgetWindowCoverage(sessionId);
          pendingRefreshSessions.add(sessionId);
        } else {
          // 未缓存:清 sync marker + 标记待刷新。
          // 若 session 页面正在首次 listMessages(messages 尚未填充),需要 pendingRefreshSessions
          // 保证：即使那次 in-flight 请求的响应在 error 行写入之前发出（返回旧历史），
          // session 页面挂载/useSyncExternalStore 检测到 pending 后仍会重新调 load()，
          // 触发同步失效 → metaChanged=true → 整窗替换，error 卡正常浮现。
          messages.delete(sessionId);
          sessionMessageSyncMarkers.delete(sessionId);
          // 连续性结论随窗口一起失效:rewind 可能删掉中间的行,清空/回收更是整窗重来。
          // 重置为未知,下一次最新窗口同步会重建(见 sessionWindowCoverage)。
          forgetWindowCoverage(sessionId);
          pendingRefreshSessions.add(sessionId);
        }
        bumpMessageVersion();
        emit();
      }
      return;
    }
    if (channel === 'maker:event' && isRecord(payload)) {
      this.applyMakerEventPush(payload, deviceId);
      return;
    }
    // 微批帧:被控端把同一会话的连续 maker:event 合并成一帧(能力协商见
    // CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1)。逐条按原顺序走与逐帧**完全
    // 相同**的处理路径——批只是传输层的聚合,不引入新的应用语义;单条形状不符
    // 时跳过该条而不丢整批。
    if (channel === MAKER_EVENT_BATCH_CHANNEL) {
      // 拆包与 fail-closed 的 topic 隔离判据在共享包里(desktop 作为控制端时也用
      // 同一份,见 expandMakerEventBatchPayload 注释)。
      for (const event of expandMakerEventBatchPayload(payload)) {
        if (!isRecord(event)) continue;
        this.applyMakerEventPush(event, deviceId);
      }
      return;
    }
    if (channel === 'maker:status-changed' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const status = readString(payload, 'status');
      if (sessionId && status === 'closed') this.setSessionRunning(sessionId, false);
      return;
    }
    if (channel === 'usage:message-turn-cost' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const clientId = readString(payload, 'clientId');
      const turnMoney = normalizeRemoteMoney(payload.turnMoney);
      const turnCostUsd = readNumber(payload, 'turnCostUsd');
      // 用量明细与金额各自独立:桌面算不出报价时只推 turnUsageDetails,操作行据此
      // 退回显示本轮 token(与 messageNormalize.readTurnCost 同口径)。
      const turnUsageDetails = isRecord(payload.turnUsageDetails)
        ? payload.turnUsageDetails
        : undefined;
      // 用户轮累计与当前 segment 金额是两个独立事实:自动续跑的收尾轮只带 userTurnMoney
      // (前面的 segment 记了账、收尾这个缺报价)。所以独立投影,由
      // messageNormalize.readTurnCost 单点决定操作行显示哪一个
      // (不变量正本见 apps/desktop/src/shared/turnCostPayload.ts)。
      const userTurnMoney = normalizeRemoteMoney(payload.userTurnMoney);
      const userTurnCostUsd = readNumber(payload, 'userTurnCostUsd');
      const userTurnCostIsEstimate = payload.userTurnCostIsEstimate === true;
      const basePatch: Record<string, unknown> = {
        ...(turnUsageDetails ? { turnUsageDetails } : {}),
      };
      if (userTurnMoney && userTurnMoney.amount > 0) {
        basePatch.userTurnCost = userTurnMoney;
        if (userTurnMoney.currency === 'USD') {
          basePatch.userTurnCostUsd = userTurnMoney.amount;
        }
        basePatch.userTurnCostIsEstimate =
          userTurnCostIsEstimate || userTurnMoney.kind === 'value-estimate';
      } else if (userTurnCostUsd !== null && userTurnCostUsd > 0) {
        basePatch.userTurnCostUsd = userTurnCostUsd;
        basePatch.userTurnCostIsEstimate = userTurnCostIsEstimate;
      }
      if (sessionId && clientId && turnMoney && turnMoney.amount > 0) {
        this.patchMessageAgentMeta(sessionId, clientId, {
          ...basePatch,
          turnCost: turnMoney,
          ...(turnMoney.currency === 'USD' ? { turnCostUsd: turnMoney.amount } : {}),
          turnCostIsEstimate: turnMoney.kind === 'value-estimate',
        });
      } else if (sessionId && clientId && turnCostUsd !== null && turnCostUsd > 0) {
        this.patchMessageAgentMeta(sessionId, clientId, {
          ...basePatch,
          turnCostUsd,
          turnCostIsEstimate: payload.turnCostIsEstimate === true,
        });
      } else if (sessionId && clientId && Object.keys(basePatch).length > 0) {
        this.patchMessageAgentMeta(sessionId, clientId, basePatch);
      }
      return;
    }
    if (channel === 'usage:session-spend-changed' && isRecord(payload)) {
      // session 终身累计 cost 镜像:被控端 sessionSpendBroadcaster 走裸 UPDATE、不发
      // sessions:patched,这条(sessions topic,列表订阅常开)是唯一更新通道;不处理则
      // 会话菜单用量摘要停在旧值直到 reseed。readNumber 已挡 NaN,负数不入镜像。
      const sessionId = readString(payload, 'sessionId');
      const totalMoney = normalizeRemoteMoney(payload.totalMoney);
      const totalCostUsd = readNumber(payload, 'totalCostUsd');
      if (sessionId && totalMoney) {
        bumpDeviceSessionListMutationEpoch(deviceId);
        this.applySessionPatch(deviceId, sessionId, {
          totalMoney,
          ...(totalMoney.currency === 'USD' ? { totalCostUsd: totalMoney.amount } : {}),
        });
      } else if (sessionId && totalCostUsd !== null && totalCostUsd >= 0) {
        bumpDeviceSessionListMutationEpoch(deviceId);
        this.applySessionPatch(deviceId, sessionId, { totalCostUsd });
      }
      return;
    }
    if (channel === 'usage:session-tokens-changed' && isRecord(payload)) {
      // 同上:session 终身累计 token 镜像。
      const sessionId = readString(payload, 'sessionId');
      const totalTokens = readNumber(payload, 'totalTokens');
      if (sessionId && totalTokens !== null && totalTokens >= 0) {
        bumpDeviceSessionListMutationEpoch(deviceId);
        this.applySessionPatch(deviceId, sessionId, { totalTokenUsage: totalTokens });
      }
      return;
    }
    if (channel === 'usage:message-model-mismatch' && isRecord(payload)) {
      // 本轮模型降级标记(桌面被控端 turn 结束检测命中时推送):patch 进
      // agent_meta,messageNormalize 的 readModelMismatch 据此渲染降级提示行。
      const sessionId = readString(payload, 'sessionId');
      const clientId = readString(payload, 'clientId');
      const mm = isRecord(payload.modelMismatch) ? payload.modelMismatch : null;
      const selected = mm ? readString(mm, 'selected') : null;
      const actual = mm ? readString(mm, 'actual') : null;
      if (sessionId && clientId && selected && actual) {
        this.patchMessageAgentMeta(sessionId, clientId, {
          modelMismatch: { selected, actual },
        });
      }
      return;
    }
    if (channel === 'maker:interaction-request' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const request = isRecord(payload.request) ? payload.request : null;
      if (sessionId && request) {
        this.applyInteractionRequest(sessionId, {
          request: request as PendingInteraction['request'],
          persistId: readString(payload, 'persistId') ?? undefined,
        });
      }
      return;
    }
    if (channel === 'maker:interaction-dismissed' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      const requestId = readString(payload, 'requestId');
      if (sessionId && requestId) {
        // 注意:这里**不**提前回收延长抑制条目——push 到达只说明被控端已确认,
        // 不排除仍有「决定提交前发出、此刻还在途」的旧 getPendingInteractions
        // 快照晚于本 push 返回(弱网高发);提前回收会让那份旧快照把已解决的卡
        // 灌回面板闪回(codex review P2)。条目一律等 setPendingInteractions 的
        // 「缺席即过期」自然回收。
        this.dismissInteraction(sessionId, requestId);
      }
      return;
    }
    if (channel === 'maker:input:projection' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      if (sessionId) this.setInputProjection(sessionId, payload);
      return;
    }
    if (channel === 'maker:goal:status-changed' && isRecord(payload)) {
      const sessionId = readString(payload, 'sessionId');
      if (sessionId) {
        this.setGoalStatus(
          sessionId,
          isRecord(payload.goal) ? (payload.goal as unknown as MobileGoalStatusPayload) : null,
        );
      }
    }
  },

  setGoalStatus(sessionId: string, goal: MobileGoalStatusPayload | null): void {
    const existing = sessionGoalStatus.get(sessionId);
    if (sessionGoalStatus.has(sessionId) && deepValueEqual(existing, goal)) return;
    sessionGoalStatus.set(sessionId, goal);
    emit();
  },

  applySessionActivity(_deviceId: string, payload: unknown): void {
    if (!isRecord(payload)) return;
    const sessionId = readString(payload, 'sessionId');
    const phase = readString(payload, 'phase');
    if (!sessionId || !isRemoteSessionLiveActivityPhase(phase)) return;
    const compactDetail = typeof payload.compactDetail === 'string' ? payload.compactDetail : '';
    let changed = false;
    if (phase === 'running' || phase === 'needs-interaction') {
      const next: RemoteSessionLiveActivity = {
        sessionId,
        phase,
        compactDetail,
        interactionKind: readString(payload, 'interactionKind') ?? undefined,
        attention: payload.attention === true,
      };
      changed = writeSessionLiveActivity(sessionId, next) || changed;
      const current = readSessionRunStatus(sessionId);
      changed = writeSessionRunStatus(sessionId, clearLiveGenerationOnWideRunStart(current, {
        ...current,
        isRunning: true,
        sideTaskRunning: current.sideTaskRunning,
        startedAt: current.startedAt ?? Date.now(),
      })) || changed;
      if (phase === 'needs-interaction') {
        changed = flushAndFinalizeRemoteStreamingMessages(sessionId) || changed;
      }
    } else {
      // completed / error 的未读态(attention=true)保留 liveActivity 条目 —— 会话行
      // 右侧状态槽靠 phase+attention 点亮完成绿点 / 出错红点(与桌面侧栏同语义);
      // 已读(attention=false,桌面侧真实展示后 relay 会重发)或收尾包才删除条目。
      // isRunning 等运行态照常收敛,不受保留影响。
      if (payload.attention === true) {
        changed = writeSessionLiveActivity(sessionId, {
          sessionId,
          phase,
          compactDetail,
          interactionKind: readString(payload, 'interactionKind') ?? undefined,
          attention: true,
        }) || changed;
      } else {
        changed = sessionLiveActivity.delete(sessionId) || changed;
      }
      // 权威 idle 恢复路径(completed / error 活动推送)同步关闭 maker turn 边界(只关不开):
      // 后台/断连错过终态 maker 事件后,边界会卡在 true、孤儿渲染 gate 常开,stale 得以重放。
      changed = flushAndFinalizeRemoteStreamingMessages(sessionId) || changed;
      changed = writeMakerTurnRunning(sessionId, false) || changed;
      const current = readSessionRunStatus(sessionId);
      changed = writeSessionRunStatus(sessionId, {
        ...current,
        isRunning: false,
        reconnectAttempt: null,
        sideTaskRunning: false,
        startedAt: null,
      }) || changed;
    }
    if (changed) emit();
  },

  applyMakerEvent(
    sessionId: string,
    event: Record<string, unknown>,
    persistId?: string,
    deviceId?: string,
  ): void {
    markSessionMakerActivity(sessionId);
    const type = readString(event, 'type');
    const reconnectCleared = type !== null && type !== 'error' && type !== 'done'
      ? clearSessionReconnectAttempt(sessionId)
      : false;
    const fullMessageWriteAllowed = messageWriteAllowed(sessionId);
    if (type === 'text') {
      if (!fullMessageWriteAllowed) {
        if (reconnectCleared) emit();
        return;
      }
      if (isRemoteTextDeltaEvent(event)) {
        if (enqueueRemoteTextDelta(sessionId, event, persistId, deviceId) || reconnectCleared) emit();
        return;
      }
      let changed = flushPendingTextDelta(sessionId);
      changed = applyRemoteTextEvent(sessionId, event, persistId, deviceId) || changed;
      changed = reconnectCleared || changed;
      if (changed) emit();
      return;
    }

    // setSessionRunning owns the final flush/finalize and run-state transition;
    // keeping the done path in one call avoids notifying subscribers twice.
    if (
      isProductTurnDoneEvent(event)
      || (!isTurnContinuationBoundaryEvent(event) && isTerminalMakerErrorEvent(event))
    ) {
      let terminalPlanChanged = false;
      if (fullMessageWriteAllowed && type === 'done' && readString(event, 'source') === 'codex') {
        const data = isRecord(event.data) ? event.data : null;
        const rawTurn = isRecord(data?.raw) ? data.raw : null;
        const turnId = readString(rawTurn, 'id');
        const turnStatus = readString(rawTurn, 'status');
        const turnCancelled = data?.cancelled === true;
        const currentMessages = messages.get(sessionId) ?? [];
        const completed = applyCodexPlanSnapshotOnDone(
          currentMessages,
          data?.plan,
          turnId,
          turnStatus,
          undefined,
          turnCancelled,
        );
        completeLivePlanSnapshotOnDone(
          sessionId,
          data?.plan,
          turnId,
          turnStatus,
          turnCancelled,
        );
        terminalPlanChanged = completed.changed;
        if (completed.changed) {
          messages.set(sessionId, [...completed.messages]);
          const completedMessage = completed.messages.find((message) => {
            if (message.toolUseId === completed.toolUseId) return true;
            return readString(message.content, 'toolUseId') === completed.toolUseId;
          });
          if (completed.toolUseId && isRecord(completedMessage?.content)) {
            rememberLivePlanContent(
              sessionId,
              completed.toolUseId,
              completedMessage.content,
            );
          }
        }
      } else if (fullMessageWriteAllowed && readString(event, 'source') === 'codex') {
        // 没有 done 的 codex 终态 error:这一轮的计划行等不到章,也等不到
        // persistCodexPlanOnDone 的 turnCompleted:false。与 desktop renderer 的
        // markCodexPlanTurnFailed 同款补印记,否则全勾完的失败计划会按旧数据
        // 兜底退场——任务还活着,用户正要接着指挥。
        const currentMessages = messages.get(sessionId) ?? [];
        const failed = markCodexPlanTurnFailed(currentMessages);
        terminalPlanChanged = failed.changed;
        if (failed.changed) {
          messages.set(sessionId, [...failed.messages]);
          const failedMessage = failed.messages.find((message) => {
            if (message.toolUseId === failed.toolUseId) return true;
            return readString(message.content, 'toolUseId') === failed.toolUseId;
          });
          // 印记也要进 live-plan 缓存:overlayLivePlanSnapshot 用缓存内容整体
          // 替换 content,缓存不补就会把 main 随后广播的落库 turnCompleted:false
          // 盖回去,本连接周期内再也纠不回来。
          if (failed.toolUseId && isRecord(failedMessage?.content)) {
            rememberLivePlanContent(sessionId, failed.toolUseId, failedMessage.content);
          }
        }
      }
      this.setSessionRunning(
        sessionId,
        false,
        isRecord(event.agentMeta) ? event.agentMeta : null,
      );
      if (terminalPlanChanged) {
        bumpMessageVersion();
        emit();
      }
      return;
    }

    const textFlushed = fullMessageWriteAllowed ? flushPendingTextDelta(sessionId) : false;
    if (type === 'error') {
      const data = isRecord(event.data) ? event.data : null;
      const reconnectAttempt = data?.willRetry === true
        ? parseReconnectAttemptMessage(
            readString(data, 'message') ?? '',
            readString(data, 'reason'),
          )
        : null;
      const current = readSessionRunStatus(sessionId);
      const changed = writeSessionRunStatus(sessionId, {
        ...current,
        isRunning: true,
        reconnectAttempt,
        startedAt: current.startedAt ?? Date.now(),
      });
      if (changed || textFlushed) emit();
      return;
    }
    if (type === 'tool_use') {
      if (!fullMessageWriteAllowed) {
        if (reconnectCleared) emit();
        return;
      }
      // Finalize before applying update_plan so its row update and the streaming
      // row transition are published in one snapshot notification.
      const streamingChanged = finalizeRemoteStreamingMessages(
        sessionId,
        isRecord(event.agentMeta) ? event.agentMeta : null,
      );
      const livePlan = applyLivePlanToolUseMessage(sessionId, event, persistId);
      if (livePlan.handled) {
        if (textFlushed || streamingChanged || livePlan.changed || reconnectCleared) emit();
        return;
      }
      if (textFlushed || streamingChanged || reconnectCleared) emit();
      return;
    }
    if (type === 'agent_task_update') {
      if (!fullMessageWriteAllowed) {
        if (reconnectCleared) emit();
        return;
      }
      const rawSource = readString(event, 'source');
      const source = rawSource === 'codex' || rawSource === 'claude-code' || rawSource === 'pi'
        ? rawSource
        : undefined;
      const next = applyAgentTaskUpdateEvent(
        recallParkedTaskUpdates(sessionId, event.data, source, sessionTaskUpdates.get(sessionId)),
        event.data,
        source,
        new Date().toISOString(),
      );
      if (next) {
        sessionTaskUpdates.set(sessionId, next);
        emit();
      } else if (textFlushed || reconnectCleared) {
        emit();
      }
      return;
    }
    if (type === 'compact_boundary') {
      if (!fullMessageWriteAllowed) {
        if (reconnectCleared) emit();
        return;
      }
      const data = isRecord(event.data) ? event.data : {};
      const boundaryId = readString(data, 'boundaryId');
      // 新 producer 都会给 provider boundaryId；兼容旧事件时以完整 data 的 canonical
      // fingerprint 生成可重放身份，不能再用随机 id（同一 replay 会错误结束新工作）。
      const clientId = boundaryId
        ? `mobile-system-compact:${boundaryId}`
        : `mobile-system-compact:fallback:${compactBoundaryFingerprint(data)}`;
      const existing = messages.get(sessionId) ?? [];
      // Transcript replay and the live stream may forward the same provider boundary.
      // De-duplicate before finalizing, otherwise a replay could end post-compact work.
      if (existing.some((message) => messageKey(message) === clientId)) {
        if (textFlushed || reconnectCleared) emit();
        return;
      }
      const backgroundCompact = readString(event, 'turnScope') === 'background';
      // Background compact belongs to the previous idle cycle. Finalizing here
      // would seal a product turn that started after compaction_start.
      if (!backgroundCompact) {
        clearStreamingAssistantPointer(sessionId);
      }
      const nextMessages = backgroundCompact
        ? existing
        : existing.map(finishMessageStreamingAtCompactBoundary);
      const createdAt = new Date().toISOString();
      messages.set(sessionId, normalizeMessages([
        ...nextMessages,
        {
          id: clientId,
          clientId,
          sessionId,
          role: 'assistant',
          content: '',
          toolUseId: null,
          agentMeta: null,
          createdAt,
          systemCardType: 'compact',
          systemCardData: data,
        },
      ]));
      bumpMessageVersion();
      emit();
      return;
    }
    if (type === 'status') {
      const data = isRecord(event.data) ? event.data : null;
      const current = readSessionRunStatus(sessionId);
      if (readString(event, 'turnScope') === 'background') {
        const rawStatus = readString(data, 'status') ?? '';
        const status =
          !rawStatus || (rawStatus === 'Done' && current.isRunning)
            ? current.status
            : rawStatus;
        const changed = writeSessionRunStatus(sessionId, { ...current, status });
        if (changed || textFlushed || reconnectCleared) emit();
        return;
      }
      const isRunning = typeof data?.isRunning === 'boolean' ? data.isRunning : current.isRunning;
      if (!isRunning && isTurnContinuationBoundaryEvent(event)) {
        // A claimed status(false) closes only the provider SDK segment. Keep the
        // mobile product turn and its streaming projection alive until an
        // unclaimed terminal event arrives, matching the desktop lifecycle.
        if (textFlushed || reconnectCleared) emit();
        return;
      }
      const rawTokenUsage = readNumber(data, 'tokenUsage');
      const rawStatus = readString(data, 'status');
      // turn-start 检测用 maker 自己的边界(不用 current.isRunning):activity 推送 / 活跃
      // 快照会先把 sessionRunning 置 true,重连场景首个 status 到达时宽状态已是 true,按它
      // 判定会漏掉真 turn start,stale 清理被跳过。
      const isTurnStart = isRunning && sessionMakerTurnRunning.get(sessionId) !== true;
      const turnBoundaryChanged = writeMakerTurnRunning(sessionId, isRunning);
      const tokenUsage = rawTokenUsage !== null && rawTokenUsage > 0
        ? rawTokenUsage
        : (isTurnStart ? 0 : current.tokenUsage);
      const rawOutputTokens = readNumber(data, 'outputTokens');
      const rawGenerationDurationMs = readNumber(data, 'generationDurationMs');
      const hasLiveFields =
        rawOutputTokens !== null ||
        rawGenerationDurationMs !== null ||
        typeof data?.generationActive === 'boolean' ||
        typeof data?.generationReliable === 'boolean';
      // turn 边界清的是上一轮残留,不是本条 status 自带的 live 字段。
      // 重连/前台恢复会先清 maker-turn,活跃快照只恢复宽 isRunning,于是下一条
      // 用量刷新被当成 isTurnStart;若这里无条件归零,权威 output / duration
      // 会被丢掉,紧接着的终态也来不及再显示 tok/s。
      const outputTokens = rawOutputTokens !== null
        ? rawOutputTokens
        : (isTurnStart ? 0 : current.outputTokens);
      const generationDurationMs = rawGenerationDurationMs !== null
        ? rawGenerationDurationMs
        : (isTurnStart ? 0 : current.generationDurationMs);
      const generationActive = !isRunning
        ? false
        : typeof data?.generationActive === 'boolean'
          ? data.generationActive
          : (isTurnStart || hasLiveFields ? false : current.generationActive);
      const generationReliable = typeof data?.generationReliable === 'boolean'
        ? data.generationReliable
        : (isTurnStart ? true : current.generationReliable);
      // maker turn 边界 false→true 时清掉上一轮残留的 live task updates:它们是 turn 级
      // live 状态,残留到下一轮会被渲染层的孤儿兜底当作"仍在运行的子 agent"追加到消息流
      // 末尾(桌面端靠 idle demote / clear 清,手机 store 是常驻单例,只能在 turn 边界收口)。
      // side task 拉起(skipTurnReset)不豁免:边界置 true 即打开孤儿渲染 gate,不清扫会让
      // 残留立刻重放;而选择性 sweep 本身保留 running codex worker(side task 主体),对
      // side task 无误伤。本轮真实存活的任务也会随后续 update 重建。
      let taskUpdatesCleared = false;
      if (isTurnStart) {
        taskUpdatesCleared = sweepStaleTaskUpdates(sessionId);
      }
      let streamingChanged = false;
      if (!isRunning) {
        streamingChanged = finalizeRemoteStreamingMessages(
          sessionId,
          isRecord(event.agentMeta) ? event.agentMeta : null,
        );
      }
      const next: RemoteSessionRunStatus = {
        isRunning,
        reconnectAttempt: null,
        sideTaskRunning: isRunning ? data?.skipTurnReset === true : false,
        startedAt: isRunning ? (current.startedAt ?? Date.now()) : null,
        status: rawStatus ?? current.status,
        tokenUsage,
        outputTokens,
        generationDurationMs,
        generationActive,
        generationReliable,
      };
      if (
        writeSessionRunStatus(sessionId, next)
        || taskUpdatesCleared
        || turnBoundaryChanged
        || textFlushed
        || streamingChanged
        || reconnectCleared
      ) emit();
      return;
    }
    if (textFlushed || reconnectCleared) emit();
  },

  /**
   * 短暂离线只失效依赖实时连接的投影,保留 shard / session / messages / 路由索引。
   * 恢复后会话页因此走 reopen(旧内容立即可见),而 marker 已删除会强制后台核对
   * 最新消息窗口,不会把断线前缓存误判为 fresh。
   */
  markDeviceOffline(deviceId: string): void {
    let changed = false;
    // A first text delta can still be waiting in the 32ms batch before any session
    // metadata/index exists. Flush batches from this transport first so they create a
    // device-owned host anchor, then freeze that identity before reconnect metadata can
    // bind it to a newer send round.
    for (const [sessionId, batch] of [...pendingTextDeltaBatches]) {
      if (batch.deviceId !== deviceId) continue;
      changed = flushAndFinalizeRemoteStreamingMessages(sessionId) || changed;
      changed = clearStreamingAssistantPointer(sessionId) || changed;
      changed = freezeUnboundPendingHostAnchorsForOffline(sessionId, deviceId) || changed;
    }
    for (const [sessionId, indexedDeviceId] of sessionDeviceIndex) {
      if (indexedDeviceId !== deviceId) continue;
      changed = sessionMessageSyncMarkers.delete(sessionId) || changed;
      changed = livePlanSnapshots.delete(sessionId) || changed;
      changed = pendingRefreshSessions.delete(sessionId) || changed;
      changed = pendingInteractions.delete(sessionId) || changed;
      // 投影没了,这份(空)列表就不再权威:重连拿到全量快照前不许据此做清理。
      changed = pendingInteractionsAuthoritative.delete(sessionId) || changed;
      changed = invalidateInputProjectionForOffline(sessionId) || changed;
      bumpInputProjectionAuthorityEpoch(sessionId);
      changed = sessionLiveActivity.delete(sessionId) || changed;
      changed = sessionGoalStatus.delete(sessionId) || changed;
      changed = sessionTaskUpdates.delete(sessionId) || changed;
      changed = sessionParkedTaskUpdates.delete(sessionId) || changed;
      changed = sessionMakerActivityEpochs.delete(sessionId) || changed;
      changed = flushAndFinalizeRemoteStreamingMessages(sessionId) || changed;
      changed = clearStreamingAssistantPointer(sessionId) || changed;
      // The message window survives a soft offline transition, so both pending
      // identities must survive too: one protects the live row during latest-window
      // reconciliation, and the other lets a reconnecting authoritative user row
      // restore question → reply order. Persisted reconciliation, explicit window
      // invalidation, or actual device removal will retire them.
      changed = freezeUnboundPendingHostAnchorsForOffline(sessionId, deviceId) || changed;
      changed = writeMakerTurnRunning(sessionId, false) || changed;
      changed = writeSessionRunStatus(sessionId, EMPTY_SESSION_RUN_STATUS) || changed;
    }
    for (const [sessionId, pendingAnchors] of pendingHostAnchorLiveAssistantClientIds) {
      if (![...pendingAnchors.values()].some((identity) => identity.deviceIds.has(deviceId))) continue;
      changed = freezeUnboundPendingHostAnchorsForOffline(sessionId, deviceId) || changed;
    }
    if (changed) emit();
  },

  removeDevice(deviceId: string): void {
    bumpDeviceSessionListMutationEpoch(deviceId);
    const hadShard = shards.delete(deviceId);
    const hadWorktreePreference = newMakerWorktreePreferences.delete(deviceId);
    const hadWorktreeBranchPreferences = newMakerWorktreeBranchPreferences.delete(deviceId);
    // A maker event may precede the session list, so transport-owned batches, host anchors,
    // and streaming identities are also authoritative ownership evidence. Sweep their sessions
    // even when no shard or sessionDeviceIndex entry exists yet; otherwise the 32ms timer can
    // recreate messages after hard removal, or an already-flushed live row can survive.
    const indexedDeviceSessionIds = new Set<string>();
    const transportOwnedSessionIds = new Set<string>();
    for (const [sessionId, indexedDeviceId] of sessionDeviceIndex) {
      if (indexedDeviceId === deviceId) indexedDeviceSessionIds.add(sessionId);
    }
    for (const [sessionId, batch] of pendingTextDeltaBatches) {
      if (batch.deviceId === deviceId) transportOwnedSessionIds.add(sessionId);
    }
    for (const [sessionId, pendingAnchors] of pendingHostAnchorLiveAssistantClientIds) {
      if ([...pendingAnchors.values()].some((identity) => identity.deviceIds.has(deviceId))) {
        transportOwnedSessionIds.add(sessionId);
      }
    }
    for (const [sessionId, streamingDeviceIds] of streamingAssistantDeviceIds) {
      if ([...streamingDeviceIds.values()].some((ownerDeviceId) => ownerDeviceId === deviceId)) {
        transportOwnedSessionIds.add(sessionId);
      }
    }
    let removedTransportState = false;
    for (const sessionId of indexedDeviceSessionIds) {
      // Keep the authority reset explicit in this hard-remove boundary: consumers must
      // never interpret the now-empty interaction list as an authoritative snapshot.
      pendingInteractionsAuthoritative.delete(sessionId);
      if (hasTransportOwnedSessionStateFromOtherDevice(sessionId, deviceId)) {
        // The stale shard may still own sessionDeviceIndex while a re-linked transport has
        // already started streaming before its own session list arrives. Preserve that
        // replacement batch/row and remove only state owned by the stale transport.
        sessionDeviceIndex.delete(sessionId);
        removedTransportState = discardTransportOwnedPendingSessionState(
          sessionId,
          deviceId,
        ) || removedTransportState;
        continue;
      }
      removeSessionRuntimeState(sessionId);
    }
    for (const sessionId of transportOwnedSessionIds) {
      if (indexedDeviceSessionIds.has(sessionId)) continue;
      // A re-linked current shard may already own the same session id. In that case
      // remove only the stale transport's provisional rows/batch and keep the current
      // device's authoritative window and runtime projections intact. The same precise
      // cleanup also preserves a second pre-metadata transport when no shard exists yet.
      removedTransportState = discardTransportOwnedPendingSessionState(
        sessionId,
        deviceId,
      ) || removedTransportState;
      if (
        !sessionDeviceIndex.has(sessionId)
        && !pendingTextDeltaBatches.has(sessionId)
        && !pendingHostAnchorLiveAssistantClientIds.has(sessionId)
        && !streamingAssistantDeviceIds.has(sessionId)
      ) {
        pendingInteractionsAuthoritative.delete(sessionId);
        removeSessionRuntimeState(sessionId);
        removedTransportState = true;
      }
    }
    const removedSession = indexedDeviceSessionIds.size > 0 || removedTransportState;
    if (
      !hadShard
      && !removedSession
      && !hadWorktreePreference
      && !hadWorktreeBranchPreferences
    ) return;
    bumpMessageVersion();
    recomputeSessions();
  },

  clear(): void {
    deviceSessionListMutationEpochFloor = ++nextDeviceSessionListMutationEpoch;
    deviceSessionListMutationEpochs.clear();
    shards.clear();
    newMakerWorktreePreferences.clear();
    newMakerWorktreeBranchPreferences.clear();
    messages.clear();
    livePlanSnapshots.clear();
    pendingInteractions.clear();
    pendingInteractionsAuthoritative.clear();
    inFlightInteractionResolves.clear();
    confirmedInteractionDismissals.clear();
    interactionRevisionFloors.clear();
    inputProjections.clear();
    inputProjectionAuthorityEpochFloor = ++nextInputProjectionAuthorityEpoch;
    inputProjectionAuthorityEpochs.clear();
    inputProjectionRemoteEpochFloor = ++nextInputProjectionRemoteEpoch;
    inputProjectionRemoteEpochs.clear();
    inputProjectionRemoteQueuedEvidence.clear();
    // Keep authority tombstones monotonic across a global store reset so an
    // old in-flight query cannot be accepted after the session is recreated.
    sessionLiveActivity.clear();
    sessionRunning.clear();
    sessionRunStatus.clear();
    sessionMakerActivityEpochs.clear();
    makerActivityEpoch = 0;
    sessionMessageSyncMarkers.clear();
    sessionWindowCoverage.clear();
    sessionLiveStreamAcked.clear();
    sessionTaskUpdates.clear();
    streamingAssistantClientIds.clear();
    streamingAssistantDeviceIds.clear();
    pendingLiveAssistantClientIds.clear();
    pendingHostAnchorLiveAssistantClientIds.clear();
    activePendingHostAnchorRoundIds.clear();
    nextPendingHostAnchorRoundId = 0;
    pendingTextDeltaBatches.clear();
    clearTextDeltaFlushTimer();
    sessionMakerTurnRunning.clear();
    sessionParkedTaskUpdates.clear();
    sessionMessageLifecycle.reset();
    sessionLastAccessOrder.clear();
    nextSessionAccessOrder = 0;
    sessionDeviceIndex.clear();
    reseedHandlers.clear();
    pendingTitlePreview.clear();
    mergedSessions = [];
    deviceList = null;
    bumpMessageVersion();
    emit();
  },

  // Register a reseed handler for a device. Returns an unregister fn that removes only THIS
  // handler — multiple screens (Home + device detail) can subscribe the same device
  // concurrently without one's unmount clobbering the other's subscription.
  registerReseedHandler(deviceId: string, handler: () => void): () => void {
    let set = reseedHandlers.get(deviceId);
    if (!set) {
      set = new Set();
      reseedHandlers.set(deviceId, set);
    }
    set.add(handler);
    return () => {
      const current = reseedHandlers.get(deviceId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) reseedHandlers.delete(deviceId);
    };
  },

  requestReseed(deviceId: string): void {
    reseedHandlers.get(deviceId)?.forEach((handler) => handler());
  },

  getSessionDeviceId(sessionId: string): string | undefined {
    return sessionDeviceIndex.get(sessionId);
  },

  getSessions(): RemoteSession[] {
    return mergedSessions;
  },

  getMessages(sessionId: string): RemoteMessage[] {
    return messages.get(sessionId) ?? emptyMessages;
  },

  getMessageVersion(): number {
    return messageVersion;
  },

  getStoreVersion(): number {
    return storeVersion;
  },

  setNewMakerWorktreePreference(deviceId: string, enabled: boolean): void {
    if (!deviceId) return;
    const current = newMakerWorktreePreferences.get(deviceId);
    newMakerWorktreePreferences.set(deviceId, {
      enabled,
      revision: (current?.revision ?? 0) + 1,
    });
    // 同值 push 仍需推进 revision：它可能比在途 pull 更新，必须让旧响应失去写权。
    emit();
  },

  getNewMakerWorktreePreference(
    deviceId: string | null | undefined,
  ): RemoteNewMakerWorktreePreference {
    if (!deviceId) return EMPTY_NEW_MAKER_WORKTREE_PREFERENCE;
    return newMakerWorktreePreferences.get(deviceId)
      ?? EMPTY_NEW_MAKER_WORKTREE_PREFERENCE;
  },

  setNewMakerWorktreeBranchPreference(
    deviceId: string,
    snapshot: RemoteNewMakerWorktreeBranchPreference,
  ): void {
    if (!deviceId || snapshot === null) return;
    const baseRepo = snapshot.baseRepo.trim();
    const sourceBranch = snapshot.sourceBranch.trim();
    if (
      !baseRepo
      || !sourceBranch
      || !Number.isInteger(snapshot.revision)
      || snapshot.revision < 0
    ) return;

    let byRepo = newMakerWorktreeBranchPreferences.get(deviceId);
    const current = byRepo?.get(baseRepo);
    if (current) {
      // revision 由 host 按 canonical repo 单调递增。旧快照不能覆盖；相等只接受
      // 完全相同的幂等 echo，同 revision 的冲突值也必须拒绝。
      if (snapshot.revision < current.revision) return;
      if (snapshot.revision === current.revision) return;
    }
    if (!byRepo) {
      byRepo = new Map();
      newMakerWorktreeBranchPreferences.set(deviceId, byRepo);
    }
    byRepo.set(baseRepo, {
      baseRepo,
      sourceBranch,
      revision: snapshot.revision,
    });
    // 同一 sourceBranch 的新 host revision 也必须发布：它给在途 pull / apply 回包做 fence。
    emit();
  },

  /**
   * GET 的 null 是工作端对该 repo「当前没有偏好」的权威回答，不是漏包。
   * 桌面进程重启后 host revision 会从头开始；先删掉手机保存的旧高 revision，
   * 后续 rev1 snapshot / push 才有资格成为新进程的真相。
   */
  clearNewMakerWorktreeBranchPreference(
    deviceId: string,
    baseRepo: string,
  ): void {
    const normalizedBaseRepo = baseRepo.trim();
    if (!deviceId || !normalizedBaseRepo) return;
    const byRepo = newMakerWorktreeBranchPreferences.get(deviceId);
    if (!byRepo?.delete(normalizedBaseRepo)) return;
    if (byRepo.size === 0) newMakerWorktreeBranchPreferences.delete(deviceId);
    emit();
  },

  getNewMakerWorktreeBranchPreference(
    deviceId: string | null | undefined,
    baseRepo: string | null | undefined,
  ): RemoteNewMakerWorktreeBranchPreference {
    if (!deviceId || !baseRepo?.trim()) return null;
    return newMakerWorktreeBranchPreferences.get(deviceId)?.get(baseRepo.trim()) ?? null;
  },

  getPendingInteractions(sessionId: string): PendingInteraction[] {
    return pendingInteractions.get(sessionId) ?? emptyPendingInteractions;
  },

  /**
   * pending 列表当前是否权威(见 pendingInteractionsAuthoritative 的注释)。
   * 空列表要用来做清理判断时必须先问这里。
   */
  hasAuthoritativePendingInteractions(sessionId: string): boolean {
    return pendingInteractionsAuthoritative.has(sessionId);
  },

  getInputProjection(sessionId: string): InputProjection {
    return inputProjections.get(sessionId) ?? EMPTY_INPUT_PROJECTION;
  },

  getSessionLiveActivity(sessionId: string): RemoteSessionLiveActivity | null {
    return sessionLiveActivity.get(sessionId) ?? null;
  },

  isSessionRunning(sessionId: string): boolean {
    return sessionRunning.get(sessionId) === true;
  },

  getSessionRunStatus(sessionId: string): RemoteSessionRunStatus {
    return readSessionRunStatus(sessionId);
  },

  getSessionTaskUpdates(sessionId: string): ReadonlyMap<string, AgentTaskUpdate> {
    return sessionTaskUpdates.get(sessionId) ?? EMPTY_TASK_UPDATES;
  },

  // undefined = 尚未拉取(unknown),null = 已确认无 goal——两者必须区分:压平成 null 会让
  // 目标视图在首次快照未返回时就放行创建,把被控端已有目标静默覆盖。
  getGoalStatus(sessionId: string): MobileGoalStatusPayload | null | undefined {
    return sessionGoalStatus.get(sessionId);
  },

  // maker status 驱动的权威 turn 边界(不含 activity / 快照流的宽 running)。孤儿 agent_task
  // 卡的渲染 gate 用它:与 turn-start 清理同源,保证「渲染开启时 map 必已清过 stale」。
  isSessionMakerTurnRunning(sessionId: string): boolean {
    return sessionMakerTurnRunning.get(sessionId) === true;
  },

  subscribe(cb: () => void): () => void {
    subs.add(cb);
    return () => subs.delete(cb);
  },
};

sessionMessageLifecycle.setReclaimer((sessionId, reason) =>
  remoteSessionStore.releaseSessionRuntimeState(sessionId, { reason }));

function dedupeInteractions(list: readonly PendingInteraction[]): PendingInteraction[] {
  const byId = new Map<string, PendingInteraction>();
  for (const item of list) {
    byId.set(interactionDedupeKey(item), item);
  }
  return sortPendingInteractions([...byId.values()]);
}

function remoteSessionListsEqual(a: readonly RemoteSession[], b: readonly RemoteSession[]): boolean {
  return recordListsEqual(a, b, remoteSessionEqual);
}

function remoteMessageListsEqual(a: readonly RemoteMessage[], b: readonly RemoteMessage[]): boolean {
  return recordListsEqual(a, b, remoteMessageEqual);
}

function recordListsEqual<T>(
  a: readonly T[],
  b: readonly T[],
  equal: (left: T, right: T) => boolean,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!equal(a[i], b[i])) return false;
  }
  return true;
}

function remoteSessionEqual(a: RemoteSession, b: RemoteSession): boolean {
  return shallowRecordEqual(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>);
}

function remoteMessageEqual(a: RemoteMessage, b: RemoteMessage): boolean {
  return shallowRecordEqual(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>);
}

function deviceListsEqual(
  a: readonly { deviceId: string; name: string }[] | null,
  b: readonly { deviceId: string; name: string }[],
): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].deviceId !== b[i].deviceId || a[i].name !== b[i].name) return false;
  }
  return true;
}

function conversationSearchDeviceModelsEqual(
  a: readonly { canOpen: boolean; deviceId: string; name: string | null; state: string }[],
  b: readonly { canOpen: boolean; deviceId: string; name: string | null; state: string }[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].deviceId !== b[i].deviceId
      || a[i].name !== b[i].name
      || a[i].canOpen !== b[i].canOpen
      || a[i].state !== b[i].state
    ) {
      return false;
    }
  }
  return true;
}

function readSessionRunStatus(sessionId: string): RemoteSessionRunStatus {
  return sessionRunStatus.get(sessionId) ?? EMPTY_SESSION_RUN_STATUS;
}

function clearSessionReconnectAttempt(sessionId: string): boolean {
  const current = readSessionRunStatus(sessionId);
  if (!current.reconnectAttempt) return false;
  return writeSessionRunStatus(sessionId, { ...current, reconnectAttempt: null });
}

function markSessionMakerActivity(sessionId: string): void {
  makerActivityEpoch += 1;
  sessionMakerActivityEpochs.set(sessionId, makerActivityEpoch);
}

function parseAttemptPair(
  match: RegExpExecArray | null,
): { attempt: number; maxAttempts: number } | null {
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (
    !Number.isSafeInteger(attempt)
    || !Number.isSafeInteger(maxAttempts)
    || attempt < 1
    || maxAttempts < attempt
  ) {
    return null;
  }
  return { attempt, maxAttempts };
}

/**
 * 非终止 error 的 message → 重试进度。
 *
 * 三类各有自己的标记:
 *  - 传输层重连: `Reconnecting... N/M`;
 *  - 上游过载退避重投: `(auto-retry N/M)`(maker-core 的
 *    agents/shared/overload-error.ts 统一后缀, Codex 与 Claude 两侧同款)。
 *  - daemon 终态 429 外层重投: reason=`terminal-rate-limit-retry` +
 *    `(rate-limit-retry N/M)`；reason 与 marker 必须同时命中。
 *
 * 过载 marker 不认的话, 整个退避窗口(交互式最长约 30s)手机端只显示笼统的「思考中」, 用户看不出
 * 是在等上游容量(review #844 codex P1)。这里刻意在 mobile 侧独立实现一份判定, 与
 * renderer 的 utils/overloadError.ts 同规 —— maker-core 是 desktop/node 侧包, 不跨
 * bundle 共享。
 */
const TERMINAL_RATE_LIMIT_RETRY_REASON = 'terminal-rate-limit-retry';

function parseReconnectAttemptMessage(
  message: string,
  reason?: string | null,
): RemoteSessionReconnectAttempt | null {
  if (reason === TERMINAL_RATE_LIMIT_RETRY_REASON) {
    const rateLimit = parseAttemptPair(
      /\(rate-limit-retry\s+(\d+)\s*\/\s*(\d+)\)\s*$/i.exec(message),
    );
    return rateLimit ? { ...rateLimit, kind: 'rate-limit' } : null;
  }
  const reconnect = parseAttemptPair(
    /\bReconnecting(?:\.{3}|…)\s*(\d+)\s*\/\s*(\d+)\b/i.exec(message),
  );
  // 重连保持不带 kind: 既有投影/用例把它当 { attempt, maxAttempts } 精确比较, 而
  // 「缺省即 reconnect」本来就是这个字段的语义(见类型注释)。
  if (reconnect) return reconnect;
  const overload = parseAttemptPair(/\(auto-retry\s+(\d+)\s*\/\s*(\d+)\)\s*$/i.exec(message));
  if (overload) return { ...overload, kind: 'overload' };
  return null;
}

// 写 maker turn 边界,返回是否实际变化——变化必须参与调用方的 emit 判定(宽 run status
// 可能已被 activity / 快照流改到相同值,单靠 writeSessionRunStatus 的返回值会漏通知)。
function clearLiveGenerationOnWideRunStart(
  current: RemoteSessionRunStatus,
  next: RemoteSessionRunStatus,
): RemoteSessionRunStatus {
  if (current.isRunning || !next.isRunning) return next;
  // Activity / snapshot / setSessionRunning can flip the wide running flag
  // before the next maker status. Leftover tok/s belongs to the previous
  // turn and must not flash. Maker status still writes authoritative live
  // fields afterwards (including reconnect first-status).
  return {
    ...next,
    outputTokens: 0,
    generationDurationMs: 0,
    generationActive: false,
    generationReliable: true,
  };
}

function writeMakerTurnRunning(sessionId: string, running: boolean): boolean {
  const prev = sessionMakerTurnRunning.get(sessionId) === true;
  if (!running) activePendingHostAnchorRoundIds.delete(sessionId);
  if (running === prev) return false;
  if (running) sessionMakerTurnRunning.set(sessionId, true);
  else {
    sessionMakerTurnRunning.delete(sessionId);
    sessionMessageLifecycle.retryPendingReclaim(sessionId);
  }
  return true;
}

function writeSessionRunStatus(sessionId: string, next: RemoteSessionRunStatus): boolean {
  const current = readSessionRunStatus(sessionId);
  if (shallowRecordEqual(current as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>)) {
    return false;
  }
  sessionRunStatus.set(sessionId, next);
  if (next.isRunning) sessionRunning.set(sessionId, true);
  else {
    sessionRunning.delete(sessionId);
    sessionMessageLifecycle.retryPendingReclaim(sessionId);
  }
  return true;
}

function buildSessionMessageSyncMarker(session: Pick<RemoteSession, '_count' | 'updatedAt'>): SessionMessageSyncMarker {
  const count = session._count?.messages;
  return {
    updatedAt: session.updatedAt,
    messageCount: typeof count === 'number' && Number.isFinite(count) ? count : null,
  };
}

function sessionMessageSyncMarkersEqual(
  marker: SessionMessageSyncMarker,
  next: SessionMessageSyncMarker,
): boolean {
  if (marker.updatedAt !== next.updatedAt) return false;
  if (next.messageCount === null) return true;
  return marker.messageCount === next.messageCount;
}

function writeSessionLiveActivity(sessionId: string, next: RemoteSessionLiveActivity): boolean {
  const current = sessionLiveActivity.get(sessionId);
  if (current && shallowRecordEqual(
    current as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  )) {
    return false;
  }
  sessionLiveActivity.set(sessionId, next);
  return true;
}

function isRemoteSessionLiveActivityPhase(value: string | null): value is SessionActivityPayload['phase'] {
  return value === 'running' || value === 'needs-interaction' || value === 'completed' || value === 'error';
}

function isTerminalMakerErrorEvent(event: Record<string, unknown>): boolean {
  if (readString(event, 'type') !== 'error') return false;
  const data = isRecord(event.data) ? event.data : null;
  if (!data) return true;
  if (typeof data.isTerminal === 'boolean') return data.isTerminal;
  if (typeof data.willRetry === 'boolean') return !data.willRetry;
  return true;
}

function shallowRecordEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepValueEqual(a[key], b[key])) return false;
  }
  return true;
}

function deepValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || isRecord(a)) {
    return safeStableStringify(a) === safeStableStringify(b);
  }
  if (Array.isArray(b) || isRecord(b)) return false;
  return false;
}

function interactionDedupeKey(item: PendingInteraction): string {
  const requestId = item.request.requestId;
  if (typeof requestId === 'string' && requestId.length > 0) return `request:${requestId}`;
  if (item.persistId) return `persist:${item.persistId}`;
  return `request-shape:${safeStableStringify(item.request)}`;
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 旧 compact_boundary 没有 provider id 时的确定性 replay identity。 */
function compactBoundaryFingerprint(data: Record<string, unknown>): string {
  const canonical = canonicalJson(data);
  return `${fnv1aHex(canonical, 0x811c9dc5)}${fnv1aHex(canonical, 0x9e3779b9)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function fnv1aHex(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPushedNewMakerWorktreeEnabled(payload: unknown): boolean | null {
  if (!isRecord(payload)) return null;
  for (const slot of ['claudeCode', 'codex'] as const) {
    const defaults = payload[slot];
    if (!isRecord(defaults)) continue;
    const enabled = defaults.worktreeEnabled;
    if (typeof enabled === 'boolean') return enabled;
  }
  return null;
}

function readPushedNewMakerWorktreeBranchPreference(
  payload: unknown,
): RemoteNewMakerWorktreeBranchPreference {
  if (!isRecord(payload)) return null;
  const baseRepo = payload.baseRepo;
  const sourceBranch = payload.sourceBranch;
  const revision = payload.revision;
  if (
    typeof baseRepo !== 'string'
    || !baseRepo.trim()
    || typeof sourceBranch !== 'string'
    || !sourceBranch.trim()
    || !Number.isInteger(revision)
    || (revision as number) < 0
  ) return null;
  return {
    baseRepo: baseRepo.trim(),
    sourceBranch: sourceBranch.trim(),
    revision: revision as number,
  };
}

function hasDeviceLinkTruncationMarker(value: Record<string, unknown> | null): boolean {
  return value?.[DEVICE_LINK_TRUNCATED_FLAG] === true;
}

function readString(value: unknown, key: string): string | null {
  const raw = isRecord(value) ? value[key] : null;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readNumber(value: unknown, key: string): number | null {
  const raw = isRecord(value) ? value[key] : null;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export function useRemoteSessions(): RemoteSession[] {
  return useSyncExternalStore(remoteSessionStore.subscribe, remoteSessionStore.getSessions);
}

/** Subscribe to one session's message mirror without triggering cache hydration side effects. */
export function useRemoteSessionMessages(sessionId: string): RemoteMessage[] {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getMessages(sessionId),
  );
}

// 本地「最近消息」缓存持久化的去抖间隔:消息流式更新很频繁,只在静默一小段后落盘一次。
const SESSION_MESSAGE_CACHE_PERSIST_DEBOUNCE_MS = 600;

export function useSessionMessages(sessionId: string, deviceId?: string): RemoteMessage[] {
  const messages = useRemoteSessionMessages(sessionId);
  useSessionMessageCacheSync(sessionId, deviceId, messages);
  return messages;
}

// 数据层接线:首次访问某 (deviceId, sessionId) 时从本地缓存乐观 hydrate;消息更新后去抖持久化。
// 写在 store 层(非 render 层),屏幕只管把已有的 deviceId 传进来。
function useSessionMessageCacheSync(
  sessionId: string,
  deviceId: string | undefined,
  messages: RemoteMessage[],
): void {
  const hydratedKeyRef = useRef<string | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retention = useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getSessionRetention(sessionId),
  );
  const authoritySnapshot = useSyncExternalStore(
    sessionMessageLifecycle.subscribe,
    () => sessionMessageLifecycle.getSnapshot(sessionId),
  );
  // 持久化在定时器回调里读最新值,避免把每次渲染的 messages 都闭包进 timer。
  const ctxRef = useRef<{ deviceId?: string; sessionId: string; messages: RemoteMessage[] }>({
    deviceId,
    sessionId,
    messages,
  });
  ctxRef.current = { deviceId, sessionId, messages };

  // 乐观 hydrate:每个 (deviceId, sessionId) 只跑一次;缓存回来时若 store 仍为空才种入。
  useEffect(() => {
    if (!deviceId || !sessionId || retention !== 'regular') return;
    const authority = remoteSessionStore.captureSessionMessageAuthority(sessionId);
    if (!remoteSessionStore.isSessionMessageAuthorityCurrent(authority)) return;
    const cacheAuthority = captureSessionMessageCacheWriteAuthority(deviceId, sessionId);
    if (!cacheAuthority) return;
    const key = `${deviceId}::${sessionId}`;
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    let cancelled = false;
    void getCachedSessionMessages(deviceId, sessionId)
      .then((cached) => {
        if (cancelled || cached.length === 0) return;
        // 消息 authority 只表示页面仍是同一详情代际；权威空窗口、删除、rewind 或
        // schedule 改判不会撤销页面本身。缓存 key epoch 必须另行校验，防止这些
        // 事件发生前启动的旧 getItem 在清空后把已删除正文重新 hydrate 回内存。
        if (!isSessionMessageCacheWriteAuthorityCurrent(cacheAuthority)) return;
        if (remoteSessionStore.getSessionRetention(sessionId) !== 'regular') return;
        if (!remoteSessionStore.isSessionMessageAuthorityCurrent(authority)) return;
        remoteSessionStore.hydrateMessagesIfEmpty(sessionId, cached, { authority });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (hydratedKeyRef.current === key) hydratedKeyRef.current = null;
    };
  }, [authoritySnapshot, deviceId, retention, sessionId]);

  // schedule 不读写长期完整消息缓存。分类晚到时也会走这条定点删除；缓存模块
  // 对同 key 串行，能保证删除排在已经开始的旧写之后。
  useEffect(() => {
    if (!deviceId || !sessionId || retention !== 'schedule') return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    void replaceCachedSessionMessages(deviceId, sessionId, []).catch(() => undefined);
  }, [deviceId, retention, sessionId]);

  // 去抖持久化:messages 变化时重排定时器,静默后落盘最新快照。
  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    if (!deviceId || !sessionId || retention !== 'regular') return;
    const key = `${deviceId}::${sessionId}`;
    // 空内存可能只是 regular LRU 淘汰，绝不能据此删除磁盘缓存。真正的远端
    // 删除由 removeMessages / 权威空窗显式处理。
    if (messages.length === 0) return;
    const cacheAuthority = captureSessionMessageCacheWriteAuthority(deviceId, sessionId);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      const ctx = ctxRef.current;
      if (!ctx.deviceId || !ctx.sessionId || ctx.messages.length === 0) return;
      if (`${ctx.deviceId}::${ctx.sessionId}` !== key) return;
      if (remoteSessionStore.getSessionRetention(ctx.sessionId) !== 'regular') return;
      void cacheSessionMessagesIfCurrent(cacheAuthority, ctx.messages).catch(() => undefined);
    }, SESSION_MESSAGE_CACHE_PERSIST_DEBOUNCE_MS);
  }, [deviceId, messages, retention, sessionId]);

  // 卸载时把尚未落盘的最新快照立即 flush(防止快速返回导致最后一次更新丢失)。
  useEffect(() => () => {
    if (!persistTimerRef.current) return;
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    const ctx = ctxRef.current;
    if (!ctx.deviceId || !ctx.sessionId || ctx.messages.length === 0) return;
    if (remoteSessionStore.getSessionRetention(ctx.sessionId) !== 'regular') return;
    const cacheAuthority = captureSessionMessageCacheWriteAuthority(ctx.deviceId, ctx.sessionId);
    void cacheSessionMessagesIfCurrent(cacheAuthority, ctx.messages).catch(() => undefined);
  }, []);
}

export function useRemoteMessageVersion(): number {
  return useSyncExternalStore(remoteSessionStore.subscribe, remoteSessionStore.getMessageVersion);
}

export function useRemoteSessionStoreVersion(): number {
  return useSyncExternalStore(remoteSessionStore.subscribe, remoteSessionStore.getStoreVersion);
}

export function useRemoteNewMakerWorktreePreference(
  deviceId: string | null | undefined,
): RemoteNewMakerWorktreePreference {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getNewMakerWorktreePreference(deviceId),
  );
}

export function useRemoteNewMakerWorktreeBranchPreference(
  deviceId: string | null | undefined,
  baseRepo: string | null | undefined,
): RemoteNewMakerWorktreeBranchPreference {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getNewMakerWorktreeBranchPreference(deviceId, baseRepo),
  );
}

export function useSessionPendingInteractions(sessionId: string): PendingInteraction[] {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getPendingInteractions(sessionId),
  );
}

export function useSessionPendingInteractionsAuthoritative(sessionId: string): boolean {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.hasAuthoritativePendingInteractions(sessionId),
  );
}

export function useSessionInputProjection(sessionId: string): InputProjection {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getInputProjection(sessionId),
  );
}

export function useSessionRunning(sessionId: string): boolean {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.isSessionRunning(sessionId),
  );
}

export function useSessionRunStatus(sessionId: string): RemoteSessionRunStatus {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getSessionRunStatus(sessionId),
  );
}

export function useSessionTaskUpdates(sessionId: string): ReadonlyMap<string, AgentTaskUpdate> {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getSessionTaskUpdates(sessionId),
  );
}

/** 目标模式状态镜像(undefined = 尚未拉取,null = 已确认无 goal;页面打开时用 goal.getStatus 补一次拉取)。 */
export function useSessionGoalStatus(sessionId: string): MobileGoalStatusPayload | null | undefined {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.getGoalStatus(sessionId),
  );
}

export function useSessionMakerTurnRunning(sessionId: string): boolean {
  return useSyncExternalStore(
    remoteSessionStore.subscribe,
    () => remoteSessionStore.isSessionMakerTurnRunning(sessionId),
  );
}
