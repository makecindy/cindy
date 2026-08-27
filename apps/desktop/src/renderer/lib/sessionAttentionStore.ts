import { useMemo, useSyncExternalStore } from 'react';

import { isTransientRemoteError, withTransientRemoteRetry } from '@cindy/maker-shared/device-link-contract';

import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import {
  getRemoteSessionActivity,
  subscribeRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';

/**
 * 卡片/rail 瓷砖角标语义(决定 AttentionDot 颜色,全端与灵动岛统一):
 *   - 'done'     完成/有未读结果 → 绿
 *   - 'awaiting' 等待用户回复/选择(权限 / AskUserQuestion / 计划审阅) → TapTap 蓝
 *   - 'error'    任务出错(终止错误) → 红
 */
export type AttentionKind = 'done' | 'awaiting' | 'error';

/**
 * 清除 attention 的意图。'error' 红角标是**未处理告警**的派生投影(2026-07 统一,
 * 见 hooks/usePendingAlertAttention.ts):
 *   - 'passive'  导航 / 窗口聚焦 / 路由可见等被动信号 —— **不允许**清 'error' 红角标。
 *                展示不构成已读:横幅还在就说明告警未处理,红点必须留着。
 *   - 'explicit' 告警已被处置(用户操作了报错横幅)或告警本身已消失(pending-alerts
 *                派生收敛、运行历史面板的失败已读、「全部标为已读」)—— 可清任何 kind。
 * intent 随 IPC 透传到 main(appBadgeService → 灵动岛的 explicit/passive ack),
 * main 侧对 passive 同样免疫,双层兜底(renderer 重载丢 kind 后 main 仍安全)。
 * 默认 'passive'(fail-safe):忘了声明的新调用点不会误吞未处理的报错。
 */
export type AttentionClearIntent = 'explicit' | 'passive';

const listeners = new Set<() => void>();
/** sessionId → 当前 attention 语义(只存最新一次)。 */
const attentionMap = new Map<string, AttentionKind>();
// 两份不可变快照:id-only Set 给"有没有未读"的布尔消费者(零改动),kind Map 给卡片读色。
// useSyncExternalStore 要求未变化时返回同一引用 —— 故只在 emit() 时重建。
let idSnapshot: ReadonlySet<string> = new Set();
let kindSnapshot: ReadonlyMap<string, AttentionKind> = new Map();

function emit(): void {
  idSnapshot = new Set(attentionMap.keys());
  kindSnapshot = new Map(attentionMap);
  for (const l of listeners) l();
}

function markSystemAttention(sessionId: string): void {
  if (typeof window === 'undefined') return;
  const mark = window.electronAPI?.notificationMarkSessionAttention;
  if (!mark) return;
  void mark(sessionId).catch(() => undefined);
}

// —— 远程回执的「真实展示 + 同步新鲜度」门槛 ——
// 远程会话的历史经隧道异步加载 / 对账,route / 点击 / attention 推送驱动的清点都可能
// 发生在「展示中的消息窗口尚未包含触发事件对应内容」的时刻(加载转圈、复访残留缓存、
// turn 刚完成但终帧还没对账回来)。此刻放行等于把用户没看到的内容标成已读。
// 语义(咽喉级,所有调用点统一获得):远程回执**一律入队**,按 intent 分级放行:
//   - explicit(用户处置报错横幅 / 「全部标为已读」等显式动作):origin 可解析即发,
//     不卡任何门槛——用户动手处置本身就是最强证据,且 explicit 之后未必再有 sync,
//     若也卡新鲜度会饿死。
//   - passive(导航 / 聚焦类):除 ready 外还需「新鲜」——存在一次**入队之后才启动**
//     且已成功完成的 sync(completedGen > enqueueGen;入队时已在飞的 sync 数据可能
//     早于触发事件,不算数);且被控端处于 error 未读时按下不发(error 免疫,见 flush)。
// sync 代数由 makerChatStore.reconcileRemoteMessages 经 noteRemoteSessionSyncStarted /
// Completed 括号上报;每个 passive 触发源都配对一个 reconcile 触发(视图每次访问一轮、
// focus / 重连 / turn-end 由 useRemoteSessionSync 驱动),不存在无 sync 跟进的悬挂。
// 重复入队按最强 intent 合并(explicit > passive),enqueueGen 取较大值(回执覆盖到
// 最晚一次请求的内容)。
/**
 * 远程回执的放行等级(强 → 弱):
 *   - 'explicit-action':用户显式动作(处置报错横幅 / RunHistoryPane / 自动化菜单
 *     「全部标为已读」/ orphan 角标清理)。目标会话可能根本没打开,origin 可解析
 *     即发,不卡任何门槛 —— 用户都动手了,内容显然已被看到。
 *   - 'passive':导航 / 聚焦类,三道门槛(display-ready / 入队后新鲜 sync / error
 *     免疫)全部生效。
 *
 * 2026-07 统一后这里曾有第三档 'explicit-display'(banner 在视图内驻留即回执),
 * 连带一套 releaseGen 对账门槛用于确认「展示的不是复访缓存的旧错误」。红点改成
 * 未处理告警的派生投影后,展示不再产生已读,该档失去全部触发源,已删除。被控端的
 * error 未读现在由控制端的处置动作(经 ack-interrupted / dismiss-error 窄写落被控端
 * DB)触发它自己的派生收敛来清 —— 不需要「看到即回执」这条腿。
 */
type RemoteReceiptClass = 'explicit-action' | 'passive';

const RECEIPT_CLASS_RANK: Record<RemoteReceiptClass, number> = {
  'explicit-action': 1,
  passive: 0,
};

interface PendingRemoteReceipt {
  receiptClass: RemoteReceiptClass;
  /**
   * 放行代:completedGen >= releaseGen 才可发(explicit-action 不看)。
   * passive 取 startedGen + 1(必须有入队**之后才启动**的 sync 完成)。
   * 重复入队取 max(越晚的请求要求越新的数据)。
   */
  releaseGen: number;
}
interface RemoteReceiptSyncGen {
  startedGen: number;
  completedGen: number;
}
const remoteReceiptReadySessionIds = new Set<string>();
const pendingRemoteReceipts = new Map<string, PendingRemoteReceipt>();
const remoteReceiptSyncGens = new Map<string, RemoteReceiptSyncGen>();

// —— 挂起期间的「新未读」重定基 ——
// explicit 回执只覆盖到用户动作发生的那一刻。回执挂起(origin 缺失 / 门槛未过 /
// 瞬态失败恢复)期间被控端又产生新未读(attention 上升沿)时,旧 explicit 若原样
// 放行会把用户没见过的新内容标成已读——检测到上升沿即把挂起的 explicit 降级为
// passive(重新走展示 + 新鲜度门槛,未打开会话则一直保留未读,语义正确)。
// 观察对象 = 挂起回执 ∪ 在飞发送的 sessionId;活动签名前值与「era」都只为它们维护。
// 重定基条件:**当前 attention=true 且活动签名(phase+attention+detail)相对前值变化**
// ——覆盖两类新未读:false→true 上升沿,以及 attention 一直为 true 但内容更新
// (新 turn 完成时 phase 会经 running 再回 completed,签名必变;仅凭上升沿会漏)。
// era 同条件递增:在飞的退避重试每次尝试前核对发起时的 era,不一致即中止
// (RECEIPT_SUPERSEDED)——否则重试成功会用旧回执清掉重试期间新产生的未读。
const pendingActivitySigSeen = new Map<string, string>();
const attentionEraBySession = new Map<string, number>();
const inflightReceiptSessions = new Map<string, number>();

const RECEIPT_SUPERSEDED = 'RECEIPT_SUPERSEDED';

// error 免疫的兜底探针:活动镜像(remoteSessionActivityStore)可能因推送丢失 / 未达
// 而缺条目,而消息对账已把终止错误窗口拉回并完成同步代——此时仅凭镜像判「非 error」
// 会让 passive 回执提前清掉被控端 Dock 角标。makerChatStore 在模块初始化时注册
// 消息层的终止错误探测(注入而非 import,避免与 makerChatStore 的循环依赖)。
let remoteTerminalErrorProbe: ((sessionId: string) => boolean) | null = null;

/** makerChatStore 注册:探测某会话在消息层是否处于终止错误态(镜像缺失时的 error 免疫兜底)。 */
export function setRemoteTerminalErrorProbe(probe: ((sessionId: string) => boolean) | null): void {
  remoteTerminalErrorProbe = probe;
}

function attentionEraOf(sessionId: string): number {
  return attentionEraBySession.get(sessionId) ?? 0;
}

function remoteActivitySigOf(sessionId: string): string {
  const activity = getRemoteSessionActivity(sessionId);
  if (!activity) return 'none';
  return `${activity.phase}\u0000${activity.attention ? 1 : 0}\u0000${activity.compactDetail}`;
}

function rebasePendingReceiptsOnNewAttention(): void {
  const watched = new Set([...pendingRemoteReceipts.keys(), ...inflightReceiptSessions.keys()]);
  for (const sessionId of watched) {
    const attention = getRemoteSessionActivity(sessionId)?.attention === true;
    const sig = remoteActivitySigOf(sessionId);
    const prevSig = pendingActivitySigSeen.get(sessionId) ?? sig;
    if (attention && sig !== prevSig) {
      attentionEraBySession.set(sessionId, attentionEraOf(sessionId) + 1);
      const pending = pendingRemoteReceipts.get(sessionId);
      if (pending && pending.receiptClass !== 'passive') {
        pendingRemoteReceipts.set(sessionId, {
          receiptClass: 'passive',
          releaseGen: syncGenOf(sessionId).startedGen + 1,
        });
      }
    }
    pendingActivitySigSeen.set(sessionId, sig);
  }
  for (const sessionId of [...pendingActivitySigSeen.keys()]) {
    if (!watched.has(sessionId)) {
      pendingActivitySigSeen.delete(sessionId);
      attentionEraBySession.delete(sessionId);
    }
  }
}

if (typeof window !== 'undefined') {
  subscribeRemoteSessionActivity(rebasePendingReceiptsOnNewAttention);
}

function syncGenOf(sessionId: string): RemoteReceiptSyncGen {
  let gen = remoteReceiptSyncGens.get(sessionId);
  if (!gen) {
    gen = { startedGen: 0, completedGen: 0 };
    remoteReceiptSyncGens.set(sessionId, gen);
  }
  return gen;
}

/** 一次远程消息 sync(对账 / 等价拉取)启动;返回本次的代数 token,完成时回传。 */
export function noteRemoteSessionSyncStarted(sessionId: string): number {
  const gen = syncGenOf(sessionId);
  gen.startedGen += 1;
  return gen.startedGen;
}

/** 该次 sync 成功完成(失败不要调)。可能放行挂起的远程回执。 */
export function noteRemoteSessionSyncCompleted(sessionId: string, startToken: number): void {
  const gen = syncGenOf(sessionId);
  if (startToken > gen.completedGen) gen.completedGen = startToken;
  flushPendingRemoteReceipt(sessionId);
}

/**
 * 会话视图声明某远程会话的历史已真实渲染(ready=true)或已离开 / 回到加载态
 * (ready=false)。置 ready 时尝试放行该会话挂起的远程回执。本机会话无需调用。
 */
export function setRemoteReceiptDisplayReady(sessionId: string, ready: boolean): void {
  if (!ready) {
    remoteReceiptReadySessionIds.delete(sessionId);
    return;
  }
  remoteReceiptReadySessionIds.add(sessionId);
  flushPendingRemoteReceipt(sessionId);
}

function flushPendingRemoteReceipt(sessionId: string): void {
  const pending = pendingRemoteReceipts.get(sessionId);
  if (!pending) return;
  // origin 映射暂缺(relay 重连 / bootstrap 窗口)时不出队:出队后发送腿解析不到
  // deviceId 会把回执静默丢掉。保持挂起,origin 回来后的 flush 触发点再放。
  if (getSessionDeviceId(sessionId) === undefined) return;
  const gen = syncGenOf(sessionId);
  if (pending.receiptClass === 'passive') {
    // passive 三道门槛:display-ready、放行代(入队后才启动且完成的 sync)、error 免疫。
    if (!remoteReceiptReadySessionIds.has(sessionId)) return;
    if (gen.completedGen < pending.releaseGen) return;
    // error 免疫:被控端处于 error 未读时 passive 回执按下不发(被控端 badge set 无
    // kind 概念,passive 打过去会先清 Dock 角标)——挂起等 explicit 升级,或 error
    // 未读态自行消退后由下一轮 sync 放行。
    // 镜像缺条目(推送丢失 / 未达)时回落消息层终止错误探针:探到 error 同样按下不发,
    // 等用户处置横幅产生的 explicit-action 放行,fail-safe。告警一直不处置就一直挂着
    // (对应「未处理」语义正确),开销是一个 Map 条目。
    const activity = getRemoteSessionActivity(sessionId);
    const errorUnread = activity
      ? activity.phase === 'error' && activity.attention
      : remoteTerminalErrorProbe?.(sessionId) === true;
    if (errorUnread) return;
  }
  // explicit-action:用户显式标已读,目标会话可能根本没打开,origin 可解析即发。
  pendingRemoteReceipts.delete(sessionId);
  sendRemoteReceipt(sessionId, pending.receiptClass);
}

/**
 * 远程回执发送腿:与手机端回执同一套重试语义——瞬态失败(离线 / relay 超时等)经
 * withTransientRemoteRetry 原地退避重试;**耗尽后按原 intent 恢复入队**,等重连后的
 * flush 触发点(sync 完成 / 新清点)补发——尤其 explicit(用户处置横幅只发一次,
 * 丢了就没有第二次,而 error 免疫又会挡住后续 passive)绝不能被吞。永久失败
 * (老被控端 CHANNEL_NOT_ALLOWED)吞掉降级(仅本地清点)。
 */
function sendRemoteReceipt(sessionId: string, receiptClass: RemoteReceiptClass): void {
  const deviceId = getSessionDeviceId(sessionId);
  if (!deviceId) return;
  const invoke = window.electronAPI?.deviceLink?.invoke;
  if (!invoke) return;
  const wireIntent: AttentionClearIntent = receiptClass === 'passive' ? 'passive' : 'explicit';
  // 在飞登记 + era 快照:退避重试期间若被控端产生新未读(era 变化),下一次尝试前
  // 中止本回执(旧回执不得清掉重试窗口内新产生的未读),按降级语义重新入队。
  const eraAtSend = attentionEraOf(sessionId);
  inflightReceiptSessions.set(sessionId, (inflightReceiptSessions.get(sessionId) ?? 0) + 1);
  if (!pendingActivitySigSeen.has(sessionId)) {
    pendingActivitySigSeen.set(sessionId, remoteActivitySigOf(sessionId));
  }
  const releaseInflight = (): void => {
    const count = inflightReceiptSessions.get(sessionId) ?? 0;
    if (count <= 1) inflightReceiptSessions.delete(sessionId);
    else inflightReceiptSessions.set(sessionId, count - 1);
  };
  void withTransientRemoteRetry(() => {
    if (attentionEraOf(sessionId) !== eraAtSend) {
      throw new Error(RECEIPT_SUPERSEDED);
    }
    return invoke(deviceId, 'notification:clear-session-attention', [sessionId, wireIntent]);
  }).then(
    () => releaseInflight(),
    (err) => {
      releaseInflight();
      if (String(err).includes(RECEIPT_SUPERSEDED)) {
        // 新未读中止:降级为 passive 重新入队(与挂起期上升沿同规则),不覆盖期间
        // 已重新入队的更强条目。
        if (!pendingRemoteReceipts.has(sessionId)) {
          pendingRemoteReceipts.set(sessionId, {
            receiptClass: 'passive',
            releaseGen: syncGenOf(sessionId).startedGen + 1,
          });
        }
        return;
      }
      if (!isTransientRemoteError(err)) return;
      // 恢复入队:不降级期间新入队的更强等级;releaseGen 保留已有值或 0(该回执出队
      // 前已通过全部门槛,失败只是传输层,不应因恢复而重新抬高新鲜度门槛)。
      const prev = pendingRemoteReceipts.get(sessionId);
      pendingRemoteReceipts.set(sessionId, {
        receiptClass:
          prev && RECEIPT_CLASS_RANK[prev.receiptClass] > RECEIPT_CLASS_RANK[receiptClass]
            ? prev.receiptClass
            : receiptClass,
        releaseGen: prev?.releaseGen ?? 0,
      });
      // 不立即 flush:失败刚发生,等下一个触发点(重连 sync 完成 / 新清点)再试。
    },
  );
}

/**
 * 系统级已读桥:本机 main(Dock 角标 + 灵动岛)恒发;device-link 远程会话再补一条
 * 隧道回执,把被控端的未读真相(它的灵动岛 / 角标 / 侧栏红绿点)一并清掉。
 * 远程腿受「真实展示 + 同步新鲜度」门槛管控:一律入队,ready 且入队后有 sync
 * 成功完成才发出(见上方门槛说明)。侧栏等不经 attentionMap 的调用点也统一走
 * 这里,远程路由只此一个咽喉。
 */
export function clearSystemSessionAttention(
  sessionId: string,
  intent: AttentionClearIntent = 'passive',
): void {
  if (typeof window === 'undefined') return;
  const clear = window.electronAPI?.notificationClearSessionAttention;
  if (clear) void clear(sessionId, intent).catch(() => undefined);
  // 「已知远程」判定放宽:origin 映射(sessionId→deviceId)在 relay 重连 / bootstrap
  // 窗口可能被暂清,而会话视图靠 sticky remoteDeviceId 仍在展示。此窗口内的回执
  // (尤其用户处置横幅产生的 explicit)不能当成本机会话丢弃——只要本咽喉还留有该
  // 会话的远程痕迹(display-ready / 同步代),照常入队;sendRemoteReceipt 发送时
  // 重新解析 deviceId,origin 回来后由既有 flush 触发点(passive 重跑 / sync 完成)
  // 补发。纯本机会话三个信号都不会有,行为不变。
  const knownRemote =
    getSessionDeviceId(sessionId) !== undefined
    || remoteReceiptReadySessionIds.has(sessionId)
    || remoteReceiptSyncGens.has(sessionId);
  if (!knownRemote) return;
  const receiptClass: RemoteReceiptClass = intent === 'explicit' ? 'explicit-action' : 'passive';
  const releaseGen = syncGenOf(sessionId).startedGen + 1;
  const prev = pendingRemoteReceipts.get(sessionId);
  pendingRemoteReceipts.set(sessionId, {
    receiptClass:
      prev && RECEIPT_CLASS_RANK[prev.receiptClass] > RECEIPT_CLASS_RANK[receiptClass]
        ? prev.receiptClass
        : receiptClass,
    releaseGen: Math.max(prev?.releaseGen ?? 0, releaseGen),
  });
  // 活动签名基线:入队时记录当前签名,否则之后的首个变化会被 `?? 当前值` 吞掉,
  // 旧 explicit 漏降级(覆盖「入队时无未读」与「入队时已未读、内容再更新」两类)。
  if (!pendingActivitySigSeen.has(sessionId)) {
    pendingActivitySigSeen.set(sessionId, remoteActivitySigOf(sessionId));
  }
  flushPendingRemoteReceipt(sessionId);
}

function clearSystemAttention(sessionId: string, intent: AttentionClearIntent): void {
  clearSystemSessionAttention(sessionId, intent);
}

export function subscribeSessionAttention(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSessionAttentionSnapshot(): ReadonlySet<string> {
  return idSnapshot;
}

export function getSessionAttentionKinds(): ReadonlyMap<string, AttentionKind> {
  return kindSnapshot;
}

export function getSessionAttentionKind(sessionId: string): AttentionKind | undefined {
  return attentionMap.get(sessionId);
}

/** Hook —— "有没有未读"布尔集合(sidebar / rail / 自动化红点统计沿用,返回类型不变)。 */
export function useSessionAttentionSnapshot(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeSessionAttention, getSessionAttentionSnapshot, getSessionAttentionSnapshot);
}

/** Hook —— sessionId → kind 映射,卡片/瓷砖据此决定角标颜色(绿/蓝/红)。
 *  ⚠️ 性能注意:每次 emit 都换新 Map 引用,订阅本 hook 的组件在**任何**会话的
 *  attention 变化时都会重渲染。列表行(SessionItem 等逐行挂载的组件)禁止用它,
 *  必须用下面的 useSessionAttentionKind(sessionId) 按行精准订阅;本 hook 只留给
 *  "确实要消费整张表"的聚合视图(统计、rail 汇总等)。 */
export function useSessionAttentionKinds(): ReadonlyMap<string, AttentionKind> {
  return useSyncExternalStore(subscribeSessionAttention, getSessionAttentionKinds, getSessionAttentionKinds);
}

/** Hook —— 只订阅**单个** session 的 attention kind。
 *  快照是 primitive(kind 字符串或 undefined),useSyncExternalStore 按值比较:
 *  其它会话的 attention 变化广播到本组件时值没变,不触发重渲染。
 *  侧边栏几百行会话每行一个订阅,靠这个保证"谁变了只惊动谁"。 */
export function useSessionAttentionKind(sessionId: string): AttentionKind | undefined {
  return useSyncExternalStore(
    subscribeSessionAttention,
    () => attentionMap.get(sessionId),
    () => attentionMap.get(sessionId),
  );
}

/** Hook —— 一组 session 聚合后的 urgent attention kind(严重度优先:error > awaiting)。
 *  给"组头聚合子行状态"的场景用(如自动化分组头角标着色):快照是 primitive
 *  (kind 字符串或 undefined),组外会话的 attention 变化、以及组内不改变聚合结果的
 *  变化都不会触发重渲染。逐行组件用 useSessionAttentionKind,聚合组件用这个,
 *  都别退回整张 Map 的 useSessionAttentionKinds。
 *  注:'done' 不参与聚合(返回 undefined)——完成未读的绿点由未读计数路径表达,
 *  本 hook 只回答"组里有没有需要处理的 error / awaiting"。 */
export function useSessionsAttentionUrgentKind(
  sessionIds: readonly string[],
): 'error' | 'awaiting' | undefined {
  const getSnapshot = (): 'error' | 'awaiting' | undefined => {
    let hasAwaiting = false;
    for (const id of sessionIds) {
      const kind = attentionMap.get(id);
      if (kind === 'error') return 'error';
      if (kind === 'awaiting') hasAwaiting = true;
    }
    return hasAwaiting ? 'awaiting' : undefined;
  };
  return useSyncExternalStore(subscribeSessionAttention, getSnapshot, getSnapshot);
}

/** Hook —— 一组 session 的 sessionId → kind 子映射(组外会话不进结果)。
 *  给"折叠容器要按同一份判据汇总整组、且需要知道**是哪几条**"的场景用
 *  (定时任务分组头:汇总红点 + 收起态把告警行提上来,见
 *  sidebar/projectCollapsedAttention.ts 的 errorSessionIds)。
 *  ⚠️ 快照必须是 primitive:内部先序列化成 key 字符串交给 useSyncExternalStore
 *  按值比较,再由 useMemo 派生出引用稳定的 Map —— 组外会话的 attention 变化、
 *  以及组内不改变本组 kind 的变化都不会触发重渲染。直接返回新 Map 会让**任何**
 *  会话的 attention 变化重渲染全部消费组件,等同退回 useSessionAttentionKinds。
 *  只回答"是什么 kind"的聚合场景仍用更省的 useSessionsAttentionUrgentKind。 */
export function useSessionsAttentionKindMap(
  sessionIds: readonly string[],
): ReadonlyMap<string, AttentionKind> {
  const getSnapshot = (): string => {
    let key = '';
    for (const id of sessionIds) {
      const kind = attentionMap.get(id);
      if (kind) key += `${id}:${kind}|`;
    }
    return key;
  };
  const key = useSyncExternalStore(subscribeSessionAttention, getSnapshot, getSnapshot);
  return useMemo(() => {
    const map = new Map<string, AttentionKind>();
    for (const pair of key.split('|')) {
      if (!pair) continue;
      const sep = pair.lastIndexOf(':');
      map.set(pair.slice(0, sep), pair.slice(sep + 1) as AttentionKind);
    }
    return map;
  }, [key]);
}

export function hasSessionAttention(sessionId: string): boolean {
  return attentionMap.has(sessionId);
}

/** 添加/更新某会话的 attention(kind 变化也会重新广播,如 done→error)。默认 'done' 兼容旧调用。 */
export function addSessionAttention(sessionId: string, kind: AttentionKind = 'done'): void {
  if (attentionMap.get(sessionId) === kind) return;
  attentionMap.set(sessionId, kind);
  emit();
  markSystemAttention(sessionId);
}

/**
 * 清某会话的 attention。默认 intent='passive':'error' 红角标对被动清除免疫
 * (不删、不发 IPC),守卫内聚在 store 这一个咽喉,调用点无需各自记 kind 判断;
 * 只有告警被**处置**(用户操作横幅)或告警本身消失(pending-alerts 派生收敛)的
 * 路径才显式传 intent:'explicit' 清 error。展示不构成清除理由。
 */
export function clearSessionAttention(
  sessionId: string,
  options: { intent?: AttentionClearIntent } = {},
): boolean {
  const intent = options.intent ?? 'passive';
  if (intent === 'passive' && attentionMap.get(sessionId) === 'error') return false;
  const removed = attentionMap.delete(sessionId);
  if (removed) emit();
  // explicit = 告警已处置 / 已消失:即使本地没有角标条目(renderer 重载丢内存态 /
  // 未读来自 schedule 元数据),main 侧灵动岛可能仍挂着未读 error,桥接必须照发;
  // passive 保持原语义(真的删了本地条目才同步 badge)。
  if (removed || intent === 'explicit') {
    clearSystemAttention(sessionId, intent);
  }
  return removed;
}

/**
 * 消费 main 广播的「会话已读」(notification:session-attention-cleared)。
 * 清除来源可能是 device-link 远程控制端(手机 / 另一台桌面看完会话):不同步的话
 * 本机侧栏红绿点会一直挂着。只做本地删除 + emit,**绝不**回发 IPC(防回环);
 * 本机自己发起的清除收到回声时条目已删,幂等 no-op。passive 对 error 免疫的
 * 语义与 clearSessionAttention 一致(main 侧灵动岛同样免疫,双层对齐)。
 */
export function applyMainSessionAttentionCleared(sessionId: string, intent: AttentionClearIntent): void {
  if (intent === 'passive' && attentionMap.get(sessionId) === 'error') return;
  if (!attentionMap.delete(sessionId)) return;
  emit();
}

function parseAttentionClearedPayload(
  payload: unknown,
): { sessionId: string; intent: AttentionClearIntent } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { sessionId, intent } = payload as { sessionId?: unknown; intent?: unknown };
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return { sessionId, intent: intent === 'explicit' ? 'explicit' : 'passive' };
}

// 模块加载即订阅(非浏览器 / 测试环境静默跳过);HMR 换模块时解绑旧监听,
// 避免旧实例继续更新已废弃的 attentionMap。
const unsubscribeMainAttentionCleared = (() => {
  if (typeof window === 'undefined') return null;
  const subscribe = window.electronAPI?.onSessionAttentionCleared;
  if (!subscribe) return null;
  return subscribe((payload: unknown) => {
    const parsed = parseAttentionClearedPayload(payload);
    if (!parsed) return;
    applyMainSessionAttentionCleared(parsed.sessionId, parsed.intent);
  });
})();

if (import.meta.hot) {
  import.meta.hot.accept(() => {});
  import.meta.hot.dispose(() => {
    unsubscribeMainAttentionCleared?.();
  });
}

export function clearSessionAttentionMany(
  sessionIds: Iterable<string>,
  options: { intent?: AttentionClearIntent } = {},
): number {
  const intent = options.intent ?? 'passive';
  let changed = 0;
  const bridgeSessionIds: string[] = [];
  for (const sessionId of sessionIds) {
    if (intent === 'passive' && attentionMap.get(sessionId) === 'error') continue;
    const removed = attentionMap.delete(sessionId);
    if (removed) changed += 1;
    // 同上:explicit 对全部请求的 id 桥接,不只对本地删除成功的。
    if (removed || intent === 'explicit') bridgeSessionIds.push(sessionId);
  }
  if (changed > 0) emit();
  for (const sessionId of bridgeSessionIds) clearSystemAttention(sessionId, intent);
  return changed;
}
