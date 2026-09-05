import Constants from 'expo-constants';
import { confirmTrackedSubscription, SubscriptionAcknowledgements } from './subscriptionAcknowledgements';
import { AppState, Platform } from 'react-native';
import {
  DeviceLinkClient,
  DeviceLinkError,
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
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
  markDeviceFetchEpoch,
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
import {
  handlePeerLinkCloseFrame,
  invalidatePeerLinkState,
  liftRehydrateSuppressionForNewConnection,
  liftRehydrateSuppressionOnExplicitOpen,
  updateRehydrateSuppressionOnLinkClose,
} from '@/device-link/linkClose';
import { resolveMobileInvokeTimeoutMs } from '@/device-link/invokeTimeouts';
import {
  classifySnapshotBatchFailure,
  rehydrateDeviceLinkPeer,
  type DeviceLinkRehydrateSendOptions,
} from '@/device-link/rehydrate';
import {
  PeerRecoveryOpenIntentRegistry,
  PeerRecoveryScheduler,
  type PeerRecoveryResult,
} from '@/device-link/peerRecoveryScheduler';
import {
  invalidateOfflineScheduleIndexFailureFor,
  invalidateScheduleIndexForDevice,
  invalidateTransientScheduleIndexFailureFor,
  invalidateTransientScheduleIndexFailures,
} from '@/session/scheduleIndex';
import { isTransientRemoteError } from '@/device-link/remoteRetry';
import {
  runSessionMessagesSnapshotSingleFlight,
  runSessionPendingInteractionsSnapshotSingleFlight,
  runSessionProjectionSnapshotSingleFlight,
} from '@/device-link/sessionSnapshotSingleFlight';
import { createRnWebSocket } from '@/device-link/rnWebSocket';
import {
  DEVICE_LINK_VOICE_DICTIONARY_SNAPSHOT_CHANNEL,
  type MobileGoalStatusPayload,
  type MobileVoiceDictionarySnapshotResult,
} from '@cindy/maker-shared/device-link-contract';
import {
  DeviceLinkTopicRegistry,
  markHeldRemoteTopicsSubscribed,
  markRemoteTopicsUnsubscribed,
  normalizeDeviceLinkTopics,
  resolvePeerRecoveryPlan,
  topicsMissingRemoteAck,
} from '@/device-link/topicRegistry';
import {
  applyRemoteProjectOrderPush,
  resetRemoteProjectOrderPushFence,
  SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL,
} from '@/session/remoteProjectOrder';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { applyMobileVoiceDictionarySnapshot } from '@/session/mobileVoiceDictionaryCache';
import { revokedDevicesStore } from '@/device-link/revokedDevicesStore';
import {
  acquireDeviceSendSlot,
  buildDeviceResponsivenessProbeArgs,
  classifyDeviceSendFailure,
  classifyDeviceSendSuccess,
  classifyLinkOpenFailure,
  clearDeviceResponsivenessTrackingFor,
  createDeviceSendCohort,
  DEVICE_RESPONSIVENESS_PROBE_CHANNEL,
  isDeviceProbeDue,
  resetDeviceResponsivenessTracking,
  settleDeviceSend,
  unresponsiveDevicesStore,
} from '@/device-link/unresponsiveDevicesStore';
import { remoteScheduleEventStore } from '@/scheduler/remoteScheduleEvents';
import { buildMobileDeviceName } from '@/device-link/mobileDeviceIdentity';
import {
  capturePresenceAvailabilityEpoch,
  clearPresenceWipeTimer,
  clearPresenceWipeTimers,
  createPresenceAvailabilityEpochs,
  extendPresenceWipeTimerFloor,
  getOrCreatePresenceTrackedRequest,
  isInvokeResultReachabilityEvidence,
  isPresenceAvailabilityEpochCurrent,
  isPresenceEligibleForRemoteRequest,
  markPresenceAvailabilityEpoch,
  reconcileAvailabilityAfterInboundFrame,
  reconcileOfflineVerdictAfterResponse,
  type PresenceTrackedRequest,
  type PresenceUnavailableVerdict,
  type PresenceWipeTimerEntry,
  resetPresenceAvailabilityEpochs,
  resetPresenceAvailabilityForConnection,
  schedulePresenceWipeTimer,
  updatePresenceAvailability,
} from '@/device-link/presenceRecovery';
import { hasMoreOlderMessages } from '@/session/messagePaging';
import type { InputProjection, PendingInteraction, RemoteMessage } from '@/session/types';
import { createVisualMockDeviceLinkContext, seedVisualMockStore } from '@/debug/visualMock';

export interface DeviceLinkContextValue {
  status: DeviceLinkStatus;
  /** 连接层可分类的失败原因(鉴权失效/被顶号/超限/版本不符);null = 无异常 */
  connectionIssue: DeviceLinkConnectionIssue | null;
  presenceVersion: number;
  connectionEpoch: number;
  /** Current remote ACK identity; null until every requested topic is confirmed. */
  getSubscriptionIdentity?(deviceId: string, topics: readonly Topic[]): number | null;
  lastPresenceSnapshot: PresenceSnapshot | null;
  /** 当前 relay 连接代内的逐设备 availability；null = 本代尚无权威 verdict。 */
  getPresenceAvailability(deviceId: string): boolean | null;
  openLink(deviceId: string): Promise<LinkAcceptPayload>;
  /** 丢弃已结算的开链缓存并真正重开；并发重开仍按设备单飞。 */
  reopenLink(deviceId: string): Promise<LinkAcceptPayload>;
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
  /** 被控端 runtime Agent roster 发生变化时通知当前控制端页面。 */
  onAgentsChanged: (listener: (deviceId: string) => void) => () => void;
}

const DeviceLinkContext = createContext<DeviceLinkContextValue | null>(null);

/**
 * 本控制端声明的端到端可选能力(link-open 与 subscribe 两处共用同一份,漏一处会让
 * 被控端按能力缺失降级)。被控端只在看到对应能力后才发送新 wire 形状。
 */
const CONTROLLER_CAPABILITIES = [
  CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2,
  // maker:event 微批:被控端把同一会话的连续事件合并成一帧,本端拆包后逐条消费
  // (见 remoteSessionStore 的 MAKER_EVENT_BATCH_CHANNEL 分支)。
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
];

// 任意目标端真实应答的独立时序证据。它不等同于 presence verdict,也不参与 IPC/DB
// 响应性熔断;只用于判定并发返回的 unavailable 是否已被更晚目标应答推翻。
const remoteResponseEvidenceEpochs = createPresenceAvailabilityEpochs();
const remoteResponseEvidenceListeners = new Set<(deviceId: string) => void>();
const remoteAgentRosterListeners = new Set<(deviceId: string) => void>();

// 永久 link-close 后被抑制后台重建的设备(见 updateRehydrateSuppressionOnLinkClose)。
// 模块级(与 remoteResponseEvidenceEpochs 同模式):sendOpenLink 等模块级函数也需要
// 在显式重开成功时解除抑制。解除点:transport-timeout/权威 presence 可用快照/
// 新 relay 连接代际/显式 openLink 成功。
const rehydrateSuppressedDeviceIds = new Set<string>();

function markRemoteResponseEvidence(deviceId: string): void {
  markPresenceAvailabilityEpoch(remoteResponseEvidenceEpochs, deviceId);
  for (const listener of remoteResponseEvidenceListeners) listener(deviceId);
}

function subscribeRemoteResponseEvidence(
  listener: (deviceId: string) => void,
): () => void {
  remoteResponseEvidenceListeners.add(listener);
  return () => remoteResponseEvidenceListeners.delete(listener);
}

function subscribeRemoteAgentRoster(
  listener: (deviceId: string) => void,
): () => void {
  remoteAgentRosterListeners.add(listener);
  return () => remoteAgentRosterListeners.delete(listener);
}

/**
 * 退后台断开连接前的宽限:几秒内切回前台的快速 App 切换不触发整套
 * 断连 → 重连 → 补齐,弱网下这套循环的代价远高于让 socket 多活两秒。
 */
const BACKGROUND_STOP_GRACE_MS = 2_500;
/** 断开前最多等最后一轮 heavy unsubscribe 应答;超时仍停止,避免后台 socket 久留。 */
const BACKGROUND_FINAL_UNSUBSCRIBE_WAIT_MS = 1_000;
/**
 * 回前台时若「宽限计时器还挂着」但后台时长已超过此阈值,说明 JS 在计时器触发前
 * 被 iOS 挂起——socket 大概率已被系统回收,但状态机还认为 online。此时主动换新
 * 连接,别等心跳(~20s)才发现假活。
 */
const BACKGROUND_SUSPEND_SUSPECT_MS = 10_000;

/** 桌面端 presence 闪断宽限:短暂离线不立刻清空该设备的会话镜像与能力缓存。 */
const PRESENCE_OFFLINE_WIPE_GRACE_MS = 5_000;

/**
 * 重连刚 online 时给乐观补齐留出的最小确认窗:覆盖连接就绪等待(1.5s)与
 * 一次普通 invoke 往返,但只在旧 timer 剩余时间更短时向后延,不随抖动无限重置。
 */
const RECONNECT_MIN_WIPE_GRACE_MS = 3_000;
/**
 * 断连补齐时拉的最新窗口大小。与 `hasMoreOlderMessages` 的判定共用同一个数:满页即说明这一页
 * 上沿之外服务端还有历史,store 据此丢弃无法确认相接的更早缓存段(见 setLatestMessageWindow
 * 与 #1222)。
 */
const RECONNECT_MESSAGE_WINDOW_LIMIT = 80;
// Provider remount / account switch must not reuse an in-flight snapshot key
// from an older DeviceLinkClient instance. Keep epochs process-monotonic.
let nextDeviceLinkConnectionEpoch = 0;

const SESSION_TOPIC_PREFIX = 'session:';

/**
 * `session:<id>` 订阅停了 = 该会话的实时行从此不再送到本端(退后台释放重量级订阅、离开会话
 * 取消订阅)。窗口「已验证连续」区间的上界因此不能再被之后到达的 push 续算 —— 与它之间可能漏了
 * 任意多行(见 remoteSessionStore 的 sessionWindowCoverage)。socket 掉线走不带 sessionId 的整体
 * 失效:那影响所有订阅。
 */
function noteSessionLiveStreamsInterrupted(topics: readonly string[]): void {
  for (const topic of topics) {
    if (!topic.startsWith(SESSION_TOPIC_PREFIX)) continue;
    const sessionId = topic.slice(SESSION_TOPIC_PREFIX.length);
    if (sessionId) remoteSessionStore.noteLiveStreamInterrupted(sessionId);
  }
}

/**
 * `session:<id>` 订阅被远端 ACK = 从此刻起该会话的行会被推过来。屏幕侧刻意不等 ACK 就拉页
 * (`void subscribe(...)`),所以「页落库时订阅是否已 ACK」正是 store 判断尾部可不可信的依据
 * (见 remoteSessionStore 的 `liveTailTrusted`)。ACK 本身不点亮既有区间:ACK 之前的空窗里可能
 * 已经漏了行。
 */
function noteSessionLiveStreamsAcked(topics: readonly string[]): void {
  for (const topic of topics) {
    if (!topic.startsWith(SESSION_TOPIC_PREFIX)) continue;
    const sessionId = topic.slice(SESSION_TOPIC_PREFIX.length);
    if (sessionId) remoteSessionStore.noteLiveStreamAcked(sessionId);
  }
}

export function DeviceLinkProvider({ children }: { children: ReactNode }) {
  if (MOBILE_VISUAL_MOCK_ENABLED) {
    return <VisualMockDeviceLinkProvider>{children}</VisualMockDeviceLinkProvider>;
  }

  const auth = useAuth();
  const currentDataOwnerIdRef = useRef<string | null>(auth.user?.id ?? null);
  currentDataOwnerIdRef.current = auth.user?.id ?? null;
  const clientRef = useRef<DeviceLinkClient | null>(null);
  const registryRef = useRef(new DeviceLinkTopicRegistry());
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const remoteSubscribedTopicsRef = useRef(new SubscriptionAcknowledgements(
    () => setSubscriptionVersion((version) => version + 1),
  ));
  // A local reliable ACK reset may happen after the last durable topic/open owner is gone,
  // while the client still holds an in-flight reliable frame. Preserve a per-peer transient
  // open intent until that exact peer is ready again; never promote it to a shared WSS reset.
  const forcedPeerRecoveryIntentRef = useRef(new PeerRecoveryOpenIntentRegistry());
  // 每台远端的补齐任务、rerun 与退避均由自己的状态槽管理；调度器只共享最多
  // 六个并发恢复名额，不共享失败结论。run callback 经 ref 接最新 React 闭包。
  const runPeerRecoveryRef = useRef<(deviceId: string) => Promise<PeerRecoveryResult>>(
    async () => ({ retry: false }),
  );
  const peerRecoverySchedulerRef = useRef<PeerRecoveryScheduler | null>(null);
  if (!peerRecoverySchedulerRef.current) {
    peerRecoverySchedulerRef.current = new PeerRecoveryScheduler(
      (deviceId) => runPeerRecoveryRef.current(deviceId),
      {
        onError: (deviceId, error) => mobileDeviceLinkLogger.warn(
          `peer recovery failed unexpectedly device=${deviceId.slice(0, 8)}`,
          error,
        ),
      },
    );
  }
  const presenceWipeTimersRef = useRef(
    new Map<string, PresenceWipeTimerEntry>(),
  );
  const openLinkInFlightRef = useRef(
    new Map<string, PresenceTrackedRequest<LinkAcceptPayload>>(),
  );
  const presenceWipeTimerDeps = useMemo(() => ({
    ...basePresenceWipeTimerDeps,
    isConfirmationInFlight: (deviceId: string) =>
      openLinkInFlightRef.current.get(deviceId)?.pending === true,
  }), []);
  const presenceAvailableByDeviceRef = useRef(new Map<string, boolean>());
  const presenceAvailabilityEpochsRef = useRef(createPresenceAvailabilityEpochs());
  const presencePendingRecoveryDeviceIdsRef = useRef(new Set<string>());
  const presenceUnavailableVerdictsRef = useRef(
    new Map<string, PresenceUnavailableVerdict>(),
  );
  // 后台释放 heavy session 订阅期间仍保留 registry 所有权;此时 unsubscribe ack
  // 可以修正 stale offline verdict,但不能顺带触发 rehydrate 把刚释放的订阅加回来。
  const backgroundReleaseInFlightRef = useRef(false);
  // 每次后台释放都翻代。subscribe 即使跨 background→active 才收到 ACK,也只能在
  // 发起代仍为当前代时登记远端 ACK,避免迟到成功覆盖较新的 unsubscribe。
  const backgroundReleaseGenerationRef = useRef(0);
  const [status, setStatus] = useState<DeviceLinkStatus>('stopped');
  const [connectionIssue, setConnectionIssue] = useState<DeviceLinkConnectionIssue | null>(null);
  const [presenceVersion, setPresenceVersion] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  // status callback 中先同步推进 ref，再触发 rehydrate；React state 的下一次 render
  // 才会把同一代暴露给页面。这样全局补齐与页面首开使用完全相同的 single-flight key。
  const connectionEpochRef = useRef(0);
  const [lastPresenceSnapshot, setLastPresenceSnapshot] = useState<PresenceSnapshot | null>(null);
  const accountGenerationRef = useRef<number | null>(null);

  const clearPerAccountDeviceLinkState = useCallback(() => {
    remoteSessionStore.clear();
    remoteScheduleEventStore.clearAll();
    revokedDevicesStore.clearAll();
    resetDeviceResponsivenessTracking();
    clearAllDeviceProviders();
    clearAllDeviceModelMeta();
    resetAgentCapabilitiesCache();
    resetComposerPaletteCache();
    setLastPresenceSnapshot(null);
    setPresenceVersion((version) => version + 1);
  }, []);

  /**
   * availability 放在 ref 里供 transport 同步读取；每次真实的三态变化也必须发布给
   * Context consumers。before / after 比较避免 rehydrate 重试重复写 false 时制造
   * 无意义渲染，也避免只清 verdict、availability 仍为 unknown 时误报变化。
   */
  const publishPresenceAvailabilityMutation = useCallback(<T,>(
    deviceId: string,
    mutate: (availabilityByDevice: Map<string, boolean>) => T,
  ): T => {
    const availabilityByDevice = presenceAvailableByDeviceRef.current;
    const before = availabilityByDevice.get(deviceId) ?? null;
    const result = mutate(availabilityByDevice);
    const after = availabilityByDevice.get(deviceId) ?? null;
    if (before !== after) setPresenceVersion((version) => version + 1);
    return result;
  }, []);

  const sendOpenLinkOnce = useCallback((
    client: DeviceLinkClient,
    deviceId: string,
    allowProbe = false,
    refreshSettled = false,
  ) => {
    return getOrCreatePresenceTrackedRequest(
      openLinkInFlightRef.current,
      presenceAvailabilityEpochsRef.current,
      remoteResponseEvidenceEpochs,
      deviceId,
      () => sendOpenLinkWithAccessHandling(client, deviceId, allowProbe),
      { retainSuccessful: true, refreshSettled },
    );
  }, []);

  const sendTrackedSubscribe = useCallback(async (
    client: DeviceLinkClient,
    deviceId: string,
    topics: readonly Topic[],
  ) => {
    const releaseGeneration = backgroundReleaseGenerationRef.current;
    const startedAt = Date.now();
    await confirmTrackedSubscription({
      isCurrent: () => !backgroundReleaseInFlightRef.current
        && backgroundReleaseGenerationRef.current === releaseGeneration && clientRef.current === client,
      generation: () => `${connectionEpochRef.current}:${remoteSubscribedTopicsRef.current.generation(deviceId)}`,
      missing: () => topicsMissingRemoteAck(remoteSubscribedTopicsRef.current, deviceId, topics)
        .filter((topic) => registryRef.current.hasTopic(deviceId, topic)),
      send: (toSend) => sendSubscribeWithAccessHandling(
        client,
        deviceId,
        toSend,
        () => (
          !backgroundReleaseInFlightRef.current
          && toSend.every((topic) => registryRef.current.hasTopic(deviceId, topic))
        ),
      ),
      acknowledge: (toSend) => {
        // 只有仍被持有、真正记进 ACK 表的 topic 才算订阅生效(中途被释放的那些不算)。
        noteSessionLiveStreamsAcked(
          markHeldRemoteTopicsSubscribed(remoteSubscribedTopicsRef.current, registryRef.current, deviceId, toSend),
        );
        console.debug('[device-link] recovery subscription acknowledged', { elapsedMs: Date.now() - startedAt });
      },
    });
  }, []);

  // 熔断 open 设备的显式代表性探测:openLink 建链(成功按不定论,不关熔断),
  // 再发一条真正穿过被控端 runInvoke → dispatchLocalInvoke → local-db 的最小读,
  // 由 sendInvoke 内部的熔断收尾决定开合(真实回包 → 关;超时 → 加深退避)。
  // 错误全吞:结果已在 send 层按熔断语义上报,这里不需要二次处理。
  const probeUnresponsiveDevice = useCallback(
    async (client: DeviceLinkClient, deviceId: string): Promise<void> => {
      try {
        await sendOpenLinkOnce(client, deviceId, true).request;
        await sendInvokeWithAccessHandling(
          client,
          deviceId,
          DEVICE_RESPONSIVENESS_PROBE_CHANNEL,
          buildDeviceResponsivenessProbeArgs(),
          { allowProbe: true },
        );
      } catch {
        // swallow — settle 已在 sendOpenLink / sendInvoke 内完成。
      }
    },
    [sendOpenLinkOnce],
  );

  const hasOutboundPeerRecoveryIntent = useCallback((
    client: DeviceLinkClient,
    deviceId: string,
  ) => (
    !client.isOutboundExplicitlyClosed(deviceId)
    && (
      registryRef.current.snapshotDevice(deviceId) !== null
      || client.hasPendingRequestsTo(deviceId)
    )
  ), []);

  const requestForcedPeerRecovery = useCallback((
    client: DeviceLinkClient,
    deviceId: string,
  ): boolean => {
    if (!hasOutboundPeerRecoveryIntent(client, deviceId)) {
      forcedPeerRecoveryIntentRef.current.cancel(deviceId);
      return false;
    }
    forcedPeerRecoveryIntentRef.current.request(deviceId);
    return true;
  }, [hasOutboundPeerRecoveryIntent]);

  const runPeerRecovery = useCallback(async (
    client: DeviceLinkClient,
    targetDeviceId: string,
  ): Promise<PeerRecoveryResult> => {
    if (
      client !== clientRef.current
      || client.getStatus() !== 'online'
      || backgroundReleaseInFlightRef.current
    ) {
      return { retry: false };
    }

    // 撤权、权威离线、远控关闭和永久 link-close 都只终止本 peer 的恢复。
    if (
      revokedDevicesStore.has(targetDeviceId)
      || client.isOutboundExplicitlyClosed(targetDeviceId)
      || !isPresenceEligibleForRemoteRequest(
        presenceAvailableByDeviceRef.current,
        targetDeviceId,
      )
      || rehydrateSuppressedDeviceIds.has(targetDeviceId)
    ) {
      return { retry: false };
    }

    // 熔断 peer 只跑自己的代表性探测；它等待/超时不会占住其它设备的恢复状态。
    if (unresponsiveDevicesStore.has(targetDeviceId)) {
      if (isDeviceProbeDue(targetDeviceId)) {
        await probeUnresponsiveDevice(client, targetDeviceId);
      }
      return { retry: unresponsiveDevicesStore.has(targetDeviceId) };
    }

    const durablePlan = registryRef.current.snapshotDevice(targetDeviceId);
    const forcedGeneration = forcedPeerRecoveryIntentRef.current.getGeneration(targetDeviceId);
    const forcedOpen = forcedGeneration !== undefined
      && hasOutboundPeerRecoveryIntent(client, targetDeviceId);
    if (forcedGeneration !== undefined && !forcedOpen) {
      forcedPeerRecoveryIntentRef.current.cancel(targetDeviceId);
    }
    const plan = resolvePeerRecoveryPlan(
      targetDeviceId,
      durablePlan,
      forcedOpen,
    );
    if (!plan) return { retry: false };

    // 只清当前 peer 在断线窗口留下的瞬时负缓存，避免 A 的恢复改变 B 的节流状态。
    invalidateTransientScheduleIndexFailureFor(targetDeviceId);
    const result = await rehydrateDeviceLinkPeer(plan, {
      isCancelled: () => (
        backgroundReleaseInFlightRef.current
        || client !== clientRef.current
        || client.getStatus() !== 'online'
        || revokedDevicesStore.has(targetDeviceId)
        || client.isOutboundExplicitlyClosed(targetDeviceId)
        || !isPresenceEligibleForRemoteRequest(
          presenceAvailableByDeviceRef.current,
          targetDeviceId,
        )
        || rehydrateSuppressedDeviceIds.has(targetDeviceId)
        || unresponsiveDevicesStore.has(targetDeviceId)
      ),
      capturePresenceEpoch: (deviceId) =>
        capturePresenceAvailabilityEpoch(
          presenceAvailabilityEpochsRef.current,
          deviceId,
        ),
      captureResponseEvidenceEpoch: (deviceId) =>
        capturePresenceAvailabilityEpoch(
          remoteResponseEvidenceEpochs,
          deviceId,
        ),
      isPresenceEpochCurrent: (deviceId, capturedPresenceEpoch) =>
        isPresenceAvailabilityEpochCurrent(
          presenceAvailabilityEpochsRef.current,
          deviceId,
          capturedPresenceEpoch,
        ),
      isResponseEvidenceEpochCurrent: (
        deviceId,
        capturedResponseEvidenceEpoch,
      ) => isPresenceAvailabilityEpochCurrent(
        remoteResponseEvidenceEpochs,
        deviceId,
        capturedResponseEvidenceEpoch,
      ),
      createDeviceSendCohort: (deviceId) => createDeviceSendCohort(deviceId),
      openLink: (deviceId) => sendOpenLinkOnce(client, deviceId),
      subscribe: (deviceId, topics) => sendTrackedSubscribe(client, deviceId, topics),
      requestSessionsReseed: (deviceId) => remoteSessionStore.requestReseed(deviceId),
      onDeviceReachable: (deviceId) => {
        // 重连后没有全量 presence；目标端真实应答足以收口上一代遗留清理，
        // 但不伪造 available=true，仍服从之后到达的权威 presence。
        clearOnePresenceWipeTimer(presenceWipeTimersRef.current, deviceId);
        remoteScheduleEventStore.clearDeviceMirrorInvalidation(deviceId);
        invalidateOfflineScheduleIndexFailureFor(deviceId);
      },
      onDeviceRemoteDisabled: (deviceId) => {
        clearOnePresenceWipeTimer(presenceWipeTimersRef.current, deviceId);
        publishPresenceAvailabilityMutation(deviceId, (availabilityByDevice) => {
          availabilityByDevice.set(deviceId, false);
        });
        presenceUnavailableVerdictsRef.current.set(deviceId, {
          kind: 'disabled',
          responseEvidenceEpoch: capturePresenceAvailabilityEpoch(
            remoteResponseEvidenceEpochs,
            deviceId,
          ),
        });
        presencePendingRecoveryDeviceIdsRef.current.add(deviceId);
        clearDeviceResponsivenessTrackingFor(deviceId);
        remoteSubscribedTopicsRef.current.delete(deviceId);
        wipeUnavailableDeviceMirror(deviceId);
      },
      onDeviceUnavailable: (deviceId) => {
        publishPresenceAvailabilityMutation(deviceId, (availabilityByDevice) => {
          availabilityByDevice.set(deviceId, false);
        });
        presenceUnavailableVerdictsRef.current.set(deviceId, {
          kind: 'offline',
          responseEvidenceEpoch: capturePresenceAvailabilityEpoch(
            remoteResponseEvidenceEpochs,
            deviceId,
          ),
        });
        presencePendingRecoveryDeviceIdsRef.current.add(deviceId);
        clearDeviceResponsivenessTrackingFor(deviceId);
        remoteSubscribedTopicsRef.current.delete(deviceId);
        scheduleUnavailableDeviceMirrorWipe(
          presenceWipeTimersRef.current,
          presenceAvailableByDeviceRef.current,
          deviceId,
          presenceWipeTimerDeps,
        );
      },
      rebuildSessionSnapshot: (deviceId, sessionId, opts) => rebuildSessionSnapshot(
        client,
        deviceId,
        sessionId,
        connectionEpochRef.current,
        opts,
      ),
    });

    if (
      forcedGeneration !== undefined
      && result.linkOpened
      && client === clientRef.current
      && forcedPeerRecoveryIntentRef.current.complete(targetDeviceId, forcedGeneration)
    ) {
      // `complete` performs the generation-checked removal in the condition above.
    }
    const forcedOpenStillPending = forcedPeerRecoveryIntentRef.current.has(targetDeviceId)
      && client === clientRef.current
      && client.getStatus() === 'online'
      && !revokedDevicesStore.has(targetDeviceId)
      && hasOutboundPeerRecoveryIntent(client, targetDeviceId)
      && isPresenceEligibleForRemoteRequest(
        presenceAvailableByDeviceRef.current,
        targetDeviceId,
      )
      && !rehydrateSuppressedDeviceIds.has(targetDeviceId);
    return {
      retry: result.transientFailures > 0
        || unresponsiveDevicesStore.has(targetDeviceId)
        || forcedOpenStillPending,
    };
  }, [
    probeUnresponsiveDevice,
    hasOutboundPeerRecoveryIntent,
    publishPresenceAvailabilityMutation,
    sendOpenLinkOnce,
    sendTrackedSubscribe,
  ]);

  const rehydrateWithClient = useCallback((
    client: DeviceLinkClient,
    targetDeviceId?: string,
  ): Promise<void> => {
    if (
      client !== clientRef.current
      || client.getStatus() !== 'online'
      || backgroundReleaseInFlightRef.current
    ) {
      return Promise.resolve();
    }
    const scheduler = peerRecoverySchedulerRef.current;
    scheduler?.resume();
    if (targetDeviceId) {
      scheduler?.request(targetDeviceId);
    } else {
      // Relay 重连 / App 回前台是共享生命周期事件：即使某设备此刻没有持有
      // topic，它此前因 WSS 掉线留下的 NOT_CONNECTED 负缓存也已经失效。
      // 单 peer 恢复不会走这里，仍只清自己的缓存。
      invalidateTransientScheduleIndexFailures();
      const deviceIds = new Set(registryRef.current.deviceIds());
      for (const deviceId of forcedPeerRecoveryIntentRef.current.deviceIds()) {
        deviceIds.add(deviceId);
      }
      for (const deviceId of unresponsiveDevicesStore.getSnapshot()) {
        deviceIds.add(deviceId);
      }
      scheduler?.requestMany(deviceIds);
    }
    return Promise.resolve();
  }, []);

  useEffect(() => {
    runPeerRecoveryRef.current = (deviceId) => {
      const client = clientRef.current;
      if (!client) return Promise.resolve({ retry: false });
      return runPeerRecovery(client, deviceId);
    };
  }, [runPeerRecovery]);

  useEffect(() => {
    const accountGenerationChanged =
      accountGenerationRef.current !== auth.accountGeneration;
    accountGenerationRef.current = auth.accountGeneration;
    if (!auth.isAuthenticated) {
      clientRef.current?.stop();
      clientRef.current = null;
      registryRef.current.clear();
      remoteSubscribedTopicsRef.current.clear();
      forcedPeerRecoveryIntentRef.current.clear();
      peerRecoverySchedulerRef.current?.clear();
      clearAllPresenceWipeTimers(presenceWipeTimersRef.current);
      openLinkInFlightRef.current.clear();
      presenceAvailableByDeviceRef.current.clear();
      resetPresenceAvailabilityEpochs(presenceAvailabilityEpochsRef.current);
      resetPresenceAvailabilityEpochs(remoteResponseEvidenceEpochs);
      presencePendingRecoveryDeviceIdsRef.current.clear();
      presenceUnavailableVerdictsRef.current.clear();
      backgroundReleaseInFlightRef.current = false;
      setStatus('stopped');
      setConnectionIssue(null);
      // 登出 / 进程内切号:清掉所有 per-account 残留,避免下一个账号串到上一个账号的数据。
      // - 供应商目录是 module 级单例缓存(useDeviceProviders 按 deviceId 命中),不随组件卸载清;
      // - lastPresenceSnapshot 是本 context 的 state,home 屏据它 patch 设备列表。
      // 二者若不重置,切号后会短暂看到 / 用到上一个账号的桌面端与供应商数据。
      clearPerAccountDeviceLinkState();
      return;
    }

    // 账号切换期间 isAuthenticated 始终为 true，不能依赖上面的登出分支。
    // effect cleanup 只负责 transport；新账号建连前必须同步清掉旧账号的任务、
    // 调度、设备与 presence 投影，避免无设备的新账号永远保留旧快照。
    if (accountGenerationChanged) {
      clearPerAccountDeviceLinkState();
      // Topic intent is account-owned too. Keeping the previous account's owners here would make
      // the new client's first online recovery subscribe device ids that its Home never selected.
      registryRef.current.clear();
      remoteSubscribedTopicsRef.current.clear();
      forcedPeerRecoveryIntentRef.current.clear();
    }

    // 新账号/新 client 必须从空的 peer 生命周期表开始；旧连接迟到的恢复结果
    // 会被 scheduler generation 丢弃，不能写回新账号。
    peerRecoverySchedulerRef.current?.clear();
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
      // Mobile 具备按 deviceId 独立 openLink/订阅/快照恢复能力。可靠 ACK
      // 耗尽时只复位该 peer，共享 WSS 和其它远端继续工作；恢复仍只使用所有
      // Desktop 版本都支持的 link-open，不增加 wire/capability 要求。
      peerFailurePolicy: 'isolate-peer',
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
        // 掉线:所有会话的实时行都可能从此漏收,窗口连续性结论的上界不再可续算。
        remoteSessionStore.noteLiveStreamInterrupted();
        // Relay 连接故障才暂停全部 peer；重新 online 后它们各自重新进入恢复队列。
        peerRecoverySchedulerRef.current?.pause();
        return;
      }
      // presence 是当前在线控制端收到的 delta,server 不会在 hello-ack 后重放
      // 全量快照。进入新连接代际先丢弃旧 verdict:后台期间若设备从 unavailable
      // 恢复,旧 false 不能永久挡住本轮 rehydrate。上一代仍 pending 的镜像清理
      // 保留原宽限截止点:计时器把新连接尚无 verdict 的 unknown 当作未确认恢复,
      // 只有当前代明确 available=true 才取消,避免重连瞬间按旧 false 提前清空镜像。
      const staleUnavailableDeviceIds = resetPresenceAvailabilityForConnection(
        presenceAvailableByDeviceRef.current,
        presencePendingRecoveryDeviceIdsRef.current,
      );
      // 新连接代际 = 世界重置:永久关闭抑制不跨代际(断线期间对方状态未知,
      // 新代按乐观补齐;若对方仍拒绝,入站永久 link-close 会重新建立抑制)。
      liftRehydrateSuppressionForNewConnection(rehydrateSuppressedDeviceIds);
      // 上一连接代的 rehydrate verdict 已被降为 unknown;新连接的 late response
      // 不能再借旧 verdict 清理当前代状态。权威 presence 会在 delta 到达时重建。
      for (const deviceId of staleUnavailableDeviceIds) {
        presenceUnavailableVerdictsRef.current.delete(deviceId);
      }
      for (const deviceId of staleUnavailableDeviceIds) {
        extendPresenceWipeTimerFloor(
          presenceWipeTimersRef.current,
          presenceAvailableByDeviceRef.current,
          deviceId,
          RECONNECT_MIN_WIPE_GRACE_MS,
          presenceWipeTimerDeps,
        );
      }
      connectionEpochRef.current = ++nextDeviceLinkConnectionEpoch;
      setConnectionEpoch(connectionEpochRef.current);
      resetRemoteProjectOrderPushFence();
      void rehydrateWithClient(client);
    });
    const offPeerTransportReset = client.onPeerTransportReset(({ deviceId }) => {
      // 这是本地 ACK 超时，不是对端可达证据：只失效该 peer 的建链缓存和
      // 订阅 ACK，再排该 peer 恢复；presence、其它 peer 与共享 WSS 均不动。
      resetRemoteProjectOrderPushFence(deviceId);
      const shouldRecover = requestForcedPeerRecovery(client, deviceId);
      invalidatePeerLinkState(
        deviceId,
        openLinkInFlightRef.current,
        remoteSubscribedTopicsRef.current,
        noteSessionLiveStreamsInterrupted,
      );
      if (shouldRecover) void rehydrateWithClient(client, deviceId);
    });
    const offPresence = client.onPresenceChanged((snap) => {
      markPresenceAvailabilityEpoch(presenceAvailabilityEpochsRef.current, snap.deviceId);
      // presence 变化代表目标链路代际变化(offline / remote-disabled / 恢复都一样):
      // 上一代成功 link 不能跨代复用,下一次请求必须重新 link-open 确认。
      openLinkInFlightRef.current.delete(snap.deviceId);
      setLastPresenceSnapshot(snap);
      setPresenceVersion((n) => n + 1);
      const presence = updatePresenceAvailability(
        presenceAvailableByDeviceRef.current,
        snap,
        presencePendingRecoveryDeviceIdsRef.current,
      );
      if (presence.available) {
        presenceUnavailableVerdictsRef.current.delete(snap.deviceId);
      } else {
        // Relay presence 是权威 availability verdict,普通目标应答不能推翻。
        presenceUnavailableVerdictsRef.current.set(snap.deviceId, {
          kind: 'presence',
          responseEvidenceEpoch: capturePresenceAvailabilityEpoch(
            remoteResponseEvidenceEpochs,
            snap.deviceId,
          ),
        });
      }
      const wipeTimers = presenceWipeTimersRef.current;
      if (!presence.available) {
        // 权威离线/关闭远控只取消对应 peer，不碰其它远端的在途恢复与退避。
        peerRecoverySchedulerRef.current?.cancel(snap.deviceId);
        // Relay 的权威 presence 已说明目标离线或关闭远控:此前 INVOKE_TIMEOUT
        // 只能视为这次可用性变化的下游症状,不再代表桌面 IPC/DB 卡死。立即清除
        // 响应性计数并翻代,让在途请求随后到达的 timeout 也无法重建误熔断。
        // 清理响应性状态会触发 rehydrate,但 presence 仍是 unavailable 时该设备会被
        // availablePlans 过滤,不再立即重放一批注定 DEVICE_OFFLINE 的请求。
        clearDeviceResponsivenessTrackingFor(snap.deviceId);
        // 订阅跟踪必须立即失效(不进宽限):桌面端断开可能已丢失订阅者状态,
        // 恢复后的 rehydrate 靠 topicsMissingRemoteAck 判断要不要重发 subscribe,
        // 跟踪不清会误判「已订阅」而跳过重订阅,push 流静默断掉。重订阅本身
        // 便宜且服务端幂等;需要宽限的只是下面会引起界面闪烁的缓存清理。
        remoteSubscribedTopicsRef.current.delete(snap.deviceId);
        if (snap.online && !snap.remoteControlEnabled) {
          // 用户在桌面端显式关闭了远控:立即清,镜像不该多留一秒
          clearOnePresenceWipeTimer(wipeTimers, snap.deviceId);
          wipeUnavailableDeviceMirror(snap.deviceId);
          return;
        }
        // 桌面端离线:给一个短宽限。弱网下桌面端会反复闪断,每次都立即清空
        // 会话镜像 + 能力缓存会让手机端界面整片消失重建、随后一轮 re-fetch 风暴;
        // 宽限内恢复在线则取消清理(presence.recovered 分支照常触发补齐)。
        scheduleUnavailableDeviceMirrorWipe(
          wipeTimers,
          presenceAvailableByDeviceRef.current,
          snap.deviceId,
          presenceWipeTimerDeps,
        );
        return;
      }
      clearOnePresenceWipeTimer(wipeTimers, snap.deviceId);
      remoteScheduleEventStore.clearDeviceMirrorInvalidation(snap.deviceId);
      // 每个「可用」快照都清该设备的 DEVICE_OFFLINE 负缓存(review P1 ×2):
      // 主机在手机连上 relay 之前就离线时,presence 只在变化时广播,首个在线
      // 快照 recovered=false——只挂 recovered 会漏掉这次恢复,徽标停留到无关
      // 触发。逐设备且幂等(map 单点查删),不影响其它设备的风暴止损。
      invalidateOfflineScheduleIndexFailureFor(snap.deviceId);
      // 注意:普通 available=true 快照**不**解除永久关闭后的重建抑制——在线
      // ≠ 对方重新授权或本机用户主动重开(对方结束链路后一直在线是常态)。
      // 解除点只有:transport-timeout / 新连接代际 / 显式 openLink 成功
      // (见 linkClose.ts 的具名 lift 入口)。
      if (presence.recovered) void rehydrateWithClient(client, snap.deviceId);
    });
    const offFrame = client.onFrame((env) => routeFrame(env, {
      currentDataOwnerId: currentDataOwnerIdRef.current,
      onAccessRevoked: (deviceId) => {
        remoteSubscribedTopicsRef.current.delete(deviceId);
        forcedPeerRecoveryIntentRef.current.cancel(deviceId);
        peerRecoverySchedulerRef.current?.cancel(deviceId);
      },
      onLinkClosed: (deviceId, reason) => {
        resetRemoteProjectOrderPushFence(deviceId);
        updateRehydrateSuppressionOnLinkClose(
          rehydrateSuppressedDeviceIds,
          deviceId,
          reason,
        );
        invalidatePeerLinkState(
          deviceId,
          openLinkInFlightRef.current,
          remoteSubscribedTopicsRef.current,
          noteSessionLiveStreamsInterrupted,
        );
        // transport-timeout = 被控端对本机的可靠重试耗尽后的 peer 级瞬时重置
        // (relay 保持在线,不会有 presence 变化来触发恢复)。立即 rehydrate
        // 重建链路与订阅:入口自带 online 检查、in-flight 去重与退避,幂等。
        // 其它 reason(user/toggle-off/shutdown/revoked)维持原语义:只失效,
        // 不自动重建。
        if (reason === 'transport-timeout') {
          const shouldRecover = requestForcedPeerRecovery(client, deviceId);
          // 收到该帧本身就是对端可达的直接证据:先冲销遗留的 presence=false /
          // 离线判定(否则本轮 rehydrate 会把该设备从 availablePlans 排除,
          // 重建根本不会发起)。两段冲销:markRemoteResponseEvidence 走既有
          // 证据链(epoch 比较,推翻并发窗口内的 offline verdict);
          // reconcileAvailabilityAfterInboundFrame 补盖无 verdict 的 stale
          // presence=false(入站帧无时序歧义,disabled 判定仍保留)。
          // revoked/熔断/in-flight 去重等保护由 rehydrate 自身的既有门把守。
          markRemoteResponseEvidence(deviceId);
          publishPresenceAvailabilityMutation(deviceId, (availabilityByDevice) => (
            reconcileAvailabilityAfterInboundFrame(
              availabilityByDevice,
              presencePendingRecoveryDeviceIdsRef.current,
              presenceUnavailableVerdictsRef.current,
              deviceId,
            )
          ));
          // 直接可达证据必须同步收口此前 unavailable presence 建的镜像清理
          // 计时器:该 timer 的触发条件是 availability 非明确 true——若随后的
          // open/subscribe/rehydrate 瞬时失败或停在 unknown,遗留 timer 仍会
          // 把刚被本帧证明可达的设备的会话/调度/能力镜像误删。
          // (markRemoteResponseEvidence 的证据链只在命中可推翻的 offline
          // verdict 时才顺带清 timer,覆盖不了无 verdict 的 stale 路径。)
          clearOnePresenceWipeTimer(presenceWipeTimersRef.current, deviceId);
          if (shouldRecover) void rehydrateWithClient(client, deviceId);
        } else {
          forcedPeerRecoveryIntentRef.current.cancel(deviceId);
        }
      },
      onProviderChanged: (deviceId) => {
        // provider 目录与 capabilities.availableModels 是同一份 active catalog 的两种视图。
        // 同时驱逐并后台重拉；页面保留旧画面，当前代完整快照提交后由订阅一次性更新。
        evictDeviceProviders(deviceId);
        evictAgentCapabilitiesForDevice(deviceId);
        const epochAtWrite = connectionEpoch;
        void fetchDeviceProviders(deviceId, () =>
          sendInvokeWithAccessHandling<DeviceProvidersPayload>(
            client,
            deviceId,
            'maker:provider:list',
            [{ capabilities: [CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2] }],
          )
        )
          .then(() => {
            // 无挂载 hook 的后台缓存写入也要标记所属连接代际(codex review P1):
            // 不 mark 则 deviceFetchEpoch 保持 undefined,断线前旧目录在重连后被
            // 当「首次挂载缓存命中」采信、永不刷新——选择器无限期展示已删供应商。
            // fetch 期间重连(epoch 变化)则 mark 的是捕获时的旧代际 → 下次 effect
            // 判 reconnected → 强制 fresh(保守正确)。失败不 mark(evict 已清缓存,
            // 无旧目录可被误采信)。
            markDeviceFetchEpoch(deviceId, epochAtWrite);
          })
          .catch(() => { /* 下次进入选择器或重连补齐时继续重试。 */ });
        void refreshDeviceCapabilities(client, deviceId);
      },
      onAgentsChanged: (deviceId) => {
        for (const listener of remoteAgentRosterListeners) listener(deviceId);
      },
    }));
    // 与 transport-timeout link-close 同族的链路死锁自救(互为兜底):对端还在按
    // 可靠流给本机发帧,而本机侧 link 未就绪——典型成因是 link-accept 在弱网丢失
    // 后互等(发送端等 ACK、接收端等 link)。transport-timeout 是对端主动通知
    // (best-effort,本身可能丢帧);本回调是本机从入站帧自行推断,通知丢了也能
    // 自救。client 层已做 30s/peer 节流。收到帧即对端可达的直接证据,处理与
    // transport-timeout 分支一致:冲销遗留离线判定 → rehydrate 重建链路与订阅
    // (online 检查 / in-flight 去重 / 退避 / revoked 与永久关闭抑制等既有门全部
    // 由 rehydrate 把守;特别地,永久关闭抑制**不在此解除**——对端用户显式关闭
    // 后即使迟到帧还在飞,也不把用户关掉的链路自动建回来)。
    const offBeforeLink = client.onReliableFrameBeforeLink((deviceId) => {
      // 先失效 peer 级缓存(与 transport-timeout 分支同序):收到 before-link 帧
      // 说明 client 层 link 已不在就绪态,但 openLinkInFlightRef 可能还留着已
      // resolved 的旧建链结果、remoteSubscribedTopicsRef 还留着旧 ACK——不清掉,
      // rehydrate 会复用旧 open、跳过 subscribe,后续请求继续排进未就绪的可靠流
      // (review P2)。
      invalidatePeerLinkState(
        deviceId,
        openLinkInFlightRef.current,
        remoteSubscribedTopicsRef.current,
        noteSessionLiveStreamsInterrupted,
      );
      const shouldRecover = requestForcedPeerRecovery(client, deviceId);
      markRemoteResponseEvidence(deviceId);
      publishPresenceAvailabilityMutation(deviceId, (availabilityByDevice) => (
        reconcileAvailabilityAfterInboundFrame(
          availabilityByDevice,
          presencePendingRecoveryDeviceIdsRef.current,
          presenceUnavailableVerdictsRef.current,
          deviceId,
        )
      ));
      clearOnePresenceWipeTimer(presenceWipeTimersRef.current, deviceId);
      if (shouldRecover) void rehydrateWithClient(client, deviceId);
    });
    client.start();

    const offResponseEvidence = subscribeRemoteResponseEvidence((deviceId) => {
      const currentEpoch = capturePresenceAvailabilityEpoch(
        remoteResponseEvidenceEpochs,
        deviceId,
      );
      if (!publishPresenceAvailabilityMutation(deviceId, (availabilityByDevice) => (
        reconcileOfflineVerdictAfterResponse(
          availabilityByDevice,
          presencePendingRecoveryDeviceIdsRef.current,
          presenceUnavailableVerdictsRef.current,
          deviceId,
          currentEpoch,
        )
      ))) {
        return;
      }

      clearOnePresenceWipeTimer(presenceWipeTimersRef.current, deviceId);
      void rehydrateWithClient(client, deviceId);
    });

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
      const changedDeviceIds = new Set<string>();
      for (const deviceId of next) {
        if (!lastUnresponsiveSnapshot.has(deviceId)) changedDeviceIds.add(deviceId);
      }
      for (const deviceId of lastUnresponsiveSnapshot) {
        if (!next.has(deviceId)) changedDeviceIds.add(deviceId);
      }
      lastUnresponsiveSnapshot = next;
      for (const deviceId of changedDeviceIds) {
        void rehydrateWithClient(client, deviceId);
      }
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
    const releaseHeavyTopics = (): Promise<void>[] => {
      const releases: Promise<void>[] = [];
      for (const plan of registryRef.current.snapshot()) {
        const heavy = plan.topics.filter((topic) => topic.startsWith(SESSION_TOPIC_PREFIX));
        if (heavy.length === 0) continue;
        markRemoteTopicsUnsubscribed(remoteSubscribedTopicsRef.current, plan.deviceId, heavy);
        noteSessionLiveStreamsInterrupted(heavy);
        if (client.getStatus() === 'online') {
          releases.push(sendUnsubscribe(client, plan.deviceId, heavy));
        }
      }
      return releases;
    };
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        backgroundReleaseInFlightRef.current = false;
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
        // overrideCongestionCooldown:用户显式回前台是拥塞冷却的合法豁免——
        // 冷却默认只拦请求路径的 un-park(waitUntilOnline),不拦真人操作。
        client.connectNow('appstate-active', { overrideCongestionCooldown: true });
        // 快速切换(连接被宽限保住、始终 online)不会有 online 状态转换,这条显式
        // 补齐就是断档回填的唯一触发点;其余路径下它因 status 未 online 而空转。
        void rehydrateWithClient(client);
      }
      if (next === 'background') {
        backgroundReleaseInFlightRef.current = true;
        backgroundReleaseGenerationRef.current += 1;
        // App 生命周期暂停全部恢复执行，但各 peer 状态仍彼此独立；回前台统一
        // 重新排队，旧代请求的迟到结果不会创建重试。
        peerRecoverySchedulerRef.current?.pause();
        // 立即释放重量级 session:<id> 订阅(趁 socket 还活着、iOS 尚未挂起 JS):
        // 被控桌面以「有人订阅该会话流」为防打扰信号压制手机系统推送,锁屏/切后台
        // 后若订阅残留(宽限窗、挂起延迟最长可拖到 server 60s 空闲清扫),恰好在
        // 用户离开的瞬间完成的任务就永远收不到通知。只动远端订阅与 ack 簿记,
        // registry 所有权保留 —— 回前台的 rehydrate 会因 ack 已清而重新订阅。
        for (const release of releaseHeavyTopics()) {
          void release.catch(() => undefined);
        }
        // 短暂宽限再断:几秒内切回的快速 App 切换不触发整套断连/重连/补齐。
        // iOS 挂起后计时器不再运行,恢复时由上面的 active 分支收拾残局。
        backgroundState.backgroundAt = Date.now();
        clearBackgroundStopTimer();
        backgroundState.stopTimer = setTimeout(() => {
          backgroundState.stopTimer = null;
          if (AppState.currentState !== 'background') return;
          // 已发出的 stale subscribe 无法撤回;断开前再幂等释放一次并等待已发出的
          // unsubscribe 收尾,确保最后落到桌面端的 session topic 状态仍是释放。
          const finalRelease = Promise.allSettled(releaseHeavyTopics());
          const boundedWait = new Promise<void>((resolve) => {
            setTimeout(resolve, BACKGROUND_FINAL_UNSUBSCRIBE_WAIT_MS);
          });
          void Promise.race([finalRelease, boundedWait]).finally(() => {
            if (AppState.currentState === 'background') client.stop();
          });
        }, BACKGROUND_STOP_GRACE_MS);
      }
    });

    // Loaded inside the authenticated lifecycle; old native builds keep their
    // existing heartbeat fallback if the optional runtime module is unavailable.
    let disposed = false;
    let networkSubscription: { remove(): void } | undefined;
    void import('expo-network').then(({ addNetworkStateListener }) => {
      if (disposed) return;
      networkSubscription = addNetworkStateListener((network) => {
        if (AppState.currentState !== 'active' || network.isConnected === false) return;
        client.notifyNetworkChanged();
      });
    }).catch(() => {
      console.warn('[device-link] network listener unavailable; using heartbeat recovery');
    });

    return () => {
      disposed = true;
      networkSubscription?.remove();
      sub.remove();
      clearBackgroundStopTimer();
      offUnresponsive();
      offResponseEvidence();
      offBeforeLink();
      offFrame();
      offPresence();
      offPeerTransportReset();
      offStatus();
      offIssue();
      client.stop();
      peerRecoverySchedulerRef.current?.clear();
      clearAllPresenceWipeTimers(presenceWipeTimersRef.current);
      openLinkInFlightRef.current.clear();
      remoteSubscribedTopicsRef.current.clear();
      forcedPeerRecoveryIntentRef.current.clear();
      presenceAvailableByDeviceRef.current.clear();
      resetPresenceAvailabilityEpochs(presenceAvailabilityEpochsRef.current);
      resetPresenceAvailabilityEpochs(remoteResponseEvidenceEpochs);
      presencePendingRecoveryDeviceIdsRef.current.clear();
      presenceUnavailableVerdictsRef.current.clear();
      backgroundReleaseInFlightRef.current = false;
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [
    auth.accountGeneration,
    auth.getAccessToken,
    auth.isAuthenticated,
    clearPerAccountDeviceLinkState,
    publishPresenceAvailabilityMutation,
    rehydrateWithClient,
    requestForcedPeerRecovery,
  ]);

  const openLink = useCallback(
    async (deviceId: string) => {
      registryRef.current.trackOpenLink(deviceId);
      return sendOpenLinkOnce(requireClient(clientRef.current), deviceId).request;
    },
    [sendOpenLinkOnce],
  );

  const reopenLink = useCallback(
    async (deviceId: string) => {
      registryRef.current.trackOpenLink(deviceId);
      return sendOpenLinkOnce(
        requireClient(clientRef.current),
        deviceId,
        false,
        true,
      ).request;
    },
    [sendOpenLinkOnce],
  );

  const closeLink = useCallback((deviceId: string) => {
    registryRef.current.untrackOpenLink(deviceId);
    forcedPeerRecoveryIntentRef.current.cancel(deviceId);
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
    noteSessionLiveStreamsInterrupted(toSend);
    if (toSend.length === 0) return;
    await sendUnsubscribe(
      requireClient(clientRef.current),
      deviceId,
      toSend,
      (topic) => !registryRef.current.hasTopic(deviceId, topic),
    );
  }, []);

  const getPresenceAvailability = useCallback((deviceId: string): boolean | null => (
    presenceAvailableByDeviceRef.current.get(deviceId) ?? null
  ), []);

  const value = useMemo<DeviceLinkContextValue>(() => ({
    status,
    connectionIssue,
    presenceVersion,
    connectionEpoch,
    lastPresenceSnapshot,
    getSubscriptionIdentity: (deviceId, topics) => remoteSubscribedTopicsRef.current.identity(deviceId, topics),
    getPresenceAvailability,
    openLink,
    reopenLink,
    closeLink,
    invoke,
    subscribe,
    unsubscribe,
    onAgentsChanged: subscribeRemoteAgentRoster,
  }), [
    closeLink,
    connectionEpoch,
    connectionIssue,
    getPresenceAvailability,
    invoke,
    lastPresenceSnapshot,
    openLink,
    reopenLink,
    presenceVersion,
    status,
    subscribe,
    unsubscribe,
    subscribeRemoteAgentRoster,
    subscriptionVersion,
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

export function routeFrame(env: Envelope, handlers: {
  currentDataOwnerId?: string | null;
  onAccessRevoked?: (deviceId: string) => void;
  onLinkClosed?: (deviceId: string, reason?: string) => void;
  onProviderChanged?: (deviceId: string) => void;
  onAgentsChanged?: (deviceId: string) => void;
} = {}): void {
  const peerLinkClosed = handlePeerLinkCloseFrame(
    env,
    (deviceId, reason) => handlers.onLinkClosed?.(deviceId, reason),
  );
  if (applyAccessRevokedFrame(env)) {
    if (env.src) handlers.onAccessRevoked?.(env.src);
    return;
  }
  if (peerLinkClosed) return;
  if (env.kind !== 'push' || !env.src) return;
  const push = env.payload as PushPayload;
  if (push.channel === 'maker:provider:changed') {
    handlers.onProviderChanged?.(env.src);
    return;
  }
  if (push.channel === 'maker:agents:changed') {
    handlers.onAgentsChanged?.(env.src);
    return;
  }
  if (push.channel === 'maker:schedule:event') {
    remoteScheduleEventStore.apply(env.src, push.payload);
  }
  if (push.channel === SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL) {
    applyRemoteProjectOrderPush(env.src, push.payload, {
      controllerDataOwnerId: handlers.currentDataOwnerId ?? null,
      ownerStamp: push.ownerStamp,
      ownerStampPresent: Object.prototype.hasOwnProperty.call(push, 'ownerStamp'),
    });
    return;
  }
  if (push.channel === FILE_BROWSER_EVENT_CHANNEL) {
    // 文件树变更是 workdir 域事件,与会话 store 无关,单独分发给文件浏览页。
    dispatchFileBrowserWatchEvent(push.payload);
    return;
  }
  if (push.channel === DEVICE_LINK_VOICE_DICTIONARY_SNAPSHOT_CHANNEL) {
    // 只读全量快照由桌面主动推送，不经过 remoteControlEnabled 控制门禁。
    // env.src 是 relay 写入的来源设备，缓存按它分片，不能信任 payload 自报 host。
    void applyMobileVoiceDictionarySnapshot(
      env.src,
      push.payload as MobileVoiceDictionarySnapshotResult,
    );
    return;
  }
  remoteSessionStore.applyRemotePush(env.src, push.channel, push.payload);
}

/** provider revision 后并行重拉所有 agent 的能力；旧代或异常结果都不触碰当前页面。 */
async function refreshDeviceCapabilities(
  client: DeviceLinkClient,
  deviceId: string,
): Promise<void> {
  const generation = getAgentCapabilitiesGeneration(deviceId);
  await Promise.allSettled(
    (['claude-code', 'codex', 'pi'] as const).map(async (agentKind) => {
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
  connectionEpoch: number,
  opts?: DeviceLinkRehydrateSendOptions,
): Promise<void> {
  // 这四个并发请求是同一轮补齐:一次路由抖动可能让它们同时等满超时,但这只
  // 代表一个独立故障观测。共享显式 cohort,避免单轮 fan-out 直接凑满 3 次阈值。
  const sendOpts: SendInvokeOptions = {
    responsivenessCohort:
      opts?.responsivenessCohort ?? createDeviceSendCohort(deviceId),
  };
  const projectionEpochAtRequestStart =
    remoteSessionStore.captureInputProjectionAuthorityEpoch(sessionId);
  const messageDetailEnteredAtRequestStart =
    remoteSessionStore.hasSessionMessageDetailEntered(sessionId);
  const messageAuthorityAtRequestStart = messageDetailEnteredAtRequestStart
    ? remoteSessionStore.captureSessionMessageAuthority(sessionId)
    : null;
  const unenteredMessageAuthorityAtRequestStart = messageDetailEnteredAtRequestStart
    ? null
    : remoteSessionStore.captureUnenteredSessionMessageAuthority(sessionId);
  const snapshotScope = { deviceId, sessionId, connectionEpoch };
  const pendingSnapshotAtRequestStart = remoteSessionStore.getPendingInteractions(sessionId);
  // 四路快照独立拉取、独立落库:断连补齐窗口本就脆弱,一个子请求失败不应拖垮
  // 其余(旧实现共用一个 catch,任一失败三份快照全丢)。goal 覆盖断连窗口内
  // 丢失的 maker:goal:status-changed push;model-pref / turn-cost 无对应查询通道,
  // 暂不在补齐范围(需扩桌面端 invoke 白名单)。
  const [history, pending, projection, goal] = await Promise.allSettled([
    runSessionMessagesSnapshotSingleFlight(
      snapshotScope,
      RECONNECT_MESSAGE_WINDOW_LIMIT,
      messageAuthorityAtRequestStart
        ? { kind: 'detail', generation: messageAuthorityAtRequestStart.generation }
        : {
          kind: 'unentered',
          generation: unenteredMessageAuthorityAtRequestStart?.generation ?? -1,
          resetEpoch: unenteredMessageAuthorityAtRequestStart?.resetEpoch ?? -1,
        },
      () => sendInvokeWithAccessHandling<RemoteMessage[]>(
        client,
        deviceId,
        'local-db:messages:list',
        [sessionId, { limit: RECONNECT_MESSAGE_WINDOW_LIMIT }],
        sendOpts,
      ),
    ),
    runSessionPendingInteractionsSnapshotSingleFlight(
      snapshotScope,
      pendingSnapshotAtRequestStart,
      () => sendInvokeWithAccessHandling<PendingInteraction[]>(
        client,
        deviceId,
        'maker:get-pending-interactions',
        [sessionId],
        sendOpts,
      ),
    ),
    runSessionProjectionSnapshotSingleFlight(
      snapshotScope,
      projectionEpochAtRequestStart,
      () => sendInvokeWithAccessHandling<InputProjection>(
        client,
        deviceId,
        'maker:input:get-projection',
        [sessionId],
        sendOpts,
      ),
    ),
    sendInvokeWithAccessHandling<MobileGoalStatusPayload | null | undefined>(
      client,
      deviceId,
      'maker:goal:get-status',
      [sessionId],
      sendOpts,
    ),
  ]);
  if (history.status === 'fulfilled' && Array.isArray(history.value)) {
    // moreBeyondWindow:这一页上沿之外服务端还有历史(满 80 条,或被 device-link 裁过行)。为真时
    // store 不保留早于本页的缓存段 —— 断连期间漏收的 push 可能正落在两段之间,保留就在窗口里
    // 留下孤岛,而漏收的量不大时两侧时间差很小、时间阈值的空洞检测发现不了(#1222)。
    const windowOptions = {
      moreBeyondWindow: hasMoreOlderMessages(history.value, RECONNECT_MESSAGE_WINDOW_LIMIT),
    };
    if (messageAuthorityAtRequestStart) {
      remoteSessionStore.setLatestMessageWindow(sessionId, history.value, {
        ...windowOptions,
        authority: messageAuthorityAtRequestStart,
      });
    } else if (
      unenteredMessageAuthorityAtRequestStart
      && remoteSessionStore.canCommitUnenteredSessionMessageWindow(
        unenteredMessageAuthorityAtRequestStart,
        deviceId,
      )
    ) {
      // 从未打开过的 regular 仍承担首页/全局消息镜像；但请求飞行期间只要发生过
      // enter / leave / forget / clear，生命周期 fence 就会失效，旧重连响应不得越过
      // 新生命周期。Store 同时校验 regular retention 与物理设备归属，避免旧设备响应
      // 写回新 shard。
      remoteSessionStore.setLatestMessageWindow(sessionId, history.value, windowOptions);
    }
  }
  if (pending.status === 'fulfilled' && Array.isArray(pending.value)) {
    remoteSessionStore.setPendingInteractions(sessionId, pending.value, { finalizeStreaming: true });
  }
  if (projection.status === 'fulfilled' && projection.value) {
    remoteSessionStore.setInputProjectionIfCurrent(
      sessionId,
      projection.value,
      projectionEpochAtRequestStart,
    );
  }
  // undefined = 未拿到/未知(兼容形态的空返回),不能当作权威「无 goal」落库——
  // 那会把在世的 goal 卡清掉直到下一条 push;只有显式 null 才代表确认无 goal。
  if (goal.status === 'fulfilled' && goal.value !== undefined) {
    remoteSessionStore.setGoalStatus(sessionId, goal.value);
  }
  // 任一子快照瞬时失败 → 上抛让 rehydrate 计入重试;永久失败(老被控端无 goal
  // 通道的 CHANNEL_NOT_ALLOWED、权限撤销等)吞掉,重试没有意义。同批若已有
  // fulfilled 目标应答,兄弟 unavailable 只能算局部瞬态,不能升级为整机 verdict。
  const batchFailure = classifySnapshotBatchFailure([
    history,
    pending,
    projection,
    goal,
  ]);
  if (batchFailure.kind === 'partial-transient') {
    throw Object.assign(new Error('partial snapshot needs retry'), {
      code: 'INVOKE_TIMEOUT',
    });
  }
  if (batchFailure.kind === 'reject') throw batchFailure.error;
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
  allowProbe = false,
): Promise<LinkAcceptPayload> {
  return withAccessRevokedHandling(deviceId, () => sendOpenLink(client, deviceId, allowProbe));
}

async function sendOpenLink(
  client: DeviceLinkClient,
  deviceId: string,
  allowProbe = false,
): Promise<LinkAcceptPayload> {
  // 熔断门禁放在连接等待之前:open 时快速失败,不消耗 1.5s 重连等待也不上管道。
  const slot = acquireDeviceSendSlot(deviceId, undefined, { allowProbe });
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
      capabilities: CONTROLLER_CAPABILITIES,
    });
    // link-accept 只证明链路层活着,不证明 invoke 路径健康(review P1):事故形态
    // 正是 link-open 在被控端 IPC/DB 路径之外应答正常、invoke 全部挂死——若凭
    // link-accept 关熔断,恢复流程会立刻放进订阅 + 快照 + 业务 invoke 突发,3 次
    // 超时后再 open,形成周期性风暴。这里按不定论处理:不关熔断也不计失败;
    // openLink 若是探测,单飞席位随之释放、退避窗口不动,紧随其后的 subscribe
    // (真实 invoke 通道)会立即接棒成为新探测,由它的回包决定开合。
    settleDeviceSend(deviceId, slot, 'inconclusive');
    markRemoteResponseEvidence(deviceId);
    // 显式 openLink 成功 = 链路已重建:解除永久关闭后的重建抑制。
    liftRehydrateSuppressionOnExplicitOpen(rehydrateSuppressedDeviceIds, deviceId);
    return accepted;
  } catch (err) {
    // 超时仍计失败:link-open 都等不到回包说明被控端连链路层都没在应答。
    // 终态 relay 应答(REMOTE_DISABLED / DEVICE_OFFLINE / VERSION_MISMATCH)
    // 关熔断,把 UI 让给对应的可操作错误态(review P1:否则设备被永远探测)。
    settleDeviceSend(deviceId, slot, classifyLinkOpenFailure(err));
    throw err;
  }
}

interface SendInvokeOptions {
  preSend?: () => void;
  /** 同一轮明确 fan-out 共享;普通独立请求省略。 */
  responsivenessCohort?: number;
  /** 仅主动的代表性 half-open 探测允许领取 probe 席位。 */
  allowProbe?: boolean;
}

function sendInvokeWithAccessHandling<T>(
  client: DeviceLinkClient,
  deviceId: string,
  channel: string,
  args: unknown[],
  opts?: SendInvokeOptions,
): Promise<T> {
  return withAccessRevokedHandling(deviceId, () => sendInvoke<T>(client, deviceId, channel, args, opts));
}

async function sendInvoke<T>(
  client: DeviceLinkClient,
  deviceId: string,
  channel: string,
  args: unknown[],
  opts?: SendInvokeOptions,
): Promise<T> {
  // 熔断门禁放在连接等待之前:open 时快速失败,不消耗 1.5s 重连等待也不上管道。
  // 同一轮显式 fan-out 复用 cohort;普通调用省略时每次 acquire 都是独立观测。
  const slot = acquireDeviceSendSlot(deviceId, opts?.responsivenessCohort, {
    allowProbe: opts?.allowProbe,
  });
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
  if (isInvokeResultReachabilityEvidence(result)) {
    markRemoteResponseEvidence(deviceId);
  }
  return unwrapInvoke<T>(result);
}

async function sendSubscribeWithAccessHandling(
  client: DeviceLinkClient,
  deviceId: string,
  topics: readonly string[],
  shouldSend?: () => boolean,
): Promise<boolean> {
  if (!shouldSend) {
    await withAccessRevokedHandling(
      deviceId,
      () => sendSubscribe(client, deviceId, topics),
    );
    return true;
  }

  // 本地取消不能穿过 withAccessRevokedHandling 的成功路径:该 wrapper 会把任何
  // fulfilled operation 当作目标端可达证据并清掉 revoked。用不属于协议错误的
  // sentinel 退出 wrapper,只有实际 invoke 的结果才允许更新撤权状态。
  const notSent = Symbol('subscribe-not-sent');
  try {
    await withAccessRevokedHandling(deviceId, async () => {
      if (!await sendSubscribe(client, deviceId, topics, shouldSend)) throw notSent;
    });
    return true;
  } catch (err) {
    if (err === notSent) return false;
    throw err;
  }
}

async function sendSubscribe(
  client: DeviceLinkClient,
  deviceId: string,
  topics: readonly string[],
  shouldSend?: () => boolean,
): Promise<boolean> {
  // subscribe 同样走隧道请求超时等待(默认 15s),一样计入并受熔断限制(见 sendInvoke 注释)。
  const slot = acquireDeviceSendSlot(deviceId);
  try {
    await ensureOnlineForRequest(client);
  } catch (err) {
    settleDeviceSend(deviceId, slot, 'inconclusive');
    throw err;
  }
  // ensureOnlineForRequest 最长等待 1.5s;期间 App 可能已退后台并开始释放
  // heavy topics。真正 invoke 前再检查一次,避免迟到 subscribe 覆盖 unsubscribe。
  if (shouldSend && !shouldSend()) {
    settleDeviceSend(deviceId, slot, 'inconclusive');
    return false;
  }
  let result: InvokeResultPayload;
  try {
    result = await client.invoke(deviceId, {
      channel: DL_SUBSCRIBE_CHANNEL,
      args: [{
        topics,
        controllerName: mobileDeviceName(),
        capabilities: CONTROLLER_CAPABILITIES,
      }],
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
  if (isInvokeResultReachabilityEvidence(result)) {
    markRemoteResponseEvidence(deviceId);
  }
  unwrapInvoke(result);
  return true;
}

async function sendUnsubscribe(
  client: DeviceLinkClient,
  deviceId: string,
  topics: readonly string[],
  shouldSendTopic?: (topic: string) => boolean,
): Promise<void> {
  const slot = acquireDeviceSendSlot(deviceId);
  try {
    await ensureOnlineForRequest(client);
  } catch (err) {
    settleDeviceSend(deviceId, slot, 'inconclusive');
    throw err;
  }
  // Scope may be reacquired while ensureOnlineForRequest is waiting. Filter immediately
  // before client.invoke (there is no await between this check and enqueueing the frame),
  // so an older cleanup can never land after a newer subscribe and tear it down again.
  const toSend = shouldSendTopic ? topics.filter(shouldSendTopic) : topics;
  if (toSend.length === 0) {
    settleDeviceSend(deviceId, slot, 'inconclusive');
    return;
  }
  let result: InvokeResultPayload;
  try {
    result = await client.invoke(deviceId, {
      channel: DL_UNSUBSCRIBE_CHANNEL,
      args: [{ topics: toSend }],
    });
  } catch (err) {
    settleDeviceSend(deviceId, slot, classifyDeviceSendFailure(err));
    throw err;
  }
  // 控制帧成功按不定论,不作熔断恢复证据(同 sendSubscribe,review P1)。
  settleDeviceSend(deviceId, slot, 'inconclusive');
  if (isInvokeResultReachabilityEvidence(result)) {
    markRemoteResponseEvidence(deviceId);
  }
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

function markOfflineDeviceMirror(deviceId: string): void {
  // 普通离线只清依赖在线连接的 live 投影,保留 session/messages。这样用户切回
  // 刚看过的会话时先看到 last-known 内容,恢复后 marker 失效会触发后台窗口对账。
  remoteSessionStore.markDeviceOffline(deviceId);
  invalidateScheduleIndexForDevice(deviceId);
  remoteScheduleEventStore.invalidateDeviceMirror(deviceId);
  evictDeviceProviders(deviceId);
  evictDeviceModelMeta(deviceId);
  evictAgentCapabilitiesForDevice(deviceId);
  evictComposerPaletteCacheForDevice(deviceId);
}

function wipeUnavailableDeviceMirror(deviceId: string): void {
  resetRemoteProjectOrderPushFence(deviceId);
  invalidateScheduleIndexForDevice(deviceId);
  remoteSessionStore.removeDevice(deviceId);
  remoteScheduleEventStore.clearDevice(deviceId);
  remoteScheduleEventStore.clearDeviceMirrorInvalidation(deviceId);
  // Drop the cached provider catalog so a returning/re-granted device re-fetches it
  // instead of serving a list frozen from a previous connection.
  evictDeviceProviders(deviceId);
  evictDeviceModelMeta(deviceId);
  // 能力表与供应商目录同时机驱逐:桌面端重连 / 升级 / 重新授权后必须重取,
  // 否则模型 / 权限 / plan 支持度会先按旧能力渲染并接受点击。
  evictAgentCapabilitiesForDevice(deviceId);
  evictComposerPaletteCacheForDevice(deviceId);
}

const basePresenceWipeTimerDeps = {
  now: Date.now,
  setTimer: (callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs),
  clearTimer: clearTimeout,
  wipe: markOfflineDeviceMirror,
};

function scheduleUnavailableDeviceMirrorWipe(
  timers: Map<string, PresenceWipeTimerEntry>,
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
  deps: typeof basePresenceWipeTimerDeps,
): void {
  schedulePresenceWipeTimer(
    timers,
    availabilityByDevice,
    deviceId,
    PRESENCE_OFFLINE_WIPE_GRACE_MS,
    deps,
  );
}

function clearOnePresenceWipeTimer(
  timers: Map<string, PresenceWipeTimerEntry>,
  deviceId: string,
): void {
  clearPresenceWipeTimer(timers, deviceId, clearTimeout);
}

function clearAllPresenceWipeTimers(
  timers: Map<string, PresenceWipeTimerEntry>,
): void {
  clearPresenceWipeTimers(timers, clearTimeout);
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
