/**
 * PrRefsContext — sidebar 会话列表的 PR 引用 / 状态共享缓存(session-git-pr-context)。
 *
 * 设计对标 WorktreeContext:provider 挂 App 顶层,mount 时一次 listAllPrRefs
 * 拉全表建 sessionId → refs 映射(只有出现过 PR 链接的会话才有行,体量小),
 * 之后靠 git-context:pr-refs-changed 推送对单个 session 增量刷新。
 * SessionItem 据此零 IPC 判断"这行有没有 PR"——没有的行不挂任何浮层。
 *
 * ⚠️ 订阅粒度(2026-08-13 review P1 重构;性能不变量,对齐 sessionAttentionStore):
 * context 只传**稳定的 store 引用**,数据变化经 listeners 通知、消费方用
 * useSyncExternalStore 按需取快照——refs 按 sessionId、状态按 prStatusKey,
 * 快照未变(引用/值相等)就不重渲染。此前把整张 Map 当 context value,任何一个
 * 会话的 refs/状态更新都会广播重渲染所有行(SessionItem 的 memo 挡不住 context),
 * 正是 SessionItem 头注明令禁止的"整张表订阅"。
 *   - usePrRefsForSession(sessionId):按会话精准订阅,bulk 加载时逐会话做
 *     内容比对保引用稳定,没变的行不醒。
 *   - usePrStatus(key):单个 PR 徽标按 key 精准订阅(状态对象未变时保引用)。
 *   - usePrStatuses():整表快照,**只给聚合消费方**(打开中的 tooltip、顶栏
 *     单会话视图)——任何状态变化都会重渲染订阅者,列表行禁止用。
 *
 * PR 状态(open/merged/...)是远端易变数据,不在启动期预取;main 侧本就有
 * 60s TTL + in-flight 去重,这里只做轻量去重,不再加 TTL。
 *
 * 引用补齐不变量:已注册消费者的会话,refs 不能只靠 listAllPrRefs 的 2000 行
 * 启动缓存。远程走 device-link list;本机 / SSH 走 listPrRefs(sessionId)。
 * 注册、周期刷新、聚焦刷新共用 refreshConsumer。空结果记 TTL,失败可重试。
 * 全表 merge 必须保住已按会话补到的本机 / SSH 结果,不能只 keep 远程簿记。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { PrStatusResult, SessionPrRef } from '@/lib/gitContext.types';
import { prStatusKey, MAX_STATUS_QUERIES, PR_STATUS_REFRESH_INTERVAL_MS } from '@/lib/prStatus';
import { useAuth } from '@/contexts/AuthContext';
import { isRemoteDeviceMarkedDisconnected } from '@/features/device-link/remoteProjectsStore';
import { createLogger } from '@/lib/logger';

const log = createLogger('PrRefsContext');

const EMPTY_REFS: SessionPrRef[] = [];

/** 同一会话的引用列表内容未变 → 复用旧数组引用(逐行订阅的快照比较基石)。 */
function sameRefList(
  a: SessionPrRef[] | undefined,
  b: readonly SessionPrRef[],
): a is SessionPrRef[] {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || a[i].lastSeenAt !== b[i].lastSeenAt) return false;
  }
  return true;
}

/** 同一 PR 的状态结果未变 → 保留旧对象引用(徽标按 key 订阅不醒)。
 *  小对象、量有界(可见徽标数),序列化比较足够便宜且对 shape 演进稳健。 */
function sameStatus(a: PrStatusResult | undefined, b: PrStatusResult): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Provider 内部的可变缓存 + 订阅簇。listeners 在任何写入后统一通知,粒度由
 * 各 hook 的 getSnapshot 决定(useSyncExternalStore 按快照相等性裁剪重渲染)。
 */
interface PrCacheStore {
  subscribe: (listener: () => void) => () => void;
  getRefs: (sessionId: string) => SessionPrRef[];
  getStatus: (key: string) => PrStatusResult | undefined;
  /** 整表快照(引用仅在状态真实变化时更换)——聚合消费方专用。 */
  getStatusesSnapshot: () => ReadonlyMap<string, PrStatusResult>;
  /** 本地全量加载:整表替换,但保住 keep 判定为真的既有条目(远程先到的)与未变引用。 */
  mergeLocalRefs: (
    grouped: Map<string, SessionPrRef[]>,
    keep: (sessionId: string) => boolean,
  ) => void;
  /** 单会话 refs 覆盖(空列表 = 删除)。内容未变不通知。 */
  setSessionRefs: (sessionId: string, refs: readonly SessionPrRef[]) => void;
  /** 批量落状态结果。全部未变不通知。 */
  applyStatuses: (results: readonly PrStatusResult[]) => void;
  clearAll: () => void;
}

function createPrCacheStore(): PrCacheStore {
  const refsBySession = new Map<string, SessionPrRef[]>();
  const statuses = new Map<string, PrStatusResult>();
  let statusesSnapshot: ReadonlyMap<string, PrStatusResult> = new Map();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getRefs(sessionId) {
      return refsBySession.get(sessionId) ?? EMPTY_REFS;
    },
    getStatus(key) {
      return statuses.get(key);
    },
    getStatusesSnapshot() {
      return statusesSnapshot;
    },
    mergeLocalRefs(grouped, keep) {
      let changed = false;
      // 覆盖/新增本地条目(内容未变时保旧引用)。
      for (const [sessionId, refs] of grouped) {
        const prev = refsBySession.get(sessionId);
        if (sameRefList(prev, refs)) continue;
        refsBySession.set(sessionId, refs);
        changed = true;
      }
      // 清掉既不在本次全量、也不该保留(非远程簿记)的旧条目。
      for (const sessionId of [...refsBySession.keys()]) {
        if (grouped.has(sessionId) || keep(sessionId)) continue;
        refsBySession.delete(sessionId);
        changed = true;
      }
      if (changed) notify();
    },
    setSessionRefs(sessionId, refs) {
      if (refs.length === 0) {
        if (!refsBySession.delete(sessionId)) return;
        notify();
        return;
      }
      const prev = refsBySession.get(sessionId);
      if (sameRefList(prev, refs)) return;
      refsBySession.set(sessionId, [...refs]);
      notify();
    },
    applyStatuses(results) {
      let changed = false;
      for (const result of results) {
        const key = prStatusKey(result);
        const prev = statuses.get(key);
        // 本机成功与远端 no-token/not-found 会写同一把 PR 键。失败结果不得覆盖
        // 已有成功态,否则徽标会随两端轮询来回降级。
        if (prev?.ok === true && result.ok === false) continue;
        if (sameStatus(prev, result)) continue;
        statuses.set(key, result);
        changed = true;
      }
      if (!changed) return;
      statusesSnapshot = new Map(statuses);
      notify();
    },
    clearAll() {
      if (refsBySession.size === 0 && statuses.size === 0) return;
      refsBySession.clear();
      statuses.clear();
      statusesSnapshot = new Map();
      notify();
    },
  };
}

/** Provider 外(测试等)兜底:惰性 store,永远空、永远不通知。 */
const INERT_STORE = createPrCacheStore();
const PrStoreContext = createContext<PrCacheStore>(INERT_STORE);

/**
 * 行级动作 context——value 恒定(回调身份稳定,无状态字段),SessionItem /
 * SessionCard 可以安全订阅而不被 statuses 更新连带重渲染(文件头性能边界)。
 * device-link 远程会话的 PR 引用不在本地 db(listAllPrRefs 看不见它们),
 * 由渲染中的行按需经远程通道补拉,落进同一张 refs 缓存。
 */
interface PrActionsContextValue {
  /**
   * 行级注册:声明「这一行正在展示 PR 信息」(SessionItem / SessionCard 在
   * 勾选 pr 且行渲染时调用,返回注销函数挂 effect cleanup)。注册即触发一次
   * 拉取,此后 Provider 以与聊天顶栏同一节拍(PR_STATUS_REFRESH_INTERVAL_MS)
   * + 窗口聚焦统一刷新全部已注册会话——首查失败(device-link 慢/断、gh 限流、
   * token 未就绪)由下个周期自愈,对齐顶栏行为,不再"拉一次定终身"。
   *
   * 远程(device-link)会话:引用经白名单通道 git-context:pr-refs:list 补拉
   * (成功后不重复;失败随周期重试),并登记 sessionId→deviceId,状态查询自动
   * 走 git-context:pr-status 远程路由。注册数被列表 collapse 上限约束,main /
   * 被控端各有 60s TTL,周期刷新的实际开销有界。
   */
  registerPrConsumer: (sessionId: string, deviceId?: string) => () => void;
  /** tip 打开时按需拉该会话前几条 PR 的状态(共享缓存,重复调用便宜)。 */
  fetchStatusesForSession: (sessionId: string) => void;
}

const PrActionsContext = createContext<PrActionsContextValue>({
  registerPrConsumer: () => () => undefined,
  fetchStatusesForSession: () => undefined,
});

function groupBySession(rows: SessionPrRef[]): Map<string, SessionPrRef[]> {
  const map = new Map<string, SessionPrRef[]>();
  for (const row of rows) {
    const list = map.get(row.sessionId);
    if (list) list.push(row);
    else map.set(row.sessionId, [row]);
  }
  return map; // listAllPrRefs 已按 lastSeenAt 降序,组内顺序天然正确
}

export function PrRefsProvider({ children }: { children: ReactNode }) {
  // 同进程切换 data owner → 另一份本地 db。云账号和本地模式都以 owner id
  // 为 key 重跑，先清旧缓存，再从新 owner 的库重新全量加载。
  const { dataOwnerId } = useAuth();
  const storeRef = useRef<PrCacheStore | null>(null);
  if (storeRef.current === null) storeRef.current = createPrCacheStore();
  const store = storeRef.current;
  // owner 代数:owner 切换时自增。异步闭包(远程隧道 / GitHub 查询)在发起时
  // 捕获当时代数,回来后对不上就整体丢弃——否则旧账号的响应会回写进新账号的
  // 共享缓存(2026-08-13 review P1:此前只清 Map,不隔离在飞请求)。
  const ownerGenRef = useRef(0);
  // 在飞去重表:sessionId → 发起时代数(main 侧有 60s 缓存,这里不做 TTL)。
  // 记代数而非裸集合(2026-08-13 复核 P1):只有**同代**在飞才挡新请求——旧代
  // 请求可能要等到超时(远程默认 ~30s)才 settle,裸集合会让新 owner 的首查被
  // 旧 owner 的尸体挡住;finally 释放也按代数身份匹配,旧请求 settle 不误删新
  // 请求刚登记的标记。
  const inFlightSessions = useRef(new Map<string, number>());
  // 远程会话引用拉取:在飞去重(同上,带代数)+ 上次**成功**时间戳(TTL 门)。
  // 空结果不是终态——远端没有 pr-refs-changed 推送,被控端后来新增的 PR 只能靠
  // 周期重查发现;失败不写时间戳,下一次触发(interval / 聚焦 / 行重挂载)立即重试。
  // (2026-08-12 实机教训:此前用"已拉取过"永久集合兼任在飞守卫,一次空结果或
  // 时序竞态就让该会话永远静默,置顶重挂载也救不回来。)
  const remoteRefsInFlight = useRef(new Map<string, number>());
  const remoteRefsFetchedAt = useRef(new Map<string, number>());
  // 本机 / SSH 引用按会话回退:listAllPrRefs 有 2000 行上限,截断后的会话
  // 不会出现在启动缓存里。已注册消费者必须能走 listPrRefs(sessionId) 补齐,
  // 与远程 fetchRefsForRemoteSession 对称(2026-08-13 review P1)。
  const localRefsInFlight = useRef(new Map<string, number>());
  const localRefsFetchedAt = useRef(new Map<string, number>());
  const remoteDeviceBySession = useRef(new Map<string, string>());
  // 正在展示 PR 信息的会话(sessionId → {deviceId?, count})。顶栏(打开的会话)
  // 与侧栏行(勾选 pr)都注册到这里;引用计数支持同一会话多处并存。refs 异步
  // 到位(全量加载 / 远程补拉 / 引用变化推送)后,对注册中的会话立即补状态查询。
  const prConsumers = useRef(new Map<string, { deviceId?: string; count: number }>());

  // owner 边界判定:首挂载**不清**——React 子 effect 先于父 effect 运行,行组件的
  // 注册与远程簿记(remoteDeviceBySession 等)此时已写入,首挂载清空会把它们连同
  // 全量加载的合并保护一起打掉(实测:状态查询错落到本地路径)。只有 owner 真正
  // 切换(上一个值存在且不同)才需要丢弃上一账号的缓存。
  const prevOwnerRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prevOwner = prevOwnerRef.current;
    prevOwnerRef.current = dataOwnerId;
    if (prevOwner !== undefined && prevOwner !== dataOwnerId) {
      // owner 切换边界:作废在飞请求(代数自增——两张在飞表记着代数,旧代条目
      // 既不挡新代首查、settle 时也只能删自己的标记,无需在这里清)、清缓存与
      // 远程簿记(prConsumers 保留——行组件仍挂着,新 owner 下由周期刷新按注册
      // 表重建缓存)。
      ownerGenRef.current += 1;
      store.clearAll();
      remoteRefsFetchedAt.current.clear();
      localRefsFetchedAt.current.clear();
      remoteDeviceBySession.current.clear();
    }
    if (dataOwnerId === null) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Provider 挂 App 顶层,首次加载通常早于登录后的 db ensureReady——
    // main 返回 null(未就绪)或抛错时定时重试,直到拿到数据为止。
    const RETRY_MS = 2_000;
    const scheduleRetry = () => {
      if (cancelled) return;
      retryTimer = setTimeout(() => void load(), RETRY_MS);
    };
    const load = async () => {
      try {
        const rows = await window.electronAPI.gitContext.listAllPrRefs();
        if (cancelled) return;
        if (rows === null) {
          scheduleRetry();
          return;
        }
        // 合并而非整体替换:listAllPrRefs 只覆盖本地会话;远程(device-link)会话
        // 的条目可能已先一步拉到,整体替换会把它们冲掉(启动时序竞态)。
        // 本机 / SSH 按会话回退同样可能先于全表返回——keep 也要保住这些已注册
        // 消费者,否则截断会话的补拉结果会被清掉,TTL 再压 85s(2026-08-13 P1)。
        const grouped = groupBySession(rows);
        store.mergeLocalRefs(
          grouped,
          (sid) =>
            remoteDeviceBySession.current.has(sid) ||
            (prConsumers.current.has(sid) && !grouped.has(sid)),
        );
        // 已注册消费者(顶栏/侧栏正在展示的会话)拿到引用后立即补状态,
        // 不等 90s 周期——覆盖「先注册、后加载完成」的启动时序。
        for (const [sid, entry] of prConsumers.current) {
          const refs = grouped.get(sid);
          if (refs) {
            fetchStatusesForRefs(sid, refs);
            continue;
          }
          // 全表截断 / 本就没有行:已注册的本机消费者按会话补拉。
          if (!entry.deviceId) fetchRefsForLocalSession(sid);
        }
      } catch (err) {
        log.warn('pr refs load failed, will retry', String(err));
        scheduleRetry();
      }
    };
    void load();

    const unsubscribe = window.electronAPI.gitContext.onPrRefsChanged((data) => {
      void (async () => {
        try {
          const refs = await window.electronAPI.gitContext.listPrRefs(data.sessionId);
          if (cancelled) return;
          store.setSessionRefs(data.sessionId, refs);
          // 该会话有消费者在展示(顶栏/侧栏徽标)→ 引用变化后立即刷状态,
          // 不等 90s 周期(对齐顶栏旧行为:引用变化即时补状态)。
          if (refs.length > 0 && prConsumers.current.has(data.sessionId)) {
            fetchStatusesForRefs(data.sessionId, refs);
          }
        } catch (err) {
          log.warn('pr refs refresh failed', String(err));
        }
      })();
    });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store / fetchStatusesForRefs 均为稳定引用
  }, [dataOwnerId]);

  // 回调身份稳定(空闭包依赖):refs 显式传入或经 store 读,状态写回也走 store。
  // 远程会话(remoteDeviceBySession 命中)状态改走 device-link 通道
  // ——被控端持有 gh token,且 main 侧按该会话已提取的引用过滤查询
  // (git-context/ipc.ts 的 fail-closed 逻辑),与聊天顶栏同一条安全路径。
  const fetchStatusesForRefs = useRef((sessionId: string, refsInput: readonly SessionPrRef[]) => {
    const refs = refsInput.slice(0, MAX_STATUS_QUERIES);
    if (refs.length === 0) return;
    const gen = ownerGenRef.current;
    // 同代在飞才挡;旧代尸体(等超时中)不能挡新 owner 的首查,直接覆盖标记。
    if (inFlightSessions.current.get(sessionId) === gen) return;
    inFlightSessions.current.set(sessionId, gen);
    void (async () => {
      try {
        const queries = refs.map((r) => ({ owner: r.owner, repo: r.repo, prNumber: r.prNumber }));
        // 远程路由的 deviceId 兜底顺序:簿记表 → 消费者注册表(owner 切换清簿记后,
        // 注册表仍保有 deviceId,避免远程会话错落到本机查询)。
        const deviceId =
          remoteDeviceBySession.current.get(sessionId) ??
          prConsumers.current.get(sessionId)?.deviceId;
        // 设备明确断线时不发注定失败的隧道调用(fail-open:shard 缺失照常尝试)。
        // 不写任何状态,重连后的下一个触发点(周期 / 聚焦 / 引用到位)自然恢复。
        if (deviceId && isRemoteDeviceMarkedDisconnected(deviceId)) return;
        const results = deviceId
          ? ((await window.electronAPI.deviceLink.invoke(deviceId, 'git-context:pr-status', [
              { sessionId, queries },
            ])) as PrStatusResult[])
          : await window.electronAPI.gitContext.getPrStatuses(queries);
        if (gen !== ownerGenRef.current) return; // owner 已切换:旧账号结果整体丢弃
        if (!Array.isArray(results)) return;
        store.applyStatuses(results);
      } catch (err) {
        log.warn('pr statuses fetch failed', String(err));
      } finally {
        // 身份匹配释放:标记可能已被新代请求覆盖,旧请求 settle 不得误删。
        if (inFlightSessions.current.get(sessionId) === gen) {
          inFlightSessions.current.delete(sessionId);
        }
      }
    })();
  }).current;

  const fetchStatusesForSession = useRef((sessionId: string) => {
    fetchStatusesForRefs(sessionId, store.getRefs(sessionId));
  }).current;

  // 远程会话 PR 引用按需拉取(回调身份稳定)。结果进共享 refs 缓存,渲染路径
  // (usePrRefsForSession)对本地/远程一视同仁。空结果同样写入 TTL 时间戳,
  // 但**不是终态**:下个周期重查(远端新增 PR / 短暂竞态都靠这条自愈)。
  const fetchRefsForRemoteSession = useRef((sessionId: string, deviceId: string) => {
    remoteDeviceBySession.current.set(sessionId, deviceId);
    // 设备明确断线 → 跳过(簿记保留,供状态查询路由)。此前失败路径刻意不写时间戳
    // 以便瞬断立即重试,但长离线下就成了每个周期一轮注定失败的隧道调用 + 告警日志;
    // 断线判定本地同步可得,先看一眼再发(2026-08-13 用户裁决)。fail-open:
    // shard 缺失(尚未建立 / 设备已移除)照常尝试,语义见 isRemoteDeviceMarkedDisconnected。
    if (isRemoteDeviceMarkedDisconnected(deviceId)) return;
    const gen = ownerGenRef.current;
    // 同代在飞才挡(见 inFlightSessions 注释)。
    if (remoteRefsInFlight.current.get(sessionId) === gen) return;
    // TTL 门:距上次成功不足一个刷新周期就跳过(interval / 聚焦 / 行重挂载都会
    // 频繁触发,靠它避免风暴);失败路径不写时间戳,天然立即可重试。
    const fetchedAt = remoteRefsFetchedAt.current.get(sessionId);
    if (fetchedAt !== undefined && Date.now() - fetchedAt < PR_STATUS_REFRESH_INTERVAL_MS - 5_000)
      return;
    remoteRefsInFlight.current.set(sessionId, gen);
    void (async () => {
      try {
        const refs = (await window.electronAPI.deviceLink.invoke(
          deviceId,
          'git-context:pr-refs:list',
          [sessionId],
        )) as SessionPrRef[];
        // owner 已切换:结果与簿记(时间戳会抑制新 owner 的重查)都不能落。
        if (gen !== ownerGenRef.current) return;
        remoteRefsFetchedAt.current.set(sessionId, Date.now());
        log.debug('remote pr refs fetched', { sessionId, count: refs.length });
        store.setSessionRefs(sessionId, refs);
        // 该会话仍有消费者在展示 → 引用到位后立即补状态,不等 90s 周期
        // (顶栏没有徽标挂载 effect,只读缓存,必须由这里主动触发)。
        if (refs.length > 0 && prConsumers.current.has(sessionId)) {
          fetchStatusesForRefs(sessionId, refs);
        }
      } catch (err) {
        // 断链/超时:不写时间戳,下个刷新周期(或行重挂载)立即重试。
        log.warn('remote pr refs fetch failed', String(err));
      } finally {
        // 身份匹配释放(同 inFlightSessions):旧代请求 settle 不得误删新代标记。
        if (remoteRefsInFlight.current.get(sessionId) === gen) {
          remoteRefsInFlight.current.delete(sessionId);
        }
      }
    })();
  }).current;

  const fetchRefsForLocalSession = useRef((sessionId: string) => {
    // 启动全表已经命中的会话不必再打 IPC;缺席才按会话回退。
    if (store.getRefs(sessionId).length > 0) return;
    const gen = ownerGenRef.current;
    if (localRefsInFlight.current.get(sessionId) === gen) return;
    const fetchedAt = localRefsFetchedAt.current.get(sessionId);
    if (fetchedAt !== undefined && Date.now() - fetchedAt < PR_STATUS_REFRESH_INTERVAL_MS - 5_000) {
      return;
    }
    localRefsInFlight.current.set(sessionId, gen);
    void (async () => {
      try {
        const refs = await window.electronAPI.gitContext.listPrRefs(sessionId);
        if (gen !== ownerGenRef.current) return;
        localRefsFetchedAt.current.set(sessionId, Date.now());
        store.setSessionRefs(sessionId, refs);
        if (refs.length > 0 && prConsumers.current.has(sessionId)) {
          fetchStatusesForRefs(sessionId, refs);
        }
      } catch (err) {
        log.warn('local pr refs fetch failed', String(err));
      } finally {
        if (localRefsInFlight.current.get(sessionId) === gen) {
          localRefsInFlight.current.delete(sessionId);
        }
      }
    })();
  }).current;

  const refreshConsumer = useRef((sessionId: string, deviceId?: string) => {
    // 远程行:引用可能还没拉到(或上次失败)——先补引用,再查状态。
    // 本机 / SSH:全表缓存截断后同样先按会话补引用。两边成功后幂等,
    // fetchStatusesForSession 无引用时早退。
    if (deviceId) fetchRefsForRemoteSession(sessionId, deviceId);
    else fetchRefsForLocalSession(sessionId);
    fetchStatusesForSession(sessionId);
  }).current;

  const registerPrConsumer = useRef((sessionId: string, deviceId?: string) => {
    const map = prConsumers.current;
    const entry = map.get(sessionId);
    if (entry) {
      entry.count += 1;
      if (deviceId) entry.deviceId = deviceId;
    } else {
      map.set(sessionId, { deviceId, count: 1 });
    }
    refreshConsumer(sessionId, deviceId);
    return () => {
      const cur = map.get(sessionId);
      if (!cur) return;
      if (cur.count <= 1) map.delete(sessionId);
      else cur.count -= 1;
    };
  }).current;

  // 与聊天顶栏同一节拍的兜底刷新:周期 + 窗口聚焦。首查失败自愈;merged/closed
  // 等远端状态变化也随节拍收敛(main / 被控端各有 60s TTL,重复查询便宜)。
  useEffect(() => {
    const refreshAll = () => {
      // 失焦/隐藏时跳过周期刷新:没人在看,后台空转的查询(GitHub 配额 +
      // device-link 隧道)纯属浪费;下面的 focus 监听会在回到前台的瞬间全量补一次,
      // 数据不会停留在过期态(2026-08-13 用户裁决)。focus 事件触发的调用天然
      // 通过本判断(事件发生时已聚焦)。
      if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) return;
      for (const [sessionId, entry] of prConsumers.current) {
        refreshConsumer(sessionId, entry.deviceId);
      }
    };
    const interval = setInterval(refreshAll, PR_STATUS_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshAll);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refreshAll);
    };
  }, [refreshConsumer]);

  const actionsValue = useMemo(
    () => ({ registerPrConsumer, fetchStatusesForSession }),
    [registerPrConsumer, fetchStatusesForSession],
  );

  return (
    <PrStoreContext.Provider value={store}>
      <PrActionsContext.Provider value={actionsValue}>{children}</PrActionsContext.Provider>
    </PrStoreContext.Provider>
  );
}

/** 某会话的 PR 引用(无则空数组,内容未变时引用稳定)。其它会话的更新不触发重渲染。 */
export function usePrRefsForSession(sessionId: string): SessionPrRef[] {
  const store = useContext(PrStoreContext);
  return useSyncExternalStore(
    store.subscribe,
    () => store.getRefs(sessionId),
    () => store.getRefs(sessionId),
  );
}

/** 单个 PR 的状态(按 prStatusKey 精准订阅;结果未变时引用稳定)。列表行徽标专用。 */
export function usePrStatus(key: string): PrStatusResult | undefined {
  const store = useContext(PrStoreContext);
  return useSyncExternalStore(
    store.subscribe,
    () => store.getStatus(key),
    () => store.getStatus(key),
  );
}

interface PrStatusesContextValue {
  /** prStatusKey(ref) → 状态查询结果(整表快照)。 */
  statuses: ReadonlyMap<string, PrStatusResult>;
  fetchStatusesForSession: (sessionId: string) => void;
}

/** 整表状态消费:**只给聚合消费方**(打开中的 tooltip、顶栏单会话视图)——任何
 *  状态变化都会重渲染订阅者。列表行禁止用(改用 usePrStatus)。 */
export function usePrStatuses(): PrStatusesContextValue {
  const store = useContext(PrStoreContext);
  const { fetchStatusesForSession } = useContext(PrActionsContext);
  const statuses = useSyncExternalStore(
    store.subscribe,
    store.getStatusesSnapshot,
    store.getStatusesSnapshot,
  );
  return useMemo(
    () => ({ statuses, fetchStatusesForSession }),
    [statuses, fetchStatusesForSession],
  );
}

/** 行级动作(value 恒定,订阅不会因 refs/statuses 更新而重渲染)。 */
export function usePrActions(): PrActionsContextValue {
  return useContext(PrActionsContext);
}
