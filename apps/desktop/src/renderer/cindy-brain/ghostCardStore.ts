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

import { GHOST_CARD_SPAWN_SEP } from '../../shared/ghost';

export type GhostCardEntry =
  | {
      status: 'ready';
      ghostId: string;
      /** 静态版(settle 后 / 历史回放)。 */
      html: string;
      /** 动画版(仅推送携带;DB 取件无此字段——历史卡永远静止)。 */
      animatedHtml?: string;
      height: number;
      /** 意识声明的后台活动状态(仅推送携带,card-action 干活场景):
       *  'working' = 过程态卡(衍生卡据此挂运行扫光);DB 取件无此字段——
       *  历史卡永远静止。 */
      state?: 'working' | 'done' | null;
    }
  | { status: 'loading' }
  | { status: 'missing' };

export interface GhostLiveCard {
  callId: string;
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
  byCallId.set(payload.callId, {
    status: 'ready',
    ghostId: payload.ghostId,
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
      i === existing ? { ...c, receivedAt: now } : c,
    );
  } else {
    liveCards = [
      ...liveCards,
      {
        callId: payload.callId,
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
        if (cur?.status === 'ready') continue; // 推送先到,以更新者为准
        byCallId.set(c.callId, { status: 'ready', ghostId: c.ghostId, html: c.html, height: c.height });
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

/** 测试专用:清空全部状态(模块级单例,跨用例隔离)。 */
export function __resetGhostCardStoreForTest(): void {
  byCallId.clear();
  liveCards = [];
  version = 0;
  snapshot = { version, byCallId, liveCards };
  listeners.clear();
  subscribed = false;
  loadedSessions.clear();
}
