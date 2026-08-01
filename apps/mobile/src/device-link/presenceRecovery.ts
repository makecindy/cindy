import type { InvokeResultPayload, PresenceSnapshot } from '@cindy/device-link';

type PresenceAvailabilitySnapshot = Pick<PresenceSnapshot, 'deviceId' | 'online' | 'remoteControlEnabled'>;

export interface PresenceAvailabilityUpdate {
  available: boolean;
  recovered: boolean;
}

export interface PresenceAvailabilityEpochs {
  next: number;
  byDevice: Map<string, number>;
}

export function createPresenceAvailabilityEpochs(): PresenceAvailabilityEpochs {
  return { next: 0, byDevice: new Map() };
}

export function markPresenceAvailabilityEpoch(
  epochs: PresenceAvailabilityEpochs,
  deviceId: string,
): void {
  epochs.next += 1;
  epochs.byDevice.set(deviceId, epochs.next);
}

export function capturePresenceAvailabilityEpoch(
  epochs: PresenceAvailabilityEpochs,
  deviceId: string,
): number {
  return epochs.byDevice.get(deviceId) ?? 0;
}

export function isPresenceAvailabilityEpochCurrent(
  epochs: PresenceAvailabilityEpochs,
  deviceId: string,
  capturedEpoch: number,
): boolean {
  return capturePresenceAvailabilityEpoch(epochs, deviceId) === capturedEpoch;
}

export function resetPresenceAvailabilityEpochs(
  epochs: PresenceAvailabilityEpochs,
): void {
  epochs.next = 0;
  epochs.byDevice.clear();
}

export interface PresenceTrackedRequest<T> {
  capturedPresenceEpoch: number;
  capturedResponseEvidenceEpoch: number;
  request: Promise<T>;
  pending: boolean;
}

export function getOrCreatePresenceTrackedRequest<T>(
  inFlight: Map<string, PresenceTrackedRequest<T>>,
  epochs: PresenceAvailabilityEpochs,
  responseEvidenceEpochs: PresenceAvailabilityEpochs,
  deviceId: string,
  createRequest: () => Promise<T>,
  options: {
    /** 成功的 link 在当前 presence / 连接代保持可复用；失败仍立即清除。 */
    retainSuccessful?: boolean;
  } = {},
): PresenceTrackedRequest<T> {
  const existing = inFlight.get(deviceId);
  if (existing) return existing;

  const tracked: PresenceTrackedRequest<T> = {
    capturedPresenceEpoch: capturePresenceAvailabilityEpoch(epochs, deviceId),
    capturedResponseEvidenceEpoch: capturePresenceAvailabilityEpoch(
      responseEvidenceEpochs,
      deviceId,
    ),
    request: createRequest(),
    pending: true,
  };
  inFlight.set(deviceId, tracked);
  const cleanup = (): void => {
    tracked.pending = false;
    if (inFlight.get(deviceId) === tracked) inFlight.delete(deviceId);
  };
  if (options.retainSuccessful) {
    void tracked.request.then(
      () => {
        tracked.pending = false;
      },
      cleanup,
    );
  } else {
    void tracked.request.then(cleanup, cleanup);
  }
  return tracked;
}

export interface PresenceWipeTimerEntry {
  timer: ReturnType<typeof setTimeout>;
  deadlineAt: number;
  firstScheduledAt: number;
}

export interface PresenceWipeTimerDeps {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  wipe(deviceId: string): void;
  isConfirmationInFlight?(deviceId: string): boolean;
}

export const PRESENCE_WIPE_MAX_LIFETIME_MS = 30_000;
const PRESENCE_WIPE_CONFIRMATION_POLL_MS = 1_000;

export function schedulePresenceWipeTimer(
  timers: Map<string, PresenceWipeTimerEntry>,
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
  delayMs: number,
  deps: PresenceWipeTimerDeps,
): void {
  if (timers.has(deviceId)) return;
  const now = deps.now();
  schedulePresenceWipeAt(
    timers,
    availabilityByDevice,
    deviceId,
    now,
    now + delayMs,
    deps,
  );
}

export function extendPresenceWipeTimerFloor(
  timers: Map<string, PresenceWipeTimerEntry>,
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
  minimumDelayMs: number,
  deps: PresenceWipeTimerDeps,
): void {
  const entry = timers.get(deviceId);
  if (!entry) return;
  const minimumDeadlineAt = Math.min(
    deps.now() + minimumDelayMs,
    entry.firstScheduledAt + PRESENCE_WIPE_MAX_LIFETIME_MS,
  );
  if (entry.deadlineAt >= minimumDeadlineAt) return;

  deps.clearTimer(entry.timer);
  schedulePresenceWipeAt(
    timers,
    availabilityByDevice,
    deviceId,
    entry.firstScheduledAt,
    minimumDeadlineAt,
    deps,
  );
}

export function clearPresenceWipeTimer(
  timers: Map<string, PresenceWipeTimerEntry>,
  deviceId: string,
  clearTimer: PresenceWipeTimerDeps['clearTimer'],
): void {
  const entry = timers.get(deviceId);
  if (!entry) return;
  clearTimer(entry.timer);
  timers.delete(deviceId);
}

export function clearPresenceWipeTimers(
  timers: Map<string, PresenceWipeTimerEntry>,
  clearTimer: PresenceWipeTimerDeps['clearTimer'],
): void {
  for (const entry of timers.values()) clearTimer(entry.timer);
  timers.clear();
}

function schedulePresenceWipeAt(
  timers: Map<string, PresenceWipeTimerEntry>,
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
  firstScheduledAt: number,
  deadlineAt: number,
  deps: PresenceWipeTimerDeps,
): void {
  const delayMs = Math.max(0, deadlineAt - deps.now());
  const entry: PresenceWipeTimerEntry = {
    deadlineAt,
    firstScheduledAt,
    timer: deps.setTimer(() => {
      if (timers.get(deviceId) !== entry) return;
      if (deps.isConfirmationInFlight?.(deviceId)) {
        schedulePresenceWipeAt(
          timers,
          availabilityByDevice,
          deviceId,
          firstScheduledAt,
          deps.now() + PRESENCE_WIPE_CONFIRMATION_POLL_MS,
          deps,
        );
        return;
      }
      timers.delete(deviceId);
      if (shouldWipeUnavailableDeviceMirror(availabilityByDevice, deviceId)) {
        deps.wipe(deviceId);
      }
    }, delayMs),
  };
  timers.set(deviceId, entry);
}

export function shouldWipeUnavailableDeviceMirror(
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
): boolean {
  // 新连接不会重放全量 presence,因此 reconnect 清掉旧 verdict 后的 unknown
  // 仍需让原宽限计时器按期回收;只有当前代已明确 available 才取消清理。
  return availabilityByDevice.get(deviceId) !== true;
}

export type PresenceUnavailableVerdictKind = 'offline' | 'disabled' | 'presence';

export interface PresenceUnavailableVerdict {
  kind: PresenceUnavailableVerdictKind;
  responseEvidenceEpoch: number;
}

export function isInvokeResultReachabilityEvidence(
  result: InvokeResultPayload,
): boolean {
  return result.ok
    || (
      result.error.code !== 'REMOTE_DISABLED'
      && result.error.code !== 'ACCESS_REVOKED'
    );
}

export function reconcileOfflineVerdictAfterResponse(
  availabilityByDevice: Map<string, boolean>,
  pendingRecoveryDeviceIds: Set<string>,
  verdicts: Map<string, PresenceUnavailableVerdict>,
  deviceId: string,
  currentResponseEvidenceEpoch: number,
): boolean {
  const verdict = verdicts.get(deviceId);
  if (
    verdict?.kind !== 'offline'
    || currentResponseEvidenceEpoch <= verdict.responseEvidenceEpoch
  ) {
    return false;
  }

  // 真实目标应答只推翻 rehydrate 的路由离线推断,回到 unknown 乐观补齐;
  // 显式 disabled verdict 永远不在此清除,只能由权威 presence 恢复。
  availabilityByDevice.delete(deviceId);
  pendingRecoveryDeviceIds.add(deviceId);
  verdicts.delete(deviceId);
  return true;
}

export function isPresenceEligibleForRemoteRequest(
  availabilityByDevice: ReadonlyMap<string, boolean>,
  deviceId: string,
): boolean {
  // 首次尚未收到 presence 时保留既有乐观尝试;只有 relay 已明确声明 unavailable
  // 才拦住 rehydrate / half-open probe,避免对离线设备立即重放请求风暴。
  return availabilityByDevice.get(deviceId) !== false;
}

export function resetPresenceAvailabilityForConnection(
  availabilityByDevice: Map<string, boolean>,
  pendingRecoveryDeviceIds: Set<string>,
): string[] {
  // presence-changed 是只发给「当时在线控制端」的增量广播,新连接没有全量重放。
  // 每个连接代际都必须丢弃旧 verdict,否则后台期间漏掉的恢复事件会让 stale false
  // 永久挡住该设备的 rehydrate。上一代明确 unavailable 的设备另存为 pending
  // recovery:当前连接按 unknown 乐观尝试,而它稍后首个 available 快照仍能形成恢复边。
  const unavailableDeviceIds = [...availabilityByDevice.entries()]
    .filter(([, available]) => !available)
    .map(([deviceId]) => deviceId);
  for (const deviceId of unavailableDeviceIds) pendingRecoveryDeviceIds.add(deviceId);
  availabilityByDevice.clear();
  return unavailableDeviceIds;
}

export function updatePresenceAvailability(
  availabilityByDevice: Map<string, boolean>,
  snap: PresenceAvailabilitySnapshot,
  pendingRecoveryDeviceIds?: Set<string>,
): PresenceAvailabilityUpdate {
  const available = snap.online && snap.remoteControlEnabled;
  const wasAvailable = availabilityByDevice.get(snap.deviceId);
  availabilityByDevice.set(snap.deviceId, available);
  const recoveredAcrossConnection = available && pendingRecoveryDeviceIds?.delete(snap.deviceId) === true;
  if (!available) pendingRecoveryDeviceIds?.add(snap.deviceId);
  return {
    available,
    recovered: available && (wasAvailable === false || recoveredAcrossConnection),
  };
}
