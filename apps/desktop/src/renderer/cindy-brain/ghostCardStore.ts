/**
 * ghostCardStore.ts — 意识聊天卡片的 renderer 侧数据源(卡槽③)。
 *
 * 独立模块级 store(不并入 makerChatStore):卡片以 callId 为键、经全局
 * 推送通道('ghosts:card-updated',带净化 html 全量推)到达,与会话消息流
 * 生命周期解耦——fork/rewind 后两条分支的 tool_result 引用同一 callId,
 * 共用同一份卡;塞进 per-session 消息状态会迫使推送走会话路由且每次
 * 更新惊动整个 chat store。这里只有 MessageStream 订阅,重渲面最小。
 *
 * 三种条目状态:
 *   ready   — 有卡(推送到达 / 历史取件命中);
 *   loading — 历史取件在途(本地 DB 毫秒级,规则 7 允许无 loading 帧);
 *   missing — 确认无卡(远程会话 / 被 GC 的历史卡),消费方降级 generic 渲染。
 *
 * liveCards:进行中(turn 未结)卡片的锚定输入——settled 前 renderer 靠它
 * 把卡挂到对应 ghost_call 工具行(claude 精确 toolUseId / codex 同 ghost
 * 启发式),settle 后由 tool_result 的 xdt_card_id 接管配对。
 */

import { parseRemoteResourceChangedPayload, REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { GHOST_CARD_SPAWN_SEP, ghostCardRootCallId } from '../../shared/ghost';

export type GhostCardEntry =
  | {
      status: 'ready';
      ghostId: string;
      sessionId?: string | null;
      /** 静态版(settle 后 / 历史回放)。 */
      html: string;
      /** 动画版(仅推送携带;DB 取件无此字段——历史卡永远静止)。 */
      animatedHtml?: string;
      height: number;
      /** 意识声明的后台活动状态(仅推送携带,card-action 干活场景):
       *  'working' = 过程态卡(衍生卡据此挂运行扫光);DB 取件无此字段——
       *  历史卡永远静止。 */
      state?: 'working' | 'done' | null;
      /** A card of a task on another computer: actions go to that computer, never to this one. */
      remote?: GhostRemoteCardSource;
    }
  | { status: 'loading' }
  | { status: 'missing' };

export interface GhostRemoteCardSource {
  deviceId: string;
  sessionId: string;
  /** The host's version of this card; an action made on an older one is refused there. */
  revision: string;
  externalLinks: boolean;
}

export interface GhostLiveCard {
  callId: string;
  sessionId?: string | null;
  ghostId: string;
  logicalGhostId?: string;
  /** agent 侧 tool_use id(claude 路径推送里带;codex 为 null → 启发式锚定)。 */
  toolUseId: string | null;
  receivedAt: number;
}

export interface GhostCardSnapshot {
  /** 变更计数(useMemo 依赖;限速 ≥1s/卡,重建频率可控)。 */
  version: number;
  byCallId: ReadonlyMap<string, GhostCardEntry>;
  /** 到达序的活卡(TTL 清扫;settled 配对不从这里删,消费方按需忽略)。 */
  liveCards: readonly GhostLiveCard[];
}

/** 活卡条目的存活窗口(超过视为陈旧:turn 早已结束或 renderer 曾离线)。 */
const LIVE_CARD_TTL_MS = 10 * 60 * 1000;

const byCallId = new Map<string, GhostCardEntry>();
let liveCards: GhostLiveCard[] = [];
let version = 0;
let snapshot: GhostCardSnapshot = { version, byCallId, liveCards };
const listeners = new Set<() => void>();
let subscribed = false;
/** 已批量取过卡的会话(ensureSessionCards 幂等,避免重复打 IPC)。 */
const loadedSessions = new Set<string>();

function bump(): void {
  version += 1;
  snapshot = { version, byCallId, liveCards };
  for (const cb of [...listeners]) cb();
}

function sweepLive(now: number): void {
  const fresh = liveCards.filter((c) => now - c.receivedAt < LIVE_CARD_TTL_MS);
  if (fresh.length !== liveCards.length) liveCards = fresh;
}

/** 推送入口(preload onCardUpdated 消费;导出供单测直喂)。 */
export function ingestCardPush(payload: {
  callId: string;
  sessionId?: string | null;
  ghostId: string;
  logicalGhostId?: string;
  toolUseId: string | null;
  html: string;
  animatedHtml?: string | null;
  height: number;
  /** 意识声明的后台活动状态(card-action 干活;衍生卡运行扫光用)。 */
  state?: 'working' | 'done' | null;
  /** turn 级自绘卡(出口钩子 render,callId = assistant 消息 clientId):只入
   *  卡库不进 liveCards——它由 AssistantMessage 按消息 clientId 直取,进锚定池
   *  会被同意识进行中 ghost_call 的启发式锚定抢走(review P1)。 */
  turnCard?: boolean;
}): void {
  const now = Date.now();
  sweepLive(now);
  const previous = byCallId.get(payload.callId);
  byCallId.set(payload.callId, {
    status: 'ready',
    ghostId: payload.ghostId,
    sessionId: payload.sessionId ?? (previous?.status === 'ready' ? previous.sessionId : undefined),
    html: payload.html,
    ...(payload.animatedHtml ? { animatedHtml: payload.animatedHtml } : {}),
    height: payload.height,
    ...(payload.state ? { state: payload.state } : {}),
  });
  if (payload.turnCard) {
    bump();
    return;
  }
  // 衍生卡(card-action 的 spawnCallId,`<根>::sp<序>`):只入卡库不进锚定池——
  // 它由母卡组件按前缀归组、堆叠渲染在母画布下方,不是独立的工具行卡。
  if (payload.callId.includes(GHOST_CARD_SPAWN_SEP)) {
    bump();
    return;
  }
  const existing = liveCards.findIndex((c) => c.callId === payload.callId);
  if (existing >= 0) {
    // 换海报:锚定信息不变,只刷新鲜度。
    liveCards = liveCards.map((c, i) =>
      i === existing ? { ...c, ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}), receivedAt: now } : c,
    );
  } else {
    liveCards = [
      ...liveCards,
      {
        callId: payload.callId,
        sessionId: payload.sessionId,
        ghostId: payload.ghostId,
        ...(payload.logicalGhostId !== undefined ? { logicalGhostId: payload.logicalGhostId } : {}),
        toolUseId: payload.toolUseId,
        receivedAt: now,
      },
    ];
  }
  bump();
}

/**
 * 会话批量取卡(历史回放,每会话一次):一次查出本会话全部卡片灌进 byCallId。
 * 覆盖两类:tool-call 卡(callId = xdt_card_id)与 will-assistant-message 出口钩子
 * 的 turn 级自绘卡(callId = assistant 消息 clientId)——后者让"该气泡被自绘替换"
 * 的判定(byCallId 命中 clientId)在重启/回放后成立,无需逐条 ensureCard 打 IPC。
 * 推送先到者(ready)不覆盖。
 */
export function ensureSessionCards(sessionId: string): void {
  if (!sessionId || loadedSessions.has(sessionId)) return;
  loadedSessions.add(sessionId);
  ensureSubscribed();
  const api = (window as unknown as {
    electronAPI?: {
      ghosts?: {
        listCardsBySession?: (id: string) => Promise<{
          cards: Array<{ callId: string; ghostId: string; html: string; height: number }>;
        }>;
      };
    };
  }).electronAPI;
  if (!api?.ghosts?.listCardsBySession) return;
  void api.ghosts
    .listCardsBySession(sessionId)
    .then(({ cards }) => {
      let changed = false;
      for (const c of cards) {
        const cur = byCallId.get(c.callId);
        if (cur?.status === 'ready') {
          if (!cur.sessionId) { byCallId.set(c.callId, { ...cur, sessionId }); changed = true; }
          continue; // 推送先到,以更新者为准
        }
        byCallId.set(c.callId, { status: 'ready', sessionId, ghostId: c.ghostId, html: c.html, height: c.height });
        changed = true;
      }
      if (changed) bump();
    })
    .catch(() => {
      // 取件失败:退回逐条 ensureCard 的懒路径(下次允许重试)。
      loadedSessions.delete(sessionId);
    });
}

/** 首次被消费时才挂推送订阅(模块导入零副作用;测试环境无 electronAPI 也安全)。 */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  const api = (window as unknown as {
    electronAPI?: { ghosts?: { onCardUpdated?: (cb: (p: never) => void) => () => void } };
  }).electronAPI;
  api?.ghosts?.onCardUpdated?.((payload) => ingestCardPush(payload as Parameters<typeof ingestCardPush>[0]));
}

export function subscribeGhostCards(cb: () => void): () => void {
  ensureSubscribed();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getGhostCardSnapshot(): GhostCardSnapshot {
  return snapshot;
}

/**
 * 单条卡片取值(按 callId;出口钩子 render 卡的 callId = assistant 消息 clientId)。
 * 返回 byCallId 里的稳定引用(未变则同引用),供 useSyncExternalStore 的 getSnapshot
 * 直接用——AssistantMessage 据此判定该气泡是否被意识自绘替换。 */
export function getGhostCardEntry(callId: string): GhostCardEntry | undefined {
  return byCallId.get(callId);
}

/**
 * 某根卡名下的衍生卡(card-action spawn 的新卡位)列表,按 callId 升序
 * (spawn 序是时间 36 进制,字典序≈时间序)。母卡组件(GhostToolCard)据此
 * 把衍生卡堆叠渲染在母画布下方。只返回 ready 条目;返回值每次新建,消费方
 * 用 store version 做 memo 依赖(bump 即重算)。
 */
export function listSpawnCards(
  rootCallId: string,
): Array<{ callId: string; entry: Extract<GhostCardEntry, { status: 'ready' }> }> {
  const prefix = rootCallId + GHOST_CARD_SPAWN_SEP;
  const out: Array<{ callId: string; entry: Extract<GhostCardEntry, { status: 'ready' }> }> = [];
  for (const [callId, entry] of byCallId) {
    if (entry.status === 'ready' && callId.startsWith(prefix)) out.push({ callId, entry });
  }
  out.sort((a, b) => (a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0));
  return out;
}

/**
 * 历史卡片按需取件(幂等):未知 → loading → invoke → ready/missing。
 * missing 结果缓存(不反复打 IPC);推送先到则直接 ready,不再取。
 */
export function ensureCard(callId: string): void {
  if (!callId || byCallId.has(callId)) return;
  ensureSubscribed();
  byCallId.set(callId, { status: 'loading' });
  const api = (window as unknown as {
    electronAPI?: {
      ghosts?: {
        getCard?: (id: string) => Promise<{
          card: { ghostId: string; html: string; height: number } | null;
        }>;
      };
    };
  }).electronAPI;
  if (!api?.ghosts?.getCard) {
    byCallId.set(callId, { status: 'missing' });
    bump();
    return;
  }
  void api.ghosts
    .getCard(callId)
    .then(({ card }) => {
      // 推送竞态:取件在途时推送已把它置 ready,以更新者为准,不回退。
      const current = byCallId.get(callId);
      if (current && current.status === 'ready') return;
      byCallId.set(
        callId,
        card
          ? { status: 'ready', ghostId: card.ghostId, html: card.html, height: card.height }
          : { status: 'missing' },
      );
      bump();
    })
    .catch(() => {
      byCallId.set(callId, { status: 'missing' });
      bump();
    });
  // loading 态本身不广播:本地 DB 毫秒级返回,广播只在落定时发一次,
  // 避免"loading → ready"两次重建(规则 7:不给用户 loading 帧)。
}

/**
 * 权威实测高回填(GhostToolCard 量高后调):同步刷新内存条目,组件重挂载
 * (切 session / 滚出窗口再回来)直接以准确高度首帧渲染,不再重演
 * "估计值 → 实测值"的跳变。磁盘侧由 reportCardHeight IPC 另行写回。
 */
export function noteCardMeasuredHeight(callId: string, measured: number): void {
  const entry = byCallId.get(callId);
  if (!entry || entry.status !== 'ready' || entry.height === measured) return;
  byCallId.set(callId, { ...entry, height: measured });
  bump();
}

// ── Cards of tasks on another computer ─────────────────────────────────────────
// The card stays on the task's computer. Its markup is read through device-link (and sanitized
// again by this computer's main process); updates arrive as the host's existing
// `plugin-results` change notices, which the always-on sessions subscription already carries.

/** Hosts that ignored `plugin-card-html` (older versions): their tasks keep plain tool rows. */
const unsupportedRemoteHosts = new Set<string>();
/** A failed read may be retried later (link offline, card not yet persisted). */
const remoteRetryAt = new Map<string, number>();
const remoteAttempted = new Set<string>();
/** Cards whose read failed: a later change notice from their computer reads them again. */
const remoteUnread = new Map<string, { deviceId: string; sessionId: string }>();
const REMOTE_RETRY_MS = 30_000;
const remoteReads = new Map<string, Promise<void>>();
let remoteSubscribed = false;
const remoteViews = new Map<string, number>();
const remoteDirty = new Set<string>();
const remoteSessionKey = (deviceId: string, sessionId: string) => JSON.stringify([deviceId, sessionId]);

/** Task stream and title-bar previews retain only the sessions currently displayed. */
export function retainRemoteCardSession(deviceId: string, sessionId: string): () => void {
  const key = remoteSessionKey(deviceId, sessionId);
  const count = remoteViews.get(key) ?? 0;
  remoteViews.set(key, count + 1);
  ensureRemoteSubscribed();
  if (!count) {
    // Notices received while hidden did no IO; opening the task reads the latest versions.
    for (const [callId, entry] of byCallId) {
      if (entry.status === 'ready' && entry.remote?.deviceId === deviceId && entry.remote.sessionId === sessionId)
        void readRemoteCard(deviceId, sessionId, callId);
    }
    for (const [callId, source] of remoteUnread) {
      if (source.deviceId === deviceId && source.sessionId === sessionId)
        void readRemoteCard(deviceId, sessionId, callId);
    }
  }
  return () => {
    const remaining = (remoteViews.get(key) ?? 1) - 1;
    if (remaining) remoteViews.set(key, remaining);
    else remoteViews.delete(key);
  };
}

function readRemoteCard(deviceId: string, sessionId: string, callId: string): Promise<void> {
  const key = `${deviceId}\n${callId}`;
  const running = remoteReads.get(key);
  if (running) { remoteDirty.add(key); return running; }
  const owner = getDataOwnerGeneration();
  const read = (async () => {
    let result: Awaited<ReturnType<typeof window.electronAPI.ghosts.getRemoteCard>> | null = null;
    try {
      result = await window.electronAPI.ghosts.getRemoteCard(deviceId, sessionId, callId);
    } catch {
      result = null;
    }
    if (!isDataOwnerGenerationCurrent(owner)) return;
    const current = byCallId.get(callId);
    const card = result?.card;
    if (card) {
      remoteRetryAt.delete(callId);
      remoteUnread.delete(callId);
      byCallId.set(callId, {
        status: 'ready',
        ghostId: card.ghostId,
        sessionId,
        html: card.html,
        height: current?.status === 'ready' && current.html === card.html ? current.height : card.height,
        remote: { deviceId, sessionId, revision: card.revision, externalLinks: card.externalLinks },
      });
      bump();
      return;
    }
    if (result?.unsupported) unsupportedRemoteHosts.add(deviceId);
    else if (!result || result.failed) {
      remoteRetryAt.set(callId, Date.now() + REMOTE_RETRY_MS);
      remoteUnread.set(callId, { deviceId, sessionId });
    }
    // A card already shown keeps its last version when a refresh fails.
    if (current?.status === 'ready' && (!result || result.failed)) return;
    if (current?.status !== 'missing') {
      byCallId.set(callId, { status: 'missing' });
      bump();
    }
  })().finally(() => {
    remoteReads.delete(key);
    const changed = remoteDirty.delete(key);
    if (changed && isDataOwnerGenerationCurrent(owner) && remoteViews.has(remoteSessionKey(deviceId, sessionId)))
      void readRemoteCard(deviceId, sessionId, callId);
  });
  remoteReads.set(key, read);
  return read;
}

function ensureRemoteSubscribed(): void {
  if (remoteSubscribed) return;
  const api = window.electronAPI?.deviceLink;
  if (!api?.onRemotePush) return;
  remoteSubscribed = true;
  api.onRemotePush((push, stamp) => {
    if (push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL || !isDeviceLinkRemotePushCurrent(push, stamp)) return;
    const changed = parseRemoteResourceChangedPayload(push.payload);
    if (changed?.collectionId !== 'plugin-results') return;
    for (const ref of changed.resourceRefs ?? []) {
      if (ref.kind !== 'card') continue;
      let ids: unknown;
      try { ids = JSON.parse(ref.id); } catch { continue; }
      if (!Array.isArray(ids) || ids.length !== 2 || typeof ids[0] !== 'string' || typeof ids[1] !== 'string') continue;
      const [sessionId, callId] = ids as [string, string];
      if (!remoteViews.has(remoteSessionKey(push.deviceId, sessionId))) continue;
      const entry = byCallId.get(callId);
      const reading = remoteReads.has(`${push.deviceId}\n${callId}`);
      const known = entry?.status === 'ready' && entry.remote?.deviceId === push.deviceId && entry.remote.sessionId === sessionId;
      // A click's result appears beside its card (`<root>::sp…`): read it when its root is shown here.
      const root = callId.includes(GHOST_CARD_SPAWN_SEP) ? byCallId.get(ghostCardRootCallId(callId)) : undefined;
      const spawned = !entry && root?.status === 'ready' && root.remote?.deviceId === push.deviceId && root.remote.sessionId === sessionId;
      const unread = remoteUnread.get(callId);
      const retried = unread?.deviceId === push.deviceId && unread.sessionId === sessionId;
      if (known || spawned || retried || reading) void readRemoteCard(push.deviceId, sessionId, callId);
    }
  });
}

/**
 * Card of a task on another computer (idempotent, like ensureCard). Until it is read the tool row
 * stays hidden, as for a local card; a host that cannot provide it leaves the row as before.
 */
export function ensureRemoteCard(deviceId: string, sessionId: string, callId: string): void {
  if (!callId || !deviceId || !sessionId) return;
  const entry = byCallId.get(callId);
  if (remoteReads.has(`${deviceId}\n${callId}`) || entry?.status === 'ready') return;
  // A lookup made on this computer before the task's location was known does not count.
  if (entry?.status === 'missing' && remoteAttempted.has(callId) && (remoteRetryAt.get(callId) ?? Infinity) > Date.now()) return;
  ensureSubscribed();
  ensureRemoteSubscribed();
  if (unsupportedRemoteHosts.has(deviceId)) {
    if (entry?.status !== 'missing') {
      byCallId.set(callId, { status: 'missing' });
      bump();
    }
    return;
  }
  remoteRetryAt.delete(callId);
  remoteAttempted.add(callId);
  if (!entry) byCallId.set(callId, { status: 'loading' });
  void readRemoteCard(deviceId, sessionId, callId);
}

/** Read a shown remote card again (after an action, or when its version was refused). */
export function refreshRemoteCard(callId: string): void {
  const entry = byCallId.get(callId);
  if (entry?.status === 'ready' && entry.remote) void readRemoteCard(entry.remote.deviceId, entry.remote.sessionId, callId);
}

/** 测试专用:清空全部状态(模块级单例,跨用例隔离)。 */
export function __resetGhostCardStoreForTest(): void {
  byCallId.clear();
  liveCards = [];
  version = 0;
  snapshot = { version, byCallId, liveCards };
  listeners.clear();
  subscribed = false;
  loadedSessions.clear();
  unsupportedRemoteHosts.clear();
  remoteRetryAt.clear();
  remoteAttempted.clear();
  remoteUnread.clear();
  remoteReads.clear();
  remoteSubscribed = false;
  remoteViews.clear();
  remoteDirty.clear();
}
