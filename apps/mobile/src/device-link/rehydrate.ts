import type { Topic } from '@cindy/device-link';
import type { RehydratePlan } from '@/device-link/topicRegistry';
import { isTransientRemoteError } from '@/device-link/remoteRetry';

export interface DeviceLinkRehydrateSendOptions {
  /** 同一设备的一轮快照 fan-out 共享一个响应性观测 cohort。 */
  responsivenessCohort?: number;
}

export interface PresenceTrackedRehydrateStep {
  capturedPresenceEpoch: number;
  capturedResponseEvidenceEpoch: number;
  request: Promise<unknown>;
}

export interface DeviceLinkRehydrateDeps {
  isCancelled?(): boolean;
  createDeviceSendCohort(deviceId: string): number;
  capturePresenceEpoch(deviceId: string): number;
  captureResponseEvidenceEpoch(deviceId: string): number;
  isPresenceEpochCurrent(deviceId: string, capturedPresenceEpoch: number): boolean;
  isResponseEvidenceEpochCurrent(
    deviceId: string,
    capturedResponseEvidenceEpoch: number,
  ): boolean;
  openLink(deviceId: string): PresenceTrackedRehydrateStep;
  subscribe(deviceId: string, topics: readonly Topic[]): Promise<unknown>;
  requestSessionsReseed(deviceId: string): void;
  onDeviceReachable?(deviceId: string): void;
  onDeviceRemoteDisabled?(deviceId: string): void;
  onDeviceUnavailable?(deviceId: string): void;
  rebuildSessionSnapshot(
    deviceId: string,
    sessionId: string,
    opts?: DeviceLinkRehydrateSendOptions,
  ): Promise<unknown>;
}

export interface DeviceLinkRehydrateResult {
  /**
   * 瞬时失败的步骤数(网络 / 超时 / 未连接一类可重试失败)。永久失败(远控关闭 /
   * 权限撤销 / 通道不支持)不计入——重试它们没有意义。调用方据此安排退避重跑:
   * 补齐是 push 断档的唯一回填手段,一次性 best-effort 吞错等于把断连窗口内的
   * 消息静默丢在镜像外。
   */
  transientFailures: number;
}

export interface DeviceLinkPeerRehydrateResult extends DeviceLinkRehydrateResult {
  /** True only when this peer's link-open step actually resolved successfully. */
  linkOpened: boolean;
}

/**
 * Replays controller intent after mobile foreground/background or relay
 * reconnect. Every step is best-effort because the host remains authoritative:
 * a failed topic must not block the next device/session from healing. The
 * caller is expected to re-run the plan (with backoff) while
 * `transientFailures > 0` — see DeviceLinkContext.
 */
export async function rehydrateDeviceLinkTopics(
  plans: readonly RehydratePlan[],
  deps: DeviceLinkRehydrateDeps,
): Promise<DeviceLinkRehydrateResult> {
  let transientFailures = 0;
  for (const plan of plans) {
    if (deps.isCancelled?.()) break;
    const result = await rehydrateDeviceLinkPeer(plan, deps);
    transientFailures += result.transientFailures;
  }
  return { transientFailures };
}

/**
 * Rehydrates one remote machine only. Scheduling peers belongs to the caller,
 * so a timeout from this plan never serializes unrelated desktops behind it.
 */
export async function rehydrateDeviceLinkPeer(
  plan: RehydratePlan,
  deps: DeviceLinkRehydrateDeps,
): Promise<DeviceLinkPeerRehydrateResult> {
  let transientFailures = 0;
  let linkOpened = false;
  const track = async (
    deviceId: string,
    capturedPresenceEpoch: number,
    capturedResponseEvidenceEpoch: number,
    step: Promise<unknown>,
  ): Promise<'succeeded' | 'failed' | 'unavailable'> => {
    try {
      await step;
      if (deps.isPresenceEpochCurrent(deviceId, capturedPresenceEpoch)) {
        deps.onDeviceReachable?.(deviceId);
      }
      return 'succeeded';
    } catch (err) {
      const epochCurrent = deps.isPresenceEpochCurrent(
        deviceId,
        capturedPresenceEpoch,
      );
      const offlineVerdict = isDeviceOfflineError(err);
      const remoteDisabledVerdict = isRemoteDisabledError(err);
      const availabilityVerdict = offlineVerdict || remoteDisabledVerdict;
      const staleAvailabilityVerdict = availabilityVerdict && !epochCurrent;
      const supersededByConcurrentResponse = epochCurrent
        && availabilityVerdict
        && !deps.isResponseEvidenceEpochCurrent(
          deviceId,
          capturedResponseEvidenceEpoch,
        );
      const unavailable = epochCurrent
        && availabilityVerdict
        && !supersededByConcurrentResponse;
      if (unavailable) {
        if (remoteDisabledVerdict) {
          deps.onDeviceRemoteDisabled?.(deviceId);
        } else {
          deps.onDeviceUnavailable?.(deviceId);
        }
      }
      if (
        !unavailable
        && (
          isTransientRemoteError(err)
          || staleAvailabilityVerdict
          || supersededByConcurrentResponse
        )
      ) {
        transientFailures += 1;
      }
      return unavailable ? 'unavailable' : 'failed';
    }
  };

  if (deps.isCancelled?.()) return { linkOpened, transientFailures };
  // Honor plan.openLink. Listing-only owners (Home `sessions`) subscribe without a control
  // link so Desktop does not show「正在被控」. ACK-reset recovery already promotes the plan
  // through resolvePeerRecoveryPlan when the peer queue actually needs a reopen.
  if (plan.openLink) {
    // openLink 可能与页面请求共用一条在途请求;它必须连同底层请求真正创建时
    // 捕获的 epoch 一起复用,不能在 dedupe 时补拍一个更新的 epoch。
    const openLinkStep = deps.openLink(plan.deviceId);
    const openResult = await track(
      plan.deviceId,
      openLinkStep.capturedPresenceEpoch,
      openLinkStep.capturedResponseEvidenceEpoch,
      openLinkStep.request,
    );
    if (openResult === 'unavailable') {
      return { linkOpened, transientFailures };
    }
    linkOpened = openResult === 'succeeded';
  }

  if (plan.topics.length === 0) return { linkOpened, transientFailures };
  if (deps.isCancelled?.()) return { linkOpened, transientFailures };
  if (
    await track(
      plan.deviceId,
      deps.capturePresenceEpoch(plan.deviceId),
      deps.captureResponseEvidenceEpoch(plan.deviceId),
      deps.subscribe(plan.deviceId, plan.topics),
    ) === 'unavailable'
  ) {
    return { linkOpened, transientFailures };
  }

  for (const topic of plan.topics) {
    if (deps.isCancelled?.()) return { linkOpened, transientFailures };
    if (topic === 'sessions') {
      deps.requestSessionsReseed(plan.deviceId);
      continue;
    }
    const sessionId = readSessionTopic(topic);
    if (sessionId) {
      // 每个 session snapshot 自身包含四路 Promise.allSettled fan-out;只把
      // 同一批真正并发的请求合并,不要把多个串行 session 的超时压成一次观测。
      if (await track(
        plan.deviceId,
        deps.capturePresenceEpoch(plan.deviceId),
        deps.captureResponseEvidenceEpoch(plan.deviceId),
        deps.rebuildSessionSnapshot(plan.deviceId, sessionId, {
          responsivenessCohort: deps.createDeviceSendCohort(plan.deviceId),
        }),
      ) === 'unavailable') {
        break;
      }
    }
  }
  return { linkOpened, transientFailures };
}

export function hasDeviceLinkErrorCode(
  error: unknown,
  expectedCode: string,
): boolean {
  if (typeof error === 'string') return error.includes(expectedCode);
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === expectedCode) return true;
  const message = error instanceof Error ? error.message : '';
  return message.includes(expectedCode);
}

function isDeviceOfflineError(error: unknown): boolean {
  return hasDeviceLinkErrorCode(error, 'DEVICE_OFFLINE');
}

function isRemoteDisabledError(error: unknown): boolean {
  return hasDeviceLinkErrorCode(error, 'REMOTE_DISABLED');
}

export type SnapshotBatchFailure =
  | { kind: 'none' }
  | { kind: 'partial-transient' }
  | { kind: 'reject'; error: unknown };

export function classifySnapshotBatchFailure(
  results: readonly PromiseSettledResult<unknown>[],
): SnapshotBatchFailure {
  const rejections = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  const availabilityRejections = rejections.filter(
    (result) =>
      isDeviceOfflineError(result.reason)
      || isRemoteDisabledError(result.reason),
  );
  const otherTransient = rejections.find(
    (result) =>
      isTransientRemoteError(result.reason)
      && !isDeviceOfflineError(result.reason)
      && !isRemoteDisabledError(result.reason),
  );
  if (availabilityRejections.length === 0) {
    return otherTransient
      ? { kind: 'reject', error: otherTransient.reason }
      : { kind: 'none' };
  }

  const hasTargetResponse = results.some((result) => result.status === 'fulfilled');
  if (hasTargetResponse) {
    // 同批已有目标端应答时,兄弟请求的 unavailable 不能升级为整机 verdict;
    // 仍作为普通瞬时失败退避重试,补齐缺失的子快照。
    return { kind: 'partial-transient' };
  }

  // 无任何目标应答时保留 unavailable verdict;两种标记混合时优先被控端
  // 实时返回的 REMOTE_DISABLED,而不是可能来自 relay 路由窗口的 DEVICE_OFFLINE。
  const remoteDisabled = availabilityRejections.find(
    (result) => isRemoteDisabledError(result.reason),
  );
  return {
    kind: 'reject',
    error: (remoteDisabled ?? availabilityRejections[0]).reason,
  };
}

function readSessionTopic(topic: Topic): string | null {
  if (!topic.startsWith('session:')) return null;
  const sessionId = topic.slice('session:'.length);
  return sessionId || null;
}
