/**
 * useDeviceLinkRemoteProjects —— device-link「自动常驻」接入器(listing tier,push 驱动)。
 * ---------------------------------------------------------------------------
 * 每个窗口各挂一次(remoteProjectsStore 是「每渲染进程一份」的模块级单例,窗口间不共享
 * 内存,故副窗口也得自己镜像一份,否则侧边栏看不到远程项目)。职责:把**同账号 + 在线 +
 * 开了「允许被控」**的设备的会话列表镜像进 remoteProjectsStore → 侧边栏自然出现这些设备的
 * 远程项目(带设备 icon)。
 *
 * 多窗口订阅安全:每个窗口独立 `subscribe`,主进程按窗口对 (deviceId, topic) 引用计数
 * (见 main/device-link/subscriptionRefcount.ts),最后一个窗口释放才真正向 relay
 * unsubscribe —— 关一个窗口不会拆掉其它窗口还在用的订阅。push 本就广播给所有窗口。
 *
 * 控制端纯镜像(被控端 = 单一真相源):
 *  - 设备变合格 → `subscribe(['sessions'])`(订阅被控端会话列表读模型变更)+ **bootstrap 拉一次**
 *    全量(reconcile 规则:先 subscribe 再 snapshot,中间窗口的增量由 push 兜)。
 *  - 之后被控端的 `sessions:patched`(改名/置顶/删/归档/设置)经 push → makerChatStore 路由到
 *    remoteProjectsStore.applyPatch;`sessions:created`(无 row 数据)→ 防抖重拉该设备。
 *  - push 是低延迟主路径；另以低频有界 snapshot 做 anti-entropy，更新窗口内权威状态；
 *    满窗口时保留缺席行并有界轮询其终态，避免误删仍有效的窗口外会话，也让丢失的归档/删除
 *    push 最终收敛。
 *  - 设备瞬时不可达(下线 / relay connecting)→ 保留最近一次快照并标记 disconnected;
 *    明确不合格(关被控 / 被撤销 / 本机禁用控制)→ `unsubscribe` + removeDevice。
 *  - WS 重连 → 对每个合格设备重新 subscribe + 重新 bootstrap(被控端可能重启过、订阅 registry 清空)。
 *
 * 不在本地落库(被控端 DB 才是数据真相);登出 / stopped / 卸载即清空内存镜像。
 *
 * 唯一的盘上痕迹是**非权威冷缓存**:列表快照落在 main 的 userData
 * (`main/device-link/mirrorCacheStore.ts`),仅用于冷启动首屏 —— mount 时
 * `hydrateFromCache` 把上次看到的行画出来并标 disconnected,bootstrap 一到即整片替换;
 * 设备明确离场(撤销 / 关被控 / 禁用控制)时连它的缓存一起清。整棵缓存的删除归 owner
 * 边界(main 的 teardownAuthAccountBoundary),这里只负责作废未落盘的回写。
 */

import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { createLogger } from '@/lib/logger';
import {
  remoteProjectsStore,
  setRemoteReseedImpl,
  setRemoteSessionBootstrapRetryImpl,
} from './remoteProjectsStore';
import {
  clearRemoteSessionActivity,
  removeRemoteSessionActivityForDevice,
} from './remoteSessionActivityStore';
import { revokedDevicesStore } from './revokedDevicesStore';
import { unresponsiveDevicesStore } from './unresponsiveDevicesStore';
import { collectSessionListSnapshot, refreshRemoteDeviceSessions } from './refreshRemoteSessions';
import {
  cancelSessionListPersist,
  clearCachedDevice,
  clearMirrorCacheAccountState,
  readCachedSessionList,
  scheduleSessionListPersist,
  sessionListOwnerTokensReady,
} from './mirrorCacheClient';
import { prefetchDeviceCapabilities, evictDeviceCapabilities } from '@/hooks/useAgentCapabilities';
import { prefetchDeviceProviders, evictDeviceProviders } from '@/hooks/useDeviceProviders';
import {
  evictDeviceGitSafetySettings,
  prefetchDeviceGitSafetySettings,
} from '@/hooks/useGitSafetySettings';
import { extractIpcError } from '@/utils/ipcError';

const log = createLogger('device-link-remote-projects');

/** session-list owner 令牌补读退避:不断恢复,但长期故障时不每 2 秒打一次 IPC。 */
const SESSION_LIST_TOKEN_RETRY_BASE_MS = 2_000;
const SESSION_LIST_TOKEN_RETRY_MAX_MS = 30_000;

/** 返回下一次列表令牌补读的等待时间;账号边界 effect 重建时从 0 重新开始。 */
export function nextSessionListTokenRetryDelay(previousMs: number): number {
  if (!Number.isFinite(previousMs) || previousMs < SESSION_LIST_TOKEN_RETRY_BASE_MS) {
    return SESSION_LIST_TOKEN_RETRY_BASE_MS;
  }
  return Math.min(previousMs * 2, SESSION_LIST_TOKEN_RETRY_MAX_MS);
}

/**
 * 启动 session-list owner 令牌补读循环。返回清理函数;账号边界 effect 每次重建都会创建新的
 * retryDelayMs,因此新账号从 2 秒重新开始,旧账号的 timer 由 cleanup 取消。
 * 参数只用于确定性单测;生产默认走真实缓存读与 readiness。
 */
export function startSessionListTokenRefresh(
  refresh: () => Promise<unknown> = readCachedSessionList,
  isReady: () => boolean = sessionListOwnerTokensReady,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = 0;
  const refreshUntilReady = async (): Promise<void> => {
    if (cancelled) return;
    await refresh();
    if (cancelled) return;
    if (!isReady()) {
      // 不能设最大次数后永久停掉:此前正是一次补读失败后不恢复,让列表缓存持续停写。
      // 保留无限恢复能力,只把长期故障下的频率从固定 2s 指数退避到最多 30s
      // (review: copilot suppressed)。
      retryDelayMs = nextSessionListTokenRetryDelay(retryDelayMs);
      timer = setTimeout(refreshUntilReady, retryDelayMs);
    }
  };
  void refreshUntilReady();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/** sessions:created reseed 防抖(被控端短时间多次创建会话 / orca 起多 worker 时合并重拉)。 */
const RESEED_DEBOUNCE_MS = 300;

/** best-effort push 的窗口内 anti-entropy 周期。窗口外终态按有界轮询分批收敛。 */
const RECONCILE_INTERVAL_MS = 10_000;

/** 连续失败退避封顶:失败设备最低仍保持约 2 分钟一次的对账,恢复靠 push / 熔断探测先行。 */
const RECONCILE_BACKOFF_MAX_MS = 120_000;

type RemoteSessionsRefresh = (deviceId: string, name?: string) => Promise<unknown>;

/**
 * per-device 对账退避账本(纯逻辑,可单测)。
 *
 * 弱网教训(2026-08):固定 10s 无退避的对账循环在链路劣化时永不放慢,叠加超时重试
 * 变成请求风暴。这里按设备记连续失败:失败后下一次尝试推迟 base×2^(n-1)(封顶 maxMs,
 * ±15% 抖动打散多设备齐步),成功即复位;'superseded' / 'revoked' 不计失败——前者是
 * 并发合并的正常路径,后者有自己的终态处理。
 */
export function createReconcileBackoff(opts?: {
  baseMs?: number;
  maxMs?: number;
  /** 抖动注入(测试用;默认 ±15% 随机)。 */
  jitter?: (delayMs: number) => number;
  now?: () => number;
}) {
  const baseMs = opts?.baseMs ?? RECONCILE_INTERVAL_MS;
  const maxMs = opts?.maxMs ?? RECONCILE_BACKOFF_MAX_MS;
  const jitter =
    opts?.jitter ?? ((delay: number) => Math.round(delay * (0.85 + Math.random() * 0.3)));
  const now = opts?.now ?? Date.now;
  const state = new Map<string, { failures: number; nextEligibleAt: number }>();
  return {
    /** 本 tick 是否应该对该设备发起对账。 */
    shouldAttempt(deviceId: string): boolean {
      const entry = state.get(deviceId);
      return !entry || now() >= entry.nextEligibleAt;
    },
    /** 上报一次对账结果。failure 加深退避,success 复位,neutral 不动。 */
    report(deviceId: string, outcome: 'success' | 'failure' | 'neutral'): void {
      if (outcome === 'neutral') return;
      if (outcome === 'success') {
        state.delete(deviceId);
        return;
      }
      const failures = (state.get(deviceId)?.failures ?? 0) + 1;
      const delay = Math.min(baseMs * 2 ** (failures - 1), maxMs);
      // 抖动后再 clamp:maxMs 是硬封顶(review:+15% 抖动曾把封顶档放大到 138s),
      // 负值防御性归零。
      const jittered = Math.min(Math.max(0, jitter(delay)), maxMs);
      state.set(deviceId, { failures, nextEligibleAt: now() + jittered });
    },
    /** 只保留仍合格的设备,防止退避账本随设备增删无界增长。 */
    retainOnly(deviceIds: ReadonlySet<string>): void {
      for (const deviceId of state.keys()) {
        if (!deviceIds.has(deviceId)) state.delete(deviceId);
      }
    },
  };
}

export type ReconcileBackoff = ReturnType<typeof createReconcileBackoff>;

/**
 * 启动 listing tier 的低频有界对账。setInterval 只负责触发；每设备的并发合并与乱序保护
 * 继续由 refreshRemoteDeviceSessions 负责；连续失败的设备按 createReconcileBackoff 放慢
 * (refresh resolve 出的 RefreshResult 用于记账:'gave-up' = 失败,'ok' = 成功,其余中性;
 * reject 一律计失败)。返回清理函数，避免窗口卸载后残留 timer。
 */
export function startRemoteSessionsReconciler(
  getEligibleDevices: () => Iterable<readonly [string, string]>,
  refresh: RemoteSessionsRefresh = refreshRemoteDeviceSessions,
  intervalMs = RECONCILE_INTERVAL_MS,
  backoff: ReconcileBackoff = createReconcileBackoff({ baseMs: intervalMs }),
): () => void {
  // 单次刷新可能横跨多个 tick(弱网下超时链 >10s);weak coalescing 会让后续 tick 拿到
  // 同一个在途 Promise,若每个 tick 都挂 then,一次 gave-up 会被重复记账、退避直接跳档
  // (review P2)。per-device 在途标记保证一次合并请求只记一次。
  const inFlight = new Set<string>();
  const timer = setInterval(() => {
    const seen = new Set<string>();
    for (const [deviceId, name] of getEligibleDevices()) {
      seen.add(deviceId);
      if (inFlight.has(deviceId) || !backoff.shouldAttempt(deviceId)) continue;
      inFlight.add(deviceId);
      void refresh(deviceId, name)
        .then((result) => {
          backoff.report(
            deviceId,
            result === 'gave-up' ? 'failure' : result === 'ok' ? 'success' : 'neutral',
          );
        })
        .catch((err) => {
          backoff.report(deviceId, 'failure');
          log.debug(`periodic sessions reconcile failed for ${deviceId.slice(0, 8)}`, err);
        })
        .finally(() => {
          inFlight.delete(deviceId);
        });
    }
    backoff.retainOnly(seen);
  }, intervalMs);
  return () => {
    clearInterval(timer);
    inFlight.clear();
  };
}

type IneligibleRemoteProjectAction = 'disconnect' | 'remove' | 'ignore';

export function resolveIneligibleRemoteProjectAction(input: {
  wasEligible: boolean;
  hasCachedShard: boolean;
  isSelf: boolean;
  online: boolean;
  remoteControlEnabled: boolean;
  disabledControl: boolean;
}): IneligibleRemoteProjectAction {
  if (!input.wasEligible && !input.hasCachedShard) return 'ignore';
  if (input.isSelf || input.disabledControl) return 'remove';
  // Offline rows can report remoteControlEnabled=false even when the peer did not explicitly disable
  // remote control. Treat that as a transient disconnect; only an online false bit is authoritative.
  if (!input.online) return 'disconnect';
  if (!input.remoteControlEnabled) return 'remove';
  return 'remove';
}

export function useDeviceLinkRemoteProjects(): void {
  const { isAuthenticated, deviceId: selfDeviceId, dataOwnerId } = useAuth();

  // 账号边界真正由 dataOwnerId 界定:登出 / 切账号都必然改变它。**不能只靠 !isAuthenticated** ——
  // 运行时替换刷新路径可以在不经过 signed-out 的情况下直接把新 owner 发布出来,那时本 effect
  // 若只依赖 isAuthenticated / deviceId 不会重跑,旧的 owner token 残留会一直传给 store 被
  // fail-closed 拒写,新账号冷缓存停止更新直到重挂载(review: codex P1)。因此单独挂一个
  // dataOwnerId 依赖的 effect,owner 一换就清 mirror 状态。
  // dataOwnerId 是 owner 边界的真源(runtime 替换刷新可跳过 signed-out 直接换 owner)。
  const ownerBoundaryGeneration = `${dataOwnerId ?? ''}`;
  useEffect(() => {
    clearMirrorCacheAccountState();
    // 清完必须**主动补读 session-list** 直到拿到新账号的 owner 锚点:
    //  1. 主 effect 只依赖 isAuthenticated / selfDeviceId,A→B 直接切换(两者都不变)时不会
    //     重跑,而读 session-list 的调用挂在主 effect 里 —— 不补读的话 B 的排程回写会一直
    //     带 undefined 被 main fail-closed 丢弃(review: Greptile P1);
    //  2. 补读可能因待清队列 / owner 边界复核 / 瞬时 IPC 错误失败,失败后**重试**直到锚点
    //     就位 —— 否则订阅仍持续排程 undefined 写入,冷缓存停写到重挂载(本线程)。
    // 账号在重试期间再次变化时,effect 重跑清掉定时器,旧账号的重试不再继续。
    if (!dataOwnerId) return;
    return startSessionListTokenRefresh();
  }, [ownerBoundaryGeneration]);

  useEffect(() => {
    if (!isAuthenticated || !selfDeviceId) {
      // 同 'stopped' / unmount:cancel 在 clear 之后,免得 clear 的同步通知又排一次回写。
      remoteProjectsStore.clear();
      cancelSessionListPersist();
      // 登出分支:上面的 dataOwnerId effect 已清 mirror 状态,这里补 cancel 去抖回写。
      return;
    }

    let disposed = false;
    /**
     * 「已明确离场、不许被冷缓存种回来」的设备 id。撤销访问 / 关闭被控 / 本机停用控制这三条
     * 路径都会往里加 —— 它们清盘是异步的,而 mount 时那次 readCachedSessionList 可能早已
     * 读到旧快照(review: codex P1)。
     */
    const cacheHydrationBlocked = new Set<string>();
    /** relay 在线时才跑 anti-entropy；初始状态未知时保守暂停，避免离线失败重试。 */
    let linkOnline = false;
    /** push 一旦到达即权威：迟到的 getState 快照不得覆盖更新的 link status。 */
    let linkStatusPushSeen = false;
    /** 当前合格设备:deviceId → 友好名 */
    const eligible = new Map<string, string>();
    /** 本机主动关闭控制的目标设备(控制端本地偏好)。 */
    let disabledControlDeviceIds = new Set<string>();
    /** sessions:created reseed 的 per-device 防抖 timer */
    const reseedTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const bootstrapTasks = new Map<
      string,
      { promise: Promise<void>; rerun: boolean; name: string }
    >();

    /** 隧道调用是否因「访问权限已被撤销」失败(被控端逐设备黑名单)。 */
    const isAccessRevoked = (err: unknown): boolean =>
      extractIpcError(err)?.code === 'DEVICE_LINK_ACCESS_REVOKED';

    /**
     * 被某被控端撤销访问权限:移出合格集 + 记入 revokedDevicesStore(设置页显示「已撤销」)+
     * 移除其项目/对话 + 驱逐远端快照缓存。该设备 presence 仍在线/允许被控,故下次 presence 会再
     * subscribeAndBootstrap 重试 —— 被控端恢复后即自动接回。
     */
    const handleRevoked = (deviceId: string): void => {
      eligible.delete(deviceId);
      revokedDevicesStore.markRevoked(deviceId);
      remoteProjectsStore.removeDevice(deviceId);
      removeRemoteSessionActivityForDevice(deviceId);
      // 被控端明确拒绝我们:盘上那份镜像缓存也不该留(尊重对方的拒绝,不在本机留副本)。
      cacheHydrationBlocked.add(deviceId);
      clearCachedDevice(deviceId);
      evictDeviceCapabilities(deviceId);
      evictDeviceProviders(deviceId);
      evictDeviceGitSafetySettings(deviceId);
    };

    /**
     * 订阅 sessions topic(push 驱动列表)+ bootstrap 拉一次全量。subscribe 失败不阻断
     * bootstrap(退化为「快照可见、live 更新缺失」;被控端/控制端同版本时不会发生)。
     * 任一步返回 ACCESS_REVOKED → 标记已撤销并移除该设备;全程无撤销 → 清掉残留标记(恢复收尾)。
     */
    const runSubscribeAndBootstrap = async (deviceId: string, name: string): Promise<void> => {
      // 新一轮 bootstrap 是有意义的重试：即使还保留旧 shard 也要显式进入
      // loading，直到本轮落下 snapshot 或再次终态失败。
      remoteProjectsStore.markBootstrapLoading(deviceId);
      try {
        await window.electronAPI.deviceLink.subscribe(deviceId, ['sessions']);
      } catch (err) {
        if (isAccessRevoked(err)) return void handleRevoked(deviceId);
        if (!disposed) log.debug(`subscribe(sessions) failed for ${deviceId.slice(0, 8)}`, err);
      }
      if (disposed || !eligible.has(deviceId)) return;
      // bootstrap 期间被撤销(subscribe 成功、list 被拒)→ refreshRemoteDeviceSessions 返 'revoked'
      // (而非静默 give-up)→ 这里 handleRevoked,而不是继续预取能力 / 清撤销标记无视拒绝。
      const result = await refreshRemoteDeviceSessions(deviceId, name);
      if (result === 'revoked') return void handleRevoked(deviceId);
      if (disposed || !eligible.has(deviceId)) return;
      if (result === 'gave-up') {
        // 永久错误（如旧被控端 CHANNEL_NOT_ALLOWED）或瞬态重试耗尽：不是权威空列表，
        // 即使还有旧 shard 也必须标明本轮读取失败，不能把缓存伪装成刚返回的结果。
        // superseded 表示断连 / 清理使请求失效，必须等重连，不能误记成终态失败。
        remoteProjectsStore.markBootstrapFailed(deviceId);
      } else if (result === 'superseded') {
        // 断连或另一轮 refresh 会使本次快照失效；不要让本轮遗留的 loading
        // 永久遮住侧边栏。连接恢复时 presence/status 会再次触发 bootstrap。
        remoteProjectsStore.clearBootstrapLoading(deviceId);
      }
      // 预取被控端能力(model/effort/fast/permission/fork/rewind),使首次打开远程会话时
      // 模型下拉等不为空、modelDefinitions 同步层已热。fire-and-forget,失败不阻断。
      void prefetchDeviceCapabilities(deviceId);
      void prefetchDeviceProviders(deviceId);
      void prefetchDeviceGitSafetySettings(deviceId);
      // 未被撤销(ok 或普通失败):清掉可能残留的「已撤销」标记(被控端恢复 → 自动接回的收尾)。
      revokedDevicesStore.clearRevoked(deviceId);
    };

    const subscribeAndBootstrap = (deviceId: string, name: string): Promise<void> => {
      const existing = bootstrapTasks.get(deviceId);
      if (existing) {
        existing.name = name;
        existing.rerun = true;
        return existing.promise;
      }

      const task = { promise: Promise.resolve(), rerun: false, name };
      task.promise = (async () => {
        try {
          do {
            task.rerun = false;
            await runSubscribeAndBootstrap(deviceId, task.name);
          } while (!disposed && eligible.has(deviceId) && task.rerun);
        } finally {
          if (bootstrapTasks.get(deviceId) === task) bootstrapTasks.delete(deviceId);
        }
      })();
      bootstrapTasks.set(deviceId, task);
      return task.promise;
    };

    const applyDevice = (d: {
      deviceId: string;
      name: string;
      online: boolean;
      remoteControlEnabled: boolean;
      isSelf: boolean;
    }): void => {
      const ok =
        !d.isSelf &&
        d.online &&
        d.remoteControlEnabled &&
        !disabledControlDeviceIds.has(d.deviceId);
      if (ok) {
        const prevName = eligible.get(d.deviceId);
        const wasEligible = prevName !== undefined;
        eligible.set(d.deviceId, d.name);
        if (!wasEligible) {
          void subscribeAndBootstrap(d.deviceId, d.name); // 变合格:订阅 + 首拉
        } else if (prevName !== d.name) {
          // 已合格设备的 presence-changed 带来新设备名:重打 store 分片,让本窗口侧边栏即时更新。
          // renameDevice 只由**发起改名**的那个窗口调;其它窗口/设备仅收 presence-changed,
          // 不在此对齐就会一直显示旧名(直到设备移除 / 新 snapshot 替换)。同名时 renameDevice 内部 no-op。
          remoteProjectsStore.renameDevice(d.deviceId, d.name);
        }
      } else {
        const wasEligible = eligible.delete(d.deviceId);
        const action = resolveIneligibleRemoteProjectAction({
          wasEligible,
          hasCachedShard: remoteProjectsStore.hasDevice(d.deviceId),
          isSelf: d.isSelf,
          online: d.online,
          remoteControlEnabled: d.remoteControlEnabled,
          disabledControl: disabledControlDeviceIds.has(d.deviceId),
        });
        if (action === 'ignore') return;
        if (wasEligible) {
          window.electronAPI.deviceLink.unsubscribe(d.deviceId, ['sessions']).catch(() => {});
        }
        if (action === 'disconnect') {
          remoteProjectsStore.markDeviceDisconnected(d.deviceId);
        } else {
          remoteProjectsStore.removeDevice(d.deviceId);
          removeRemoteSessionActivityForDevice(d.deviceId);
          // 设备明确离场(关被控 / 本机禁用控制 / 是自己):它的冷缓存一起清掉,
          // 否则下次冷启动会把一台已经不该出现的设备画回侧边栏。
          cacheHydrationBlocked.add(d.deviceId);
          clearCachedDevice(d.deviceId);
        }
        evictDeviceCapabilities(d.deviceId);
        evictDeviceProviders(d.deviceId);
        evictDeviceGitSafetySettings(d.deviceId);
      }
    };

    /** 全量重播(初始 + WS 重连):listDevices 带 isSelf,权威。 */
    const reseed = (): void => {
      void window.electronAPI.deviceLink
        .listDevices()
        .then(({ devices }) => {
          if (disposed) return;
          for (const d of devices) {
            applyDevice({
              deviceId: d.deviceId,
              name: d.name,
              online: d.online,
              remoteControlEnabled: d.remoteControlEnabled,
              isSelf: d.isSelf,
            });
          }
          // 权威列表里**根本没有**的分片必须在这里收掉:applyDevice 只对返回的设备跑,
          // 账号里已删除的设备(冷启动时由缓存种进来的)否则永远没人评估,会作为
          // disconnected 项目常驻侧边栏,还会被后续快照一直写回盘(review: codex P1)。
          // 只在 listDevices **成功**时做(catch 分支不清):拿不到权威集合就不能判定缺席。
          // eligible 里的设备豁免 —— 它们由 presence 事件管理,listDevices 偶发缺项不该误删。
          //
          // 必须遍历 `getAllDeviceIds()`:缓存种入的分片一律标 disconnected,而
          // `getDeviceIds()` 只返回 connected —— 用它的话这个收敛循环恰好**永远看不到**
          // 要收的那些分片(review: codex 指出上一轮的修复因此无效)。
          const authoritative = new Set(devices.map((d) => d.deviceId));
          for (const deviceId of remoteProjectsStore.getAllDeviceIds()) {
            if (authoritative.has(deviceId) || eligible.has(deviceId)) continue;
            log.debug(`removing cached shard absent from listDevices: ${deviceId.slice(0, 8)}`);
            remoteProjectsStore.removeDevice(deviceId);
            removeRemoteSessionActivityForDevice(deviceId);
            // 权威列表里没有它 = 明确离场,和撤销 / 关被控同一档:登记进 hydration 黑名单,
            // 否则在途的那次 readCachedSessionList 落地后又把它种回来,而紧随的 reseed 在
            // listDevices 离线时纠正不了(review: codex P1)。
            cacheHydrationBlocked.add(deviceId);
            clearCachedDevice(deviceId);
          }
        })
        .catch((err) => log.debug('listDevices reseed failed', err));
    };

    // 冷启动首屏:用上次落盘的列表快照把侧边栏画出来(标 disconnected),不等 bootstrap 往返。
    // 已有分片的设备不覆盖;紧随其后的 bootstrap 用权威列表整片替换。
    //
    // 种入后**必须再 reseed 一次**:合格性判定(applyDevice → resolveIneligibleRemoteProjectAction)
    // 依赖 `hasCachedShard`,而这次种入是异步的,很可能落在初始 reseed 之后 —— 那一轮看到
    // 的是"没有分片"于是判 ignore,种进来的设备就没人再评估。app 关闭期间对端关掉被控 /
    // 账号里删掉设备的情形,都靠补这一轮收敛(reseed 末尾还会清掉权威列表中缺席的分片)。
    // 仍在 listDevices 里但离线的设备照既有语义保留为 disconnected —— 与「断连保留最近
    // 一次快照让 All Sessions 稳定」一致,不是本次引入的行为。
    void readCachedSessionList().then((devices) => {
      if (disposed || devices.length === 0) return;
      // 读快照这一跳期间被**明确移除**的设备(撤销访问 / 关闭被控 / 本机停用控制)不许种回来:
      // 那些路径已经删了分片并清了盘,而这次种入拿的是它们之前读到的旧快照;紧随的 reseed
      // 在 listDevices 离线时也纠正不了,于是那台设备会一直留在侧边栏(review: codex P1)。
      const usable = devices.filter((device) => !cacheHydrationBlocked.has(device.deviceId));
      if (usable.length === 0) return;
      remoteProjectsStore.hydrateFromCache(usable);
      reseed();
    });

    // 用户点击失败态重试 → 重走 subscribe + bootstrap，恢复 loading 与完整重试语义。
    setRemoteSessionBootstrapRetryImpl((deviceId) => {
      const name = eligible.get(deviceId);
      if (!name || disposed) return;
      void subscribeAndBootstrap(deviceId, name);
    });

    // sessions:created push(无 row 数据)/ applyPatch 的 unarchive 兜底 → 防抖重拉该设备(reconcile)。
    setRemoteReseedImpl((deviceId) => {
      const name = eligible.get(deviceId);
      if (!name) return;
      const prev = reseedTimers.get(deviceId);
      if (prev) clearTimeout(prev);
      reseedTimers.set(
        deviceId,
        setTimeout(() => {
          reseedTimers.delete(deviceId);
          if (!disposed && eligible.has(deviceId)) {
            void refreshRemoteDeviceSessions(deviceId, name, { snapshotMode: 'merge' });
          }
        }, RESEED_DEBOUNCE_MS),
      );
    });
    const stopPeriodicReconcile = startRemoteSessionsReconciler(
      () => (linkOnline ? eligible : []),
      async (deviceId, name) => {
        // sessions:list 是 200 条有界窗口；refresh 层会保留窗口外 active 行，并有界补查
        // 缺席缓存 id 的终态，不能直接把响应缺席解释成删除。
        const result = await refreshRemoteDeviceSessions(deviceId, name, {
          snapshotMode: 'merge',
          coalescingMode: 'weak',
        });
        if (result === 'revoked' && !disposed) handleRevoked(deviceId);
        // 回传结果供 reconciler 的失败退避记账('gave-up' 加深退避,'ok' 复位)。
        return result;
      },
    );

    // 目标设备「无响应」熔断翻转(main 权威):镜像给 UI;恢复时重跑 subscribe+bootstrap
    // ——熔断 open 期间的订阅 / 首拉都被快速失败挡掉了,恢复必须主动补,不能等用户手点。
    // push 一旦到达即权威,但只对**它自己那台设备**权威:迟到的 getState 快照按设备合并,
    // 未被 push 覆盖的设备仍取快照值 —— 整份丢弃会让「A 设备先来一条 push」掩盖掉
    // 快照里 B 设备的 unresponsive 初值,B 在下一次熔断翻转前一直假装 connected(review P1)。
    const responsivenessPushedDeviceIds = new Set<string>();
    const offResponsiveness = window.electronAPI.deviceLink.onResponsivenessChanged((p) => {
      if (disposed) return;
      responsivenessPushedDeviceIds.add(p.deviceId);
      unresponsiveDevicesStore.apply(p.deviceId, p.unresponsive);
      if (!p.unresponsive) {
        const name = eligible.get(p.deviceId);
        if (name) void subscribeAndBootstrap(p.deviceId, name);
      }
    });

    void window.electronAPI.deviceLink
      .getState()
      .then((state) => {
        if (disposed) return;
        if (!linkStatusPushSeen) linkOnline = state.linkStatus === 'online';
        disabledControlDeviceIds = new Set(state.disabledControlDeviceIds ?? []);
        // 「无响应」熔断镜像的初值:按设备合并,已被 push 覆盖的设备以 push 为准
        // (store 初始为空,快照只需补写 unresponsive 的未覆盖设备)。
        for (const deviceId of state.unresponsiveDeviceIds ?? []) {
          if (!responsivenessPushedDeviceIds.has(deviceId)) {
            unresponsiveDevicesStore.apply(deviceId, true);
          }
        }
        reseed();
      })
      .catch((err) => {
        log.debug('getState before device-link reseed failed', err);
        if (!disposed) reseed();
      });

    const offPresence = window.electronAPI.deviceLink.onPresenceChanged((snap) => {
      applyDevice({
        deviceId: snap.deviceId,
        name: snap.deviceName,
        online: snap.online,
        remoteControlEnabled: snap.remoteControlEnabled,
        isSelf: snap.deviceId === selfDeviceId,
      });
    });

    // 被控端 active-catalog 变化：供应商目录与 capabilities.availableModels 必须同代刷新。
    // 两套缓存订阅会把完整结果原子推给已挂载选择器，刷新期间保留旧列表避免空白跳变。
    const offRemotePush = window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (disposed || push.channel !== 'maker:provider:changed' || !eligible.has(push.deviceId))
        return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      evictDeviceProviders(push.deviceId);
      evictDeviceCapabilities(push.deviceId);
      void prefetchDeviceProviders(push.deviceId);
      void prefetchDeviceCapabilities(push.deviceId);
    });

    // WS 重连后:presence 重新对齐 + 对每个已合格设备重新 subscribe + 重新 bootstrap
    // (被控端可能重启过、订阅 registry 清空,这步重建订阅;reseed 补新设备)。
    const offStatus = window.electronAPI.deviceLink.onStatusChanged((p) => {
      linkStatusPushSeen = true;
      linkOnline = p.status === 'online';
      if (p.status !== 'online') {
        // relay 瞬时重连(connecting):保留远程会话镜像,只标记 disconnected,让 All Sessions
        // 不因网络抖动反复增删/重排。eligible 保留不动 → 重连 online 时下面的分支自动
        // 重 subscribe+bootstrap。stopped(登出 / 停服)才清空。
        if (p.status === 'connecting') {
          remoteProjectsStore.markAllDisconnected();
          return;
        }
        // 顺序要紧:cancel 必须在 clear **之后**。`clear()` 在 shards 非空时会同步通知
        // 订阅者,而此刻 offShardChange 仍挂着 → 它立刻排一个去抖回写;1200ms 后 shards
        // 已空,整份快照被写成 [],main 侧据此把 session-list.json 删掉。于是「relay 停服
        // (非登出)」会在约 1.2s 后抹掉侧边栏冷缓存 —— 而「停服后重启、relay 仍未恢复」
        // 正是这份缓存要解决的场景(review: P2)。整体删除只归 owner 边界的 clearAll。
        remoteProjectsStore.clear();
        cancelSessionListPersist();
        clearRemoteSessionActivity();
        // 'stopped'(登出 / 停服)还要清掉「已撤销」标记:否则切换栏的 buildSwitcherDevices 仍会拿
        // revoked 集合单独撑起一颗 rejected chip,停服后切换栏残留陈旧被拒 chip。'connecting' 是瞬态
        // 重连,被拒状态应跨重连保留(正常在线期一直可见),故不清。登出 unmount 时的 clearAll 仍是兜底。
        if (p.status === 'stopped') revokedDevicesStore.clearAll();
        return;
      }
      for (const [deviceId, name] of eligible) void subscribeAndBootstrap(deviceId, name);
      reseed();
    });

    // 控制端:被某被控端撤销访问权限(收到其 link-close('revoked'))→ 立即移除 + 标记已撤销。
    const offAccessRevoked = window.electronAPI.deviceLink.onAccessRevoked((p) => {
      if (!disposed) handleRevoked(p.deviceId);
    });

    const offControlTarget = window.electronAPI.deviceLink.onControlTargetChanged((p) => {
      if (disposed) return;
      disabledControlDeviceIds = new Set(p.disabledControlDeviceIds ?? []);
      if (!p.enabled) {
        const wasEligible = eligible.delete(p.deviceId);
        if (wasEligible) {
          window.electronAPI.deviceLink.unsubscribe(p.deviceId, ['sessions']).catch(() => {});
        }
        if (wasEligible || remoteProjectsStore.hasDevice(p.deviceId)) {
          remoteProjectsStore.removeDevice(p.deviceId);
          removeRemoteSessionActivityForDevice(p.deviceId);
          evictDeviceCapabilities(p.deviceId);
          evictDeviceProviders(p.deviceId);
          evictDeviceGitSafetySettings(p.deviceId);
        }
        // 本机关掉「控制这台设备」→ 盘上那份镜像缓存也要清。只清内存分片的话,下次冷启动
        // hydrateFromCache 会把这台已经明确禁用控制的设备连着它的会话画回侧边栏
        // (review: greptile)。放在 if 外面:即使此刻内存里没有分片(本次会话从未连上它),
        // 盘上仍可能留着上一次运行写下的缓存。
        cacheHydrationBlocked.add(p.deviceId);
        clearCachedDevice(p.deviceId);
        return;
      }
      reseed();
    });

    // 设备改名:服务端 REST 改名不广播 presence,接入器对齐缓存名(store 分片由 renameDevice 即时改)。
    const offRename = remoteProjectsStore.subscribeRename((deviceId, name) => {
      if (eligible.has(deviceId)) eligible.set(deviceId, name);
    });

    // 冷缓存回写由「分片变更」驱动,而不是只在一次成功 refresh 之后:
    // 被控端推来的 archived / deleted 增量(applyPatch)只改内存,若 app 在下一次 10 秒对账
    // 之前退出,下次离线冷启动就会把那条已归档 / 已删除的会话又 hydrate 回侧边栏
    // (review: codex P1)。订阅覆盖所有 mutation(snapshot / patch / 改名 / 断连 / 移除),
    // 去抖 1200ms 合并高频变更,main 侧还有内容指纹去重 —— 内容没变根本不落盘。
    const offShardChange = remoteProjectsStore.subscribe(() => {
      if (disposed) return;
      scheduleSessionListPersist(collectSessionListSnapshot);
    });

    return () => {
      disposed = true;
      setRemoteReseedImpl(null);
      setRemoteSessionBootstrapRetryImpl(null);
      stopPeriodicReconcile();
      for (const t of reseedTimers.values()) clearTimeout(t);
      reseedTimers.clear();
      bootstrapTasks.clear();
      offPresence();
      offRemotePush();
      offStatus();
      offAccessRevoked();
      offControlTarget();
      offRename();
      offShardChange();
      offResponsiveness();
      unresponsiveDevicesStore.clearAll();
      // best-effort 取消所有订阅(被控端 presence-offline 也会兜底清僵尸订阅)+ 驱逐远端快照缓存。
      for (const deviceId of eligible.keys()) {
        window.electronAPI.deviceLink.unsubscribe(deviceId, ['sessions']).catch(() => {});
        evictDeviceCapabilities(deviceId);
        evictDeviceProviders(deviceId);
        evictDeviceGitSafetySettings(deviceId);
      }
      // 卸载可能只是关了个窗口(镜像是每渲染进程一份),盘上缓存**不动** ——
      // 只作废尚未落盘的回写,免得它把正在清空的分片写回去。
      // cancel 放在 clear 之后(同 'stopped' 分支):这里 offShardChange 已退订,clear 通知不到
      // 任何订阅者,但顺序保持一致,免得将来有人在两者之间插入新的订阅。
      remoteProjectsStore.clear();
      cancelSessionListPersist();
      clearRemoteSessionActivity();
      revokedDevicesStore.clearAll();
    };
  }, [isAuthenticated, selfDeviceId]);
}
