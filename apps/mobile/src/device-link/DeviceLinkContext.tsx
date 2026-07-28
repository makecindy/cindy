import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import {
  DeviceLinkClient,
  DeviceLinkError,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  FILE_BROWSER_EVENT_CHANNEL,
  PROTOCOL_VERSION,
  type DeviceLinkConnectionIssue,
  type DeviceLinkStatus,
  type Envelope,
  type InvokeResultPayload,
  type LinkAcceptPayload,
  type PresenceSnapshot,
  type PushPayload,
  type Topic,
} from '@cindy/device-link';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { deviceLinkWsUrl } from '@/config/env';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';
import { useAuth } from '@/auth/AuthContext';
import {
  applyAccessRevokedFrame,
  withAccessRevokedHandling,
} from '@/device-link/accessRevoked';
import {
  clearAllDeviceProviders,
  evictDeviceProviders,
  fetchDeviceProviders,
  type DeviceProvidersPayload,
} from '@/device-link/deviceProvidersCache';
import {
  commitAgentCapabilities,
  evictAgentCapabilitiesForDevice,
  getAgentCapabilitiesGeneration,
  resetAgentCapabilitiesCache,
} from '@/session/agentCapabilitiesCache';
import { normalizeMobileAgentCapabilities } from '@/session/agentCapabilities';
import { evictComposerPaletteCacheForDevice, resetComposerPaletteCache } from '@/session/composerPaletteCache';
import { clearAllDeviceModelMeta, evictDeviceModelMeta } from '@/device-link/deviceModelMetaCache';
import { dispatchFileBrowserWatchEvent } from '@/device-link/fileBrowserWatch';
import { resolveMobileInvokeTimeoutMs } from '@/device-link/invokeTimeouts';
import { rehydrateDeviceLinkTopics } from '@/device-link/rehydrate';
import { invalidateOfflineScheduleIndexFailureFor, invalidateTransientScheduleIndexFailures } from '@/session/scheduleIndex';
import { isTransientRemoteError } from '@/device-link/remoteRetry';
import { createRnWebSocket } from '@/device-link/rnWebSocket';
import type { MobileGoalStatusPayload } from '@cindy/maker-shared/device-link-contract';
import {
  DeviceLinkTopicRegistry,
  markHeldRemoteTopicsSubscribed,
  markRemoteTopicsUnsubscribed,
  normalizeDeviceLinkTopics,
  topicsMissingRemoteAck,
} from '@/device-link/topicRegistry';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import {
  acquireDeviceSendSlot,
  buildDeviceResponsivenessProbeArgs,
  classifyDeviceSendFailure,
  classifyDeviceSendSuccess,
  classifyLinkOpenFailure,
  DEVICE_RESPONSIVENESS_PROBE_CHANNEL,
  isDeviceProbeDue,
  resetDeviceResponsivenessTracking,
  settleDeviceSend,
  unresponsiveDevicesStore,
} from '@/device-link/unresponsiveDevicesStore';
import { remoteScheduleEventStore } from '@/scheduler/remoteScheduleEvents';
import { buildMobileDeviceName } from '@/device-link/mobileDeviceIdentity';
import { updatePresenceAvailability } from '@/device-link/presenceRecovery';
import type { InputProjection, PendingInteraction, RemoteMessage } from '@/session/types';
import { createVisualMockDeviceLinkContext, seedVisualMockStore } from '@/debug/visualMock';

export interface DeviceLinkContextValue {
  status: DeviceLinkStatus;
  /** 连接层可分类的失败原因(鉴权失效/被顶号/超限/版本不符);null = 无异常 */
  connectionIssue: DeviceLinkConnectionIssue | null;
  presenceVersion: number;
  connectionEpoch: number;
  lastPresenceSnapshot: PresenceSnapshot | null;
  openLink(deviceId: string): Promise<LinkAcceptPayload>;
  closeLink(deviceId: string): void;
  /**
   * opts.preSend:在连接就绪之后、真正 client.invoke 之前的最后同步检查点。抛错即
   * 中止本次发送(错误原样上抛)。供写序敏感的调用方(patchHomeSession 的 isLatest
   * 屏障)把「过期即放弃」判定贴到实际发送点——ensureOnlineForRequest 最长 1.5s 的
   * 重连等待期间写可能被同字段新写取代,等待前的检查不够晚。
   */
  invoke<T = unknown>(
    deviceId: string,
    channel: string,
    args?: unknown[],
    opts?: { preSend?: () => void },
  ): Promise<T>;
  // `owner` is a stable id for the mounted consumer (e.g. `session:<id>`, `device:<id>`),
  // so repeated subscribes from resync/retry are idempotent and a topic is only released
  // when its last owner unsubscribes.
  subscribe(owner: string, deviceId: string, topics: string[]): Promise<void>;
  unsubscribe(owner: string, deviceId: string, topics: string[]): Promise<void>;
}

const DeviceLinkContext = createContext<DeviceLinkContextValue | null>(null);

interface RehydrateState {
  inFlight: Promise<void> | null;
  rerun: boolean;
}

interface RehydrateRetryState {
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
}

/** 补齐仍有瞬时失败时的退避重跑曲线:2s → 4s → … → 30s 封顶。 */
const REHYDRATE_RETRY_BASE_MS = 2_000;
const REHYDRATE_RETRY_MAX_MS = 30_000;

/**
 * 退后台断开连接前的宽限:几秒内切回前台的快速 App 切换不触发整套
 * 断连 → 重连 → 补齐,弱网下这套循环的代价远高于让 socket 多活两秒。
 */
const BACKGROUND_STOP_GRACE_MS = 2_500;
/**
 * 回前台时若「宽限计时器还挂着」但后台时长已超过此阈值,说明 JS 在计时器触发前
 * 被 iOS 挂起——socket 大概率已被系统回收,但状态机还认为 online。此时主动换新
 * 连接,别等心跳(~20s)才发现假活。
 */
const BACKGROUND_SUSPEND_SUSPECT_MS = 10_000;

/** 桌面端 presence 闪断宽限:短暂离线不立刻清空该设备的会话镜像与能力缓存。 */
const PRESENCE_OFFLINE_WIPE_GRACE_MS = 5_000;

export function DeviceLinkProvider({ children }: { children: ReactNode }) {
  if (MOBILE_VISUAL_MOCK_ENABLED) {
    return <VisualMockDeviceLinkProvider>{children}</VisualMockDeviceLinkProvider>;
  }

  const auth = useAuth();
  const clientRef = useRef<DeviceLinkClient | null>(null);
  const registryRef = useRef(new DeviceLinkTopicRegistry());
  const remoteSubscribedTopicsRef = useRef(new Map<string, Set<Topic>>());
  const rehydrateStateRef = useRef<RehydrateState>({
    inFlight: null,
    rerun: false,
  });
  const rehydrateRetryRef = useRef<RehydrateRetryState>({ timer: null, attempt: 0 });
  // 供退避计时器回调拿到最新的 rehydrateWithClient(二者互相引用,用 ref 解环)
  const rehydrateFnRef = useRef<(client: DeviceLinkClient) => Promise<void>>(() => Promise.resolve());
  const presenceWipeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const openLinkInFlightRef = useRef(new Map<string, Promise<LinkAcceptPayload>>());
  const presenceAvailableByDeviceRef = useRef(new Map<string, boolean>());
  const [status, setStatus] = useState<DeviceLinkStatus>('stopped');
  const [connectionIssue, setConnectionIssue] = useState<DeviceLinkConnectionIssue | null>(null);
  const [presenceVersion, setPresenceVersion] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [lastPresenceSnapshot, setLastPresenceSnapshot] = useState<PresenceSnapshot | null>(null);

  const sendOpenLinkOnce = useCallback((client: DeviceLinkClient, deviceId: string) => {
    const existing = openLinkInFlightRef.current.get(deviceId);
    if (existing) return existing;

    const request = sendOpenLinkWithAccessHandling(client, deviceId);
    openLinkInFlightRef.current.set(deviceId, request);
    const cleanup = (): void => {
      if (openLinkInFlightRef.current.get(deviceId) === request) {
        openLinkInFlightRef.current.delete(deviceId);
      }
    };
    void request.then(cleanup, cleanup);
    return request;
  }, []);

  const sendTrackedSubscribe = useCallback(async (
    client: DeviceLinkClient,
    deviceId: string,
    topics: readonly Topic[],
  ) => {
    const toSend = topicsMissingRemoteAck(remoteSubscribedTopicsRef.current, deviceId, topics);
    if (toSend.length === 0) return;
    await sendSubscribeWithAccessHandling(client, deviceId, toSend);
    markHeldRemoteTopicsSubscribed(remoteSubscribedTopicsRef.current, registryRef.current, deviceId, toSend);
  }, []);

  // 熔断 open 设备的显式代表性探测:openLink 建链(成功按不定论,不关熔断),
  // 再发一条真正穿过被控端 runInvoke → dispatchLocalInvoke → local-db 的最小读,
  // 由 sendInvoke 内部的熔断收尾决定开合(真实回包 → 关;超时 → 加深退避)。
  // 错误全吞:结果已在 send 层按熔断语义上报,这里不需要二次处理。
  const probeUnresponsiveDevice = useCallback(
    async (client: DeviceLinkClient, deviceId: string): Promise<void> => {
      try {
        await sendOpenLinkOnce(client, deviceId);
        await sendInvokeWithAccessHandling(
          client,
          deviceId,
          DEVICE_RESPONSIVENESS_PROBE_CHANNEL,
          buildDeviceResponsivenessProbeArgs(),
        );
      } catch {
        // swallow — settle 已在 sendOpenLink / sendInvoke 内完成。
      }
    },
    [sendOpenLinkOnce],
  );

  const clearRehydrateRetry = useCallback((resetAttempt: boolean) => {
    const retry = rehydrateRetryRef.current;
    if (retry.timer) {
      clearTimeout(retry.timer);
      retry.timer = null;
    }
    if (resetAttempt) retry.attempt = 0;
  }, []);

  // 补齐通过后(或掉线,online 转换会全量重跑)清退避;仍有瞬时失败则按退避重跑。
  // 补齐是断连窗口 push 断档的唯一回填手段,一次性 best-effort 失败即放弃会把
  // 断档消息静默永久丢在镜像外(用户只能靠手动刷新自救)。
  const scheduleRehydrateRetry = useCallback(
    (client: DeviceLinkClient, transientFailures: number) => {
      const retry = rehydrateRetryRef.current;
      if (retry.timer) {
        clearTimeout(retry.timer);
        retry.timer = null;
      }
      if (transientFailures <= 0 || client.getStatus() !== 'online') {
        retry.attempt = 0;
        return;
      }
      const delay = Math.min(REHYDRATE_RETRY_BASE_MS * 2 ** retry.attempt, REHYDRATE_RETRY_MAX_MS);
      retry.attempt += 1;
      retry.timer = setTimeout(() => {
        retry.timer = null;
        if (client.getStatus() === 'online') void rehydrateFnRef.current(client);
      }, delay);
    },
    [],
  );

  const rehydrateWithClient = useCallback(
    (client: DeviceLinkClient): Promise<void> => {
      if (client.getStatus() !== 'online') return Promise.resolve();
      const state = rehydrateStateRef.current;
      if (state.inFlight) {
        state.rerun = true;
        return state.inFlight;
      }

      let run!: Promise<void>;
      run = (async () => {
        let lastTransientFailures = 0;
        try {
          // 链路已恢复(rehydrate 只在 online 时运行,重连必经):普通断线期间
          // 产生的 schedule-index 瞬态负缓存立即失效,让本轮 reseed 拉到新数据
          // 而不是吃 30s TTL 内的旧 rejected promise(review P1)。
          invalidateTransientScheduleIndexFailures();
          do {
            state.rerun = false;
            if (client.getStatus() !== 'online') return;
            const allPlans = registryRef.current.snapshot();
            // 撤权设备直接出局(review P1):撤权是终态,openLink 只会等来
            // link-close(revoked) + 超时;若不过滤,撤权时清熔断状态触发的这轮
            // rehydrate 会对它重新 openLink,且其超时已按撤权降级为不定论,
            // 熔断兜不住,退避循环会为它无限空转。也不计入 transientFailures。
            const grantedPlans = allPlans.filter(
              (plan) => !revokedDevicesStore.has(plan.deviceId),
            );
            // 熔断 open 的设备整体退出常规 rehydrate(每一步都会本地快速失败),
            // 改走显式代表性探测(review P1 多轮收敛):不能依赖 openLink /
            // subscribe 顺带探测——link-accept 与 subscribe 都在被控端 dispatch
            // 里于 runInvoke 之前特判应答,IPC/DB 卡死时照常回包会误关熔断;
            // 订阅已被 remoteSubscribedTopicsRef 记录或计划里没有 topic 时,
            // subscribe 甚至根本不会发包。探测窗口到点就发一条真正穿过
            // runInvoke → local-db 的最小读(见 DEVICE_RESPONSIVENESS_PROBE_CHANNEL),
            // 由它的回包决定熔断开合;这也是无业务流量时的主动恢复通道。
            // 探测候选取 registry 计划与 unresponsive 集合的并集(review P1):
            // 仅有直接 invoke、从未登记 openLink/subscribe 的设备(如只停留在
            // 首页的设备行)不在 registry 里,熔断 open 后若不纳入,它既收不到
            // 探测也不占未完成信号,会在没有业务流量时永久停留在未响应态。
            const openDeviceIds = new Set<string>();
            for (const plan of grantedPlans) {
              if (unresponsiveDevicesStore.has(plan.deviceId)) openDeviceIds.add(plan.deviceId);
            }
            for (const deviceId of unresponsiveDevicesStore.getSnapshot()) {
              if (!revokedDevicesStore.has(deviceId)) openDeviceIds.add(deviceId);
            }
            const plans = grantedPlans.filter(
              (plan) => !unresponsiveDevicesStore.has(plan.deviceId),
            );
            // 探测与健康设备的 rehydrate 并发跑(review P1):探测一台死设备最长
            // 要等 openLink + DB 读两次超时(~30s),串行在前会把其它健康桌面的
            // 订阅恢复 / 快照回填拖住整轮;多台 open 设备之间仍串行,避免探测
            // 本身成为并发突发。
            const probeRun = (async () => {
              for (const deviceId of openDeviceIds) {
                if (!isDeviceProbeDue(deviceId)) continue;
                await probeUnresponsiveDevice(client, deviceId);
              }
            })();
            const result = await rehydrateDeviceLinkTopics(plans, {
              openLink: (deviceId) => sendOpenLinkOnce(client, deviceId),
              subscribe: (deviceId, topics) => sendTrackedSubscribe(client, deviceId, topics),
              requestSessionsReseed: (deviceId) => remoteSessionStore.requestReseed(deviceId),
              rebuildSessionSnapshot: (deviceId, sessionId) => rebuildSessionSnapshot(client, deviceId, sessionId),
            });
            await probeRun;
            // 探测后仍 open 的设备持续计入"未完成"信号(review P1:不能在探测
            // 真正跑完并成功前撤掉重试安排),退避重试循环(2s→30s)继续走:
            // 窗口未到的轮次只做本地检查,零管道流量。探测成功关熔断会触发
            // 下方 effect 的 store 订阅,补一轮全量 rehydrate 把该设备的订阅 /
            // 快照拉回来。
            const stillOpenDevices = [...openDeviceIds].filter(
              (deviceId) => unresponsiveDevicesStore.has(deviceId),
            ).length;
            lastTransientFailures = result.transientFailures + stillOpenDevices;
          } while (state.rerun && client.getStatus() === 'online');
        } finally {
          if (state.inFlight === run) {
            state.inFlight = null;
            state.rerun = false;
          }
          scheduleRehydrateRetry(client, lastTransientFailures);
        }
      })();
      state.inFlight = run;
      return run;
    },
    [probeUnresponsiveDevice, scheduleRehydrateRetry, sendOpenLinkOnce, sendTrackedSubscribe],
  );

  useEffect(() => {
    rehydrateFnRef.current = rehydrateWithClient;
  }, [rehydrateWithClient]);

  useEffect(() => {
    if (!auth.isAuthenticated) {
      clientRef.current?.stop();
      clientRef.current = null;
      registryRef.current.clear();
      remoteSubscribedTopicsRef.current.clear();
      rehydrateStateRef.current.inFlight = null;
      rehydrateStateRef.current.rerun = false;
      clearRehydrateRetry(true);
      clearPresenceWipeTimers(presenceWipeTimersRef.current);
      openLinkInFlightRef.current.clear();
      presenceAvailableByDeviceRef.current.clear();
      setStatus('stopped');
      setConnectionIssue(null);
      remoteSessionStore.clear();
      remoteScheduleEventStore.clearAll();
      revokedDevicesStore.clearAll();
      resetDeviceResponsivenessTracking();
      // 登出 / 进程内切号:清掉所有 per-account 残留,避免下一个账号串到上一个账号的数据。
      // - 供应商目录是 module 级单例缓存(useDeviceProviders 按 deviceId 命中),不随组件卸载清;
      // - lastPresenceSnapshot 是本 context 的 state,home 屏据它 patch 设备列表。
      // 二者若不重置,切号后会短暂看到 / 用到上一个账号的桌面端与供应商数据。
      clearAllDeviceProviders();
      clearAllDeviceModelMeta();
      resetAgentCapabilitiesCache();
      resetComposerPaletteCache();
      setLastPresenceSnapshot(null);
      setPresenceVersion((n) => n + 1);
      return;
    }

    const client = new DeviceLinkClient({
      getWsUrl: () => deviceLinkWsUrl(),
      getToken: auth.getAccessToken,
      getHello: () => ({
        deviceName: mobileDeviceName(),
        platform: Platform.OS,
        appVersion: Constants.expoConfig?.version ?? '0.0.0',
        remoteControlEnabled: false,
        busy: false,
      }),
      createWebSocket: createRnWebSocket,
      logger: mobileDeviceLinkLogger,
      // 手机弱网(切基站 / 弱 WiFi)下 TCP 半开假活远比桌面常见,收紧心跳把
      // 半开检测从默认 ~60s(20s×3 tick)压到 ~20s(10s×2 tick);检测到即
      // fail 全部 pending invoke,不让用户操作干等 30s 请求超时。仅手机端
      // opt-in 覆盖,桌面端默认曲线不变。
      timing: {
        pingIntervalMs: 10_000,
        pongMissLimit: 1,
        getTokenTimeoutMs: 10_000,
        handshakeTimeoutMs: 12_000,
        // 请求超时收紧到 15s(默认 30s):被控端卡死时 30s 才失败让用户干等半分钟,
        // 也把熔断器凑齐「连续超时」信号的时间拖长一倍。长执行通道(desktop-cmd:run /
        // worktree:create / schedule 等)在 sendInvoke 按 invokeTimeouts 解析规则单独放宽,
        // 与桌面控制端同一张协议契约表,不受此默认值影响。
        requestTimeoutMs: 15_000,
      },
    });
    clientRef.current = client;
    const offIssue = client.onConnectionIssue(setConnectionIssue);
    const offStatus = client.onStatusChange((next) => {
      setStatus(next);
      if (next !== 'online') {
        openLinkInFlightRef.current.clear();
        remoteSubscribedTopicsRef.current.clear();
        // 掉线即取消挂起的补齐重试:重新 online 会触发全量补齐,无需旧计时器
        clearRehydrateRetry(true);
        return;
      }
      setConnectionEpoch((n) => n + 1);
      void rehydrateWithClient(client);
    });
    const offPresence = client.onPresenceChanged((snap) => {
      setLastPresenceSnapshot(snap);
      setPresenceVersion((n) => n + 1);
      const presence = updatePresenceAvailability(presenceAvailableByDeviceRef.current, snap);
      const wipeTimers = presenceWipeTimersRef.current;
      if (!presence.available) {
        // 订阅跟踪必须立即失效(不进宽限):桌面端断开可能已丢失订阅者状态,
        // 恢复后的 rehydrate 靠 topicsMissingRemoteAck 判断要不要重发 subscribe,
        // 跟踪不清会误判「已订阅」而跳过重订阅,push 流静默断掉。重订阅本身
        // 便宜且服务端幂等;需要宽限的只是下面会引起界面闪烁的缓存清理。
        remoteSubscribedTopicsRef.current.delete(snap.deviceId);
        const wipeDevice = () => {
          remoteSessionStore.removeDevice(snap.deviceId);
          remoteScheduleEventStore.clearDevice(snap.deviceId);
          // Drop the cached provider catalog so a returning/re-granted device re-fetches it
          // instead of serving a list frozen from a previous connection.
          evictDeviceProviders(snap.deviceId);
          evictDeviceModelMeta(snap.deviceId);
          // 能力表与供应商目录同时机驱逐:桌面端重连 / 升级 / 重新授权后必须重取,
          // 否则模型 / 权限 / plan 支持度会先按旧能力渲染并接受点击。
          evictAgentCapabilitiesForDevice(snap.deviceId);
          evictComposerPaletteCacheForDevice(snap.deviceId);
        };
        if (snap.online && !snap.remoteControlEnabled) {
          // 用户在桌面端显式关闭了远控:立即清,镜像不该多留一秒
          clearPresenceWipeTimer(wipeTimers, snap.deviceId);
          wipeDevice();
          return;
        }
        // 桌面端离线:给一个短宽限。弱网下桌面端会反复闪断,每次都立即清空
        // 会话镜像 + 能力缓存会让手机端界面整片消失重建、随后一轮 re-fetch 风暴;
        // 宽限内恢复在线则取消清理(presence.recovered 分支照常触发补齐)。
        if (!wipeTimers.has(snap.deviceId)) {
          wipeTimers.set(snap.deviceId, setTimeout(() => {
            wipeTimers.delete(snap.deviceId);
            // 宽限到点仍不可用才真正清(期间可能已恢复又再次离线,以 ref 里的现值为准)
            if (presenceAvailableByDeviceRef.current.get(snap.deviceId) === false) wipeDevice();
          }, PRESENCE_OFFLINE_WIPE_GRACE_MS));
        }
        return;
      }
      clearPresenceWipeTimer(wipeTimers, snap.deviceId);
      // 每个「可用」快照都清该设备的 DEVICE_OFFLINE 负缓存(review P1 ×2):
      // 主机在手机连上 relay 之前就离线时,presence 只在变化时广播,首个在线
      // 快照 recovered=false——只挂 recovered 会漏掉这次恢复,徽标停留到无关
      // 触发。逐设备且幂等(map 单点查删),不影响其它设备的风暴止损。
      invalidateOfflineScheduleIndexFailureFor(snap.deviceId);
      if (presence.recovered) void rehydrateWithClient(client);
    });
    const offFrame = client.onFrame((env) => routeFrame(env, {
      onAccessRevoked: (deviceId) => remoteSubscribedTopicsRef.current.delete(deviceId),
      onProviderChanged: (deviceId) => {
        // provider 目录与 capabilities.availableModels 是同一份 active catalog 的两种视图。
        // 同时驱逐并后台重拉；页面保留旧画面，当前代完整快照提交后由订阅一次性更新。
        evictDeviceProviders(deviceId);
        evictAgentCapabilitiesForDevice(deviceId);
        void fetchDeviceProviders(deviceId, () =>
          sendInvokeWithAccessHandling<DeviceProvidersPayload>(
            client,
            deviceId,
            'maker:provider:list',
            [],
          )
        ).catch(() => { /* 下次进入选择器或重连补齐时继续重试。 */ });
        void refreshDeviceCapabilities(client, deviceId);
      },
    }));
    client.start();

    // 熔断状态变化触发 rehydrate:unresponsive 集合的新增与移除都各触发一次
    // (review P1 + 注释勘误):
    // - 设备恢复(移除):补一次 rehydrate,把 open 期间被跳过的订阅/快照拉回来;
    // - 设备进入 open(新增):也要触发一次——熔断可能由普通页面请求凑满超时打开,
    //   此刻若没有已在跑的 rehydrate 退避循环,代表性探测根本无人发起,
    //   主动恢复永远不会启动。触发的这轮会因 stillOpenDevices>0 进入 2s→30s
    //   退避循环,成为探测心跳(窗口未到的轮次零管道流量,到点自动发探测)。
    let lastUnresponsiveSnapshot = unresponsiveDevicesStore.getSnapshot();
    const offUnresponsive = unresponsiveDevicesStore.subscribe(() => {
      const next = unresponsiveDevicesStore.getSnapshot();
      const changed =
        next.size !== lastUnresponsiveSnapshot.size
        || [...lastUnresponsiveSnapshot].some((deviceId) => !next.has(deviceId));
      lastUnresponsiveSnapshot = next;
      if (changed) void rehydrateWithClient(client);
    });

    // 退后台的断连宽限状态:stopTimer 挂着表示还没真正 stop;backgroundAt 用于
    // 回前台时判断 JS 是否在计时器触发前就被挂起(见 BACKGROUND_SUSPEND_SUSPECT_MS)。
    const backgroundState: { stopTimer: ReturnType<typeof setTimeout> | null; backgroundAt: number } = {
      stopTimer: null,
      backgroundAt: 0,
    };
    const clearBackgroundStopTimer = () => {
      if (backgroundState.stopTimer) {
        clearTimeout(backgroundState.stopTimer);
        backgroundState.stopTimer = null;
      }
    };
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        const heldConnection = backgroundState.stopTimer !== null;
        clearBackgroundStopTimer();
        const backgroundedForMs = backgroundState.backgroundAt > 0 ? Date.now() - backgroundState.backgroundAt : 0;
        backgroundState.backgroundAt = 0;
        if (heldConnection && backgroundedForMs > BACKGROUND_SUSPEND_SUSPECT_MS) {
          // 宽限计时器没来得及触发但后台已超阈值:JS 被挂起过,socket 大概率
          // 已被系统回收而状态机仍认为 online——主动换新连接,别等心跳才发现假活。
          client.stop();
        }
        // 回前台立刻重连:绕开断线后遗留的指数退避计时器(可能 park 到 30s),
        // 让"打开 App → 打开会话"路径快速恢复在线,而不是干等退避。
        client.connectNow('appstate-active');
        // 快速切换(连接被宽限保住、始终 online)不会有 online 状态转换,这条显式
        // 补齐就是断档回填的唯一触发点;其余路径下它因 status 未 online 而空转。
        void rehydrateWithClient(client);
      }
      if (next === 'background') {
        // 立即释放重量级 session:<id> 订阅(趁 socket 还活着、iOS 尚未挂起 JS):
        // 被控桌面以「有人订阅该会话流」为防打扰信号压制手机系统推送,锁屏/切后台
        // 后若订阅残留(宽限窗、挂起延迟最长可拖到 server 60s 空闲清扫),恰好在
        // 用户离开的瞬间完成的任务就永远收不到通知。只动远端订阅与 ack 簿记,
        // registry 所有权保留 —— 回前台的 rehydrate 会因 ack 已清而重新订阅。
        const registrySnapshot = registryRef.current.snapshot();
        for (const plan of registrySnapshot) {
          const heavy = plan.topics.filter((topic) => topic.startsWith('session:'));
          if (heavy.length === 0) continue;
          markRemoteTopicsUnsubscribed(remoteSubscribedTopicsRef.current, plan.deviceId, heavy);
          if (client.getStatus() === 'online') {
            void sendUnsubscribe(client, plan.deviceId, heavy).catch(() => undefined);
          }
        }
        // 短暂宽限再断:几秒内切回的快速 App 切换不触发整套断连/重连/补齐。
        // iOS 挂起后计时器不再运行,恢复时由上面的 active 分支收拾残局。
        backgroundState.backgroundAt = Date.now();
        clearBackgroundStopTimer();
        backgroundState.stopTimer = setTimeout(() => {
          backgroundState.stopTimer = null;
          if (AppState.currentState === 'background') client.stop();
        }, BACKGROUND_STOP_GRACE_MS);
      }
    });

    return () => {
      sub.remove();
      clearBackgroundStopTimer();
      offUnresponsive();
      offFrame();
      offPresence();
      offStatus();
      offIssue();
      client.stop();
      rehydrateStateRef.current.rerun = false;
      clearRehydrateRetry(true);
      clearPresenceWipeTimers(presenceWipeTimersRef.current);
      openLinkInFlightRef.current.clear();
      remoteSubscribedTopicsRef.current.clear();
      presenceAvailableByDeviceRef.current.clear();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [auth.getAccessToken, auth.isAuthenticated, clearRehydrateRetry, rehydrateWithClient]);

  const openLink = useCallback(
    async (deviceId: string) => {
      registryRef.current.trackOpenLink(deviceId);
      return sendOpenLinkOnce(requireClient(clientRef.current), deviceId);
    },
    [sendOpenLinkOnce],
  );

  const closeLink = useCallback((deviceId: string) => {
    registryRef.current.untrackOpenLink(deviceId);
    openLinkInFlightRef.current.delete(deviceId);
    clientRef.current?.closeLink(deviceId, 'user');
  }, []);

  const invoke = useCallback(async <T,>(
    deviceId: string,
    channel: string,
    args: unknown[] = [],
    opts?: { preSend?: () => void },
  ) => {
    return sendInvokeWithAccessHandling<T>(requireClient(clientRef.current), deviceId, channel, args, opts);
  }, []);

  const subscribe = useCallback(async (owner: string, deviceId: string, topics: string[]) => {
    // `owner` is the stable id of the mounted consumer (e.g. `session:<id>`). Tracking is
    // idempotent per (owner, topic), so resync/retry resubscribes don't accumulate. The
    // server subscribe is idempotent, so it's safe to (re)send the requested topics.
    registryRef.current.trackSubscribe(owner, deviceId, topics);
    await sendTrackedSubscribe(
      requireClient(clientRef.current),
      deviceId,
      normalizeDeviceLinkTopics(topics),
    );
  }, [sendTrackedSubscribe]);

  const unsubscribe = useCallback(async (owner: string, deviceId: string, topics: string[]) => {
    // Drop only this owner's hold; release (server unsubscribe) the topics whose last owner
    // just left. If a focused screen blurs before subscribe acknowledgement, a later cleanup may
    // ask to unsubscribe an already-released owner; resend only topics that are currently unheld
    // so unsubscribe-before-subscribe delivery cannot leave a stale heavy stream alive.
    const released = registryRef.current.untrackSubscribe(owner, deviceId, topics);
    const releasedSet = new Set<string>(released);
    const staleUnheld = topics.filter((topic) =>
      isDeviceLinkTopic(topic) && !releasedSet.has(topic) && !registryRef.current.hasTopic(deviceId, topic));
    const toSend = normalizeDeviceLinkTopics([...new Set([...released, ...staleUnheld])]);
    markRemoteTopicsUnsubscribed(remoteSubscribedTopicsRef.current, deviceId, toSend);
    if (toSend.length === 0) return;
    await sendUnsubscribe(requireClient(clientRef.current), deviceId, toSend);
  }, []);

  const value = useMemo<DeviceLinkContextValue>(() => ({
    status,
    connectionIssue,
    presenceVersion,
    connectionEpoch,
    lastPresenceSnapshot,
    openLink,
    closeLink,
    invoke,
    subscribe,
    unsubscribe,
  }), [
    closeLink,
    connectionEpoch,
    connectionIssue,
    invoke,
    lastPresenceSnapshot,
    openLink,
    presenceVersion,
    status,
    subscribe,
    unsubscribe,
  ]);

  return <DeviceLinkContext.Provider value={value}>{children}</DeviceLinkContext.Provider>;
}

function VisualMockDeviceLinkProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    seedVisualMockStore();
  }, []);
  const value = useMemo(() => createVisualMockDeviceLinkContext(), []);
  return <DeviceLinkContext.Provider value={value}>{children}</DeviceLinkContext.Provider>;
}

function routeFrame(env: Envelope, handlers: {
  onAccessRevoked?: (deviceId: string) => void;
  onProviderChanged?: (deviceId: string) => void;
} = {}): void {
  if (applyAccessRevokedFrame(env)) {
    if (env.src) handlers.onAccessRevoked?.(env.src);
    return;
  }
  if (env.kind !== 'push' || !env.src) return;
  const push = env.payload as PushPayload;
  if (push.channel === 'maker:provider:changed') {
    handlers.onProviderChanged?.(env.src);
    return;
  }
  if (push.channel === 'maker:schedule:event') {
    remoteScheduleEventStore.apply(env.src, push.payload);
  }
  if (push.channel === FILE_BROWSER_EVENT_CHANNEL) {
    // 文件树变更是 workdir 域事件,与会话 store 无关,单独分发给文件浏览页。
    dispatchFileBrowserWatchEvent(push.payload);
    return;
  }
  remoteSessionStore.applyRemotePush(env.src, push.channel, push.payload);
}

/** provider revision 后并行重拉两种 agent 的能力；旧代或异常结果都不触碰当前页面。 */
async function refreshDeviceCapabilities(
  client: DeviceLinkClient,
  deviceId: string,
): Promise<void> {
  const generation = getAgentCapabilitiesGeneration(deviceId);
  await Promise.allSettled(
    (['claude-code', 'codex'] as const).map(async (agentKind) => {
      const raw = await sendInvokeWithAccessHandling<unknown>(
        client,
        deviceId,
        'maker:get-capabilities',
        [agentKind],
      );
      const normalized = normalizeMobileAgentCapabilities(raw);
      if (normalized) {
        commitAgentCapabilities(deviceId, agentKind, generation, normalized);
      }
    }),
  );
}

async function rebuildSessionSnapshot(
  client: DeviceLinkClient,
  deviceId: string,
  sessionId: string,
): Promise<void> {
  // 四路快照独立拉取、独立落库:断连补齐窗口本就脆弱,一个子请求失败不应拖垮
  // 其余(旧实现共用一个 catch,任一失败三份快照全丢)。goal 覆盖断连窗口内
  // 丢失的 maker:goal:status-changed push;model-pref / turn-cost 无对应查询通道,
  // 暂不在补齐范围(需扩桌面端 invoke 白名单)。
  const [history, pending, projection, goal] = await Promise.allSettled([
    sendInvokeWithAccessHandling<RemoteMessage[]>(client, deviceId, 'local-db:messages:list', [
      sessionId,
      { limit: 80 },
    ]),
    sendInvokeWithAccessHandling<PendingInteraction[]>(
      client,
      deviceId,
      'maker:get-pending-interactions',
      [sessionId],
    ),
    sendInvokeWithAccessHandling<InputProjection>(
      client,
      deviceId,
      'maker:input:get-projection',
      [sessionId],
    ),
    sendInvokeWithAccessHandling<MobileGoalStatusPayload | null | undefined>(
      client,
      deviceId,
      'maker:goal:get-status',
      [sessionId],
    ),
  ]);
  if (history.status === 'fulfilled' && Array.isArray(history.value)) {
    remoteSessionStore.setLatestMessageWindow(sessionId, history.value);
  }
  if (pending.status === 'fulfilled' && Array.isArray(pending.value)) {
    remoteSessionStore.setPendingInteractions(sessionId, pending.value, { finalizeStreaming: true });
  }
  if (projection.status === 'fulfilled' && projection.value) {
    remoteSessionStore.setInputProjection(sessionId, projection.value);
  }
  // undefined = 未拿到/未知(兼容形态的空返回),不能当作权威「无 goal」落库——
  // 那会把在世的 goal 卡清掉直到下一条 push;只有显式 null 才代表确认无 goal。
  if (goal.status === 'fulfilled' && goal.value !== undefined) {
    remoteSessionStore.setGoalStatus(sessionId, goal.value);
  }
  // 任一子快照瞬时失败 → 上抛让 rehydrate 计入重试;永久失败(老被控端无 goal
  // 通道的 CHANNEL_NOT_ALLOWED、权限撤销等)吞掉,重试没有意义。
  const results = [history, pending, projection, goal] as const;
  const transient = results.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected' && isTransientRemoteError(r.reason),
  );
  if (transient) throw transient.reason;
}

// 掉线/重连窗口里发起请求时,先有界等待连接就绪的上限。够一次健康重连握手完成
// (通常 <1s),又短到连不上时能快速失败、让上层 withTransientRemoteRetry 重试,
// 而不是把单次 client.invoke park 在退避 gap 里干等十几秒。
const CONNECT_READY_TIMEOUT_MS = 1_500;

// 发请求前确保连接就绪:online 直接放行;否则促成立即重连并有界等待上线,
// 超时抛 NOT_CONNECTED(transient)交由上层重试 —— 把"等整个退避 gap"压成"等一次重连"。
function ensureOnlineForRequest(client: DeviceLinkClient): Promise<void> {
  if (client.getStatus() === 'online') return Promise.resolve();
  return client.waitUntilOnline(CONNECT_READY_TIMEOUT_MS);
}

function sendOpenLinkWithAccessHandling(
  client: DeviceLinkClient,
  deviceId: string,
): Promise<LinkAcceptPayload> {
  return withAccessRevokedHandling(deviceId, () => sendOpenLink(client, deviceId));
}

async function sendOpenLink(client: DeviceLinkClient, deviceId: string): Promise<LinkAcceptPayload> {
  // 熔断门禁放在连接等待之前:open 时快速失败,不消耗 1.5s 重连等待也不上管道。
  const slot = acquireDeviceSendSlot(deviceId);
  try {
    await ensureOnlineForRequest(client);
  } catch (err) {
    settleDeviceSend(deviceId, slot, 'inconclusive');
    throw err;
  }
  try {
    const accepted = await client.openLink(deviceId, {
      controllerName: mobileDeviceName(),
      protocolVersion: PROTOCOL_VERSION,
      appVersion: Constants.expoConfig?.version ?? '0.0.0',
    });
    // link-accept 只证明链路层活着,不证明 invoke 路径健康(review P1):事故形态
    // 正是 link-open 在被控端 IPC/DB 路径之外应答正常、invoke 全部挂死——若凭
    // link-accept 关熔断,恢复流程会立刻放进订阅 + 快照 + 业务 invoke 突发,3 次
    // 超时后再 open,形成周期性风暴。这里按不定论处理:不关熔断也不计失败;
    // openLink 若是探测,单飞席位随之释放、退避窗口不动,紧随其后的 subscribe
    // (真实 invoke 通道)会立即接棒成为新探测,由它的回包决定开合。
    settleDeviceSend(deviceId, slot, 'inconclusive');
    return accepted;
  } catch (err) {
    // 超时仍计失败:link-open 都等不到回包说明被控端连链路层都没在应答。
    // 终态 relay 应答(REMOTE_DISABLED / DEVICE_OFFLINE / VERSION_MISMATCH)
    // 关熔断,把 UI 让给对应的可操作错误态(review P1:否则设备被永远探测)。
    settleDeviceSend(deviceId, slot, classifyLinkOpenFailure(err));
    throw err;
  }
}

function sendInvokeWithAccessHandling<T>(
  client: DeviceLinkClient,
  deviceId: string,
  channel: string,
  args: unknown[],
  opts?: { preSend?: () => void },
): Promise<T> {
  return withAccessRevokedHandling(deviceId, () => sendInvoke<T>(client, deviceId, channel, args, opts));
}

async function sendInvoke<T>(
  client: DeviceLinkClient,
  deviceId: string,
  channel: string,
  args: unknown[],
  opts?: { preSend?: () => void },
): Promise<T> {
  // 熔断门禁放在连接等待之前:open 时快速失败,不消耗 1.5s 重连等待也不上管道。
  const slot = acquireDeviceSendSlot(deviceId);
  try {
    await ensureOnlineForRequest(client);
    // 连接就绪后、真正发送前的最后检查点:重连等待期间调用方状态可能已失效
    // (写被同字段新写取代),抛错即中止发送。
    opts?.preSend?.();
  } catch (err) {
    // 未真正发送(等待连接失败 / preSend 中止):对设备响应性不定论。
    settleDeviceSend(deviceId, slot, 'inconclusive');
    throw err;
  }
  let result: InvokeResultPayload;
  try {
    // 长执行通道(desktop-cmd:run / worktree:create 等)按协议契约表放宽超时,
    // 与桌面控制端用法对齐,避免 mobile 收紧的默认 15s 误伤合法慢操作。
    result = await client.invoke(
      deviceId,
      { channel, args },
      // 长通道(media / 文件搜索 / schedule 就绪窗口等)按 invokeTimeouts 解析
      // 规则保留更长窗口,避免 mobile 收紧的默认 15s 误伤合法慢操作。
      resolveMobileInvokeTimeoutMs(channel),
    );
  } catch (err) {
    settleDeviceSend(deviceId, slot, classifyDeviceSendFailure(err));
    throw err;
  }
  // 收到 invoke-result 帧即为目标设备真实回包(即使 ok:false 的业务错误)。但
  // dispatch 特判通道(media/voice)的成功不走 IPC/DB 路径,且持有探测席位时
  // 只有指定探测通道能关熔断(纯内存 IPC handler 的回包不算)——按通道 +
  // 席位分类收尾(review P1 多轮收敛,见 classifyDeviceSendSuccess)。
  settleDeviceSend(deviceId, slot, classifyDeviceSendSuccess(channel, slot.decision === 'probe'));
  return unwrapInvoke<T>(result);
}

function sendSubscribeWithAccessHandling(
  client: DeviceLinkClient,
  deviceId: string,
  topics: readonly string[],
): Promise<void> {
  return withAccessRevokedHandling(deviceId, () => sendSubscribe(client, deviceId, topics));
}

async function sendSubscribe(
  client: DeviceLinkClient,
  deviceId: string,
  topics: readonly string[],
): Promise<void> {
  // subscribe 同样走隧道请求超时等待(默认 15s),一样计入并受熔断限制(见 sendInvoke 注释)。
  const slot = acquireDeviceSendSlot(deviceId);
  try {
    await ensureOnlineForRequest(client);
  } catch (err) {
    settleDeviceSend(deviceId, slot, 'inconclusive');
    throw err;
  }
  let result: InvokeResultPayload;
  try {
    result = await client.invoke(deviceId, {
      channel: DL_SUBSCRIBE_CHANNEL,
      args: [{ topics, controllerName: mobileDeviceName() }],
    });
  } catch (err) {
    settleDeviceSend(deviceId, slot, classifyDeviceSendFailure(err));
    throw err;
  }
  // subscribe/unsubscribe 是控制帧,被控端 dispatch 在 runInvoke 之前特判应答
  // (review P1):IPC/DB 卡死时照常回包,成功不能作为熔断恢复证据——探测窗口
  // 到点时页面卸载恰好发的一条控制帧会抢占探测席位并误关熔断。与 openLink
  // 同语义:成功按不定论,超时仍计失败(连控制帧都不应答 = 彻底无响应)。
  settleDeviceSend(deviceId, slot, 'inconclusive');
  unwrapInvoke(result);
}

async function sendUnsubscribe(
  client: DeviceLinkClient,
  deviceId: string,
  topics: readonly string[],
): Promise<void> {
  const slot = acquireDeviceSendSlot(deviceId);
  try {
    await ensureOnlineForRequest(client);
  } catch (err) {
    settleDeviceSend(deviceId, slot, 'inconclusive');
    throw err;
  }
  let result: InvokeResultPayload;
  try {
    result = await client.invoke(deviceId, {
      channel: DL_UNSUBSCRIBE_CHANNEL,
      args: [{ topics }],
    });
  } catch (err) {
    settleDeviceSend(deviceId, slot, classifyDeviceSendFailure(err));
    throw err;
  }
  // 控制帧成功按不定论,不作熔断恢复证据(同 sendSubscribe,review P1)。
  settleDeviceSend(deviceId, slot, 'inconclusive');
  unwrapInvoke(result);
}

function unwrapInvoke<T = unknown>(result: InvokeResultPayload): T {
  if (result.ok) return result.result as T;
  if (result.error.code === 'IPC_ERROR') throw new Error(result.error.message);
  throw new DeviceLinkError(result.error.code, result.error.message);
}

function requireClient(client: DeviceLinkClient | null): DeviceLinkClient {
  if (!client) throw new DeviceLinkError('NOT_CONNECTED', 'device-link client is not ready');
  return client;
}

function clearPresenceWipeTimer(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  deviceId: string,
): void {
  const timer = timers.get(deviceId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(deviceId);
  }
}

function clearPresenceWipeTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function isDeviceLinkTopic(topic: string): boolean {
  return topic === 'sessions' || topic.startsWith('session:');
}

function mobileDeviceName(): string {
  return buildMobileDeviceName({
    constantsDeviceName: Constants.deviceName,
    platform: Platform.OS,
  });
}

type MobileDeviceLinkLogLevel = 'debug' | 'info' | 'warn' | 'error';

const mobileDeviceLinkLogger = {
  debug: (...args: unknown[]) => logMobileDeviceLink('debug', args),
  info: (...args: unknown[]) => logMobileDeviceLink('info', args),
  warn: (...args: unknown[]) => logMobileDeviceLink('warn', args),
  error: (...args: unknown[]) => logMobileDeviceLink('error', args),
};

function logMobileDeviceLink(level: MobileDeviceLinkLogLevel, args: unknown[]): void {
  if (!__DEV__ && level === 'debug') return;
  if (level === 'error') {
    console.error('[device-link]', ...args);
    return;
  }
  if (level === 'warn') {
    console.warn('[device-link]', ...args);
    return;
  }
  if (level === 'info') {
    console.info('[device-link]', ...args);
    return;
  }
  console.debug('[device-link]', ...args);
}

export function useDeviceLink(): DeviceLinkContextValue {
  const ctx = useContext(DeviceLinkContext);
  if (!ctx) throw new Error('useDeviceLink must be used inside DeviceLinkProvider');
  return ctx;
}
