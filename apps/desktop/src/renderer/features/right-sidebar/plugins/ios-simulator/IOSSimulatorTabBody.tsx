import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  House,
  Keyboard,
  Loader2,
  LockKeyhole,
  Link2,
  Link2Off,
  Play,
  RefreshCw,
  RotateCw,
  Send,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Square,
  UnlockKeyhole,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type {
  IOSSimulatorFramePumpSnapshot,
  IOSSimulatorMutationState,
  IOSSimulatorRuntimeErrorCode,
} from '@cindy/ios-simulator-runtime';
import type {
  IOSSimulatorPublicInstance,
  IOSSimulatorPublicDevice,
  IOSSimulatorPublicViewport,
  IOSSimulatorPublicRouteStatus,
  IOSSimulatorSessionStatus,
  IOSSimulatorToolResponse,
} from '../../../../../shared/iosSimulatorIpc';
import type { TabKindHostContext } from '../../types';
import type { IOSSimulatorTabState } from './index';
import { IOSSimulatorInstanceGrid } from './IOSSimulatorInstanceGrid';
import {
  createBrowserIOSSimulatorH264DecoderRuntime,
  IOSSimulatorH264Decoder,
} from './iosSimulatorH264Decoder';

interface IOSSimulatorTabBodyProps {
  state: IOSSimulatorTabState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
}

type Operation = 'attach' | 'start' | 'stop' | 'detach' | 'grant' | 'control' | null;
type StandardStreamProfileName = 'low' | 'balanced' | 'high';
type StreamProfileName = StandardStreamProfileName | 'experimental60';
type StreamProfile = { framesPerSecond: number; jpegQuality: number; scalingPercent: number };
type NativeStreamProfile = { framesPerSecond: number; scalingPercent: number };

function actionErrorI18nKey(errorCode: string): string {
  switch (errorCode) {
    case 'SIMULATOR_ATTACHED_ELSEWHERE':
      return 'rightSidebar.iosSimulator.errors.attachedElsewhere';
    case 'SESSION_INSTANCE_LIMIT_REACHED':
      return 'rightSidebar.iosSimulator.errors.taskLimitReached';
    case 'RESOURCE_LIMIT_REACHED':
      return 'rightSidebar.iosSimulator.errors.resourceLimitReached';
    case 'MEMORY_PRESSURE':
      return 'rightSidebar.iosSimulator.errors.memoryPressure';
    case 'SIMULATOR_NOT_FOUND':
      return 'rightSidebar.iosSimulator.errors.deviceNotFound';
    case 'LEASE_EXPIRED':
    case 'STALE_GENERATION':
      return 'rightSidebar.iosSimulator.errors.deviceStateChanged';
    default:
      return 'rightSidebar.iosSimulator.operationErrorWithRecovery';
  }
}

function unavailableDeviceReasonKey(device: IOSSimulatorPublicDevice): string {
  return device.unavailableReason?.code === 'missing-runtime'
    ? 'rightSidebar.iosSimulator.missingRuntime'
    : 'rightSidebar.iosSimulator.deviceUnavailable';
}

const WDA_STREAM_PROFILES: Record<StandardStreamProfileName, StreamProfile> = {
  low: { framesPerSecond: 5, jpegQuality: 25, scalingPercent: 50 },
  balanced: { framesPerSecond: 10, jpegQuality: 45, scalingPercent: 70 },
  high: { framesPerSecond: 20, jpegQuality: 70, scalingPercent: 100 },
};

const NATIVE_STREAM_PROFILES: Record<StreamProfileName, NativeStreamProfile> = {
  low: { framesPerSecond: 5, scalingPercent: 50 },
  balanced: { framesPerSecond: 20, scalingPercent: 70 },
  high: { framesPerSecond: 30, scalingPercent: 100 },
  experimental60: { framesPerSecond: 60, scalingPercent: 70 },
};

function viewerStreamProfile(
  name: StreamProfileName,
  nativeActive: boolean,
): { profile: StreamProfile; nativeProfile?: NativeStreamProfile } {
  const fallbackName = name === 'experimental60' ? 'high' : name;
  return {
    profile: WDA_STREAM_PROFILES[fallbackName],
    ...(nativeActive ? { nativeProfile: NATIVE_STREAM_PROFILES[name] } : {}),
  };
}

const FRAME_FRESHNESS_TIMEOUT_MS = 3_000;
const POINTER_GESTURE_IDLE_TIMEOUT_MS = 5_000;
const NATIVE_RECOVERY_BACKOFF_BASE_MS = 5_000;
const NATIVE_RECOVERY_BACKOFF_MAX_MS = 60_000;

interface NativeRecoveryGate {
  routeKey: string | null;
  attemptCount: number;
  retryAfter: number;
  inFlight: boolean;
}

function resetNativeRecoveryGate(gate: NativeRecoveryGate, routeKey: string | null): void {
  gate.routeKey = routeKey;
  gate.attemptCount = 0;
  gate.retryAfter = 0;
  gate.inFlight = false;
}

function nativeRecoveryBackoff(attemptCount: number): number {
  return Math.min(
    NATIVE_RECOVERY_BACKOFF_MAX_MS,
    NATIVE_RECOVERY_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1),
  );
}

function isRecoverableNativeFallback(status: IOSSimulatorPublicRouteStatus | null): boolean {
  if (!status) return false;
  return (
    status.stream.reasonCode === 'native-stream-disconnected' ||
    status.stream.reasonCode === 'native-sidecar-unavailable' ||
    status.input.reasonCode === 'native-sidecar-unavailable'
  );
}

/** Translate stable discovery codes instead of leaking host-side English guidance into the UI. */
export function setupStepKeys(issue: IOSSimulatorRuntimeErrorCode | null): string[] {
  switch (issue) {
    case 'UNSUPPORTED_PLATFORM':
      return ['rightSidebar.iosSimulator.setup.localMac'];
    case 'XCODE_NOT_FOUND':
      return [
        'rightSidebar.iosSimulator.setup.installXcode',
        'rightSidebar.iosSimulator.setup.selectXcode',
      ];
    case 'IOS_RUNTIME_NOT_FOUND':
      return ['rightSidebar.iosSimulator.setup.installRuntime'];
    case 'NO_SIMULATOR_DEVICES':
      return ['rightSidebar.iosSimulator.setup.createDevice'];
    case 'SIMCTL_FAILED':
    case 'INVALID_SIMCTL_OUTPUT':
      return ['rightSidebar.iosSimulator.setup.retryXcode'];
    default:
      return [];
  }
}

function routeFor(instance: IOSSimulatorPublicInstance) {
  return {
    instanceId: instance.instanceId,
    generation: instance.generation,
    leaseId: instance.lease.id,
  };
}

function resultInstance(result: IOSSimulatorToolResponse): IOSSimulatorPublicInstance | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') return null;
  const instance = (result.data as { instance?: unknown }).instance;
  if (!instance || typeof instance !== 'object') return null;
  return instance as IOSSimulatorPublicInstance;
}

function resultStream(result: IOSSimulatorToolResponse): IOSSimulatorFramePumpSnapshot | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') return null;
  const stream = (result.data as { stream?: unknown }).stream;
  return stream && typeof stream === 'object' ? (stream as IOSSimulatorFramePumpSnapshot) : null;
}

function resultViewport(result: IOSSimulatorToolResponse): IOSSimulatorPublicViewport | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') return null;
  const viewport = (result.data as { viewport?: unknown }).viewport;
  if (!viewport || typeof viewport !== 'object') return null;
  const candidate = viewport as Partial<IOSSimulatorPublicViewport>;
  if (
    typeof candidate.width !== 'number' ||
    candidate.width <= 0 ||
    typeof candidate.height !== 'number' ||
    candidate.height <= 0 ||
    (candidate.orientation !== 'PORTRAIT' && candidate.orientation !== 'LANDSCAPE')
  ) {
    return null;
  }
  return candidate as IOSSimulatorPublicViewport;
}

function resultMutation(result: IOSSimulatorToolResponse): IOSSimulatorMutationState | null {
  if (!result.ok || !result.data || typeof result.data !== 'object') return null;
  const mutation = (result.data as { mutation?: unknown }).mutation;
  return mutation && typeof mutation === 'object' ? (mutation as IOSSimulatorMutationState) : null;
}

function mergeRouteStatus(
  previous: Record<string, IOSSimulatorPublicRouteStatus>,
  incoming: IOSSimulatorPublicRouteStatus,
  replaceEqualTimestamp = true,
): Record<string, IOSSimulatorPublicRouteStatus> {
  const key = `${incoming.instanceId}:${incoming.generation}`;
  const current = previous[key];
  const currentTimestamp = current ? Date.parse(current.updatedAt) : Number.NaN;
  const incomingTimestamp = Date.parse(incoming.updatedAt);
  if (
    current &&
    Number.isFinite(currentTimestamp) &&
    Number.isFinite(incomingTimestamp) &&
    (currentTimestamp > incomingTimestamp ||
      (!replaceEqualTimestamp && currentTimestamp === incomingTimestamp))
  ) {
    return previous;
  }
  return { ...previous, [key]: incoming };
}

interface PointerGesture {
  pointerId: number;
  gestureId: string;
  route: ReturnType<typeof routeFor>;
  captureTarget: HTMLImageElement | HTMLCanvasElement;
  startedAt: number;
  startClientX: number;
  startClientY: number;
  startXRatio: number;
  startYRatio: number;
  lastXRatio: number;
  lastYRatio: number;
  pendingMove: { xRatio: number; yRatio: number } | null;
  moveDrainQueued: boolean;
  beginAcknowledged: boolean;
  failed: boolean;
  terminalQueued: boolean;
  idleTimer: number | null;
  tail: Promise<void>;
}

function clearPointerGestureIdleTimer(gesture: PointerGesture): void {
  if (gesture.idleTimer === null) return;
  window.clearTimeout(gesture.idleTimer);
  gesture.idleTimer = null;
}

function releaseGesturePointerCapture(gesture: PointerGesture): void {
  try {
    if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) {
      gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    }
  } catch {
    // The element or pointer may already have lost capture during teardown.
  }
}

export function IOSSimulatorTabBody({
  state,
  ctx,
  active = false,
  shellVisible = true,
}: IOSSimulatorTabBodyProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<IOSSimulatorSessionStatus | null>(null);
  const [routeStatuses, setRouteStatuses] = useState<Record<string, IOSSimulatorPublicRouteStatus>>(
    {},
  );
  const [transportError, setTransportError] = useState(false);
  const [accessRequired, setAccessRequired] = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [operation, setOperation] = useState<Operation>(null);
  const [unavailableDevicesExpanded, setUnavailableDevicesExpanded] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [framePresentation, setFramePresentation] = useState<'jpeg' | 'h264' | null>(null);
  const [presentationRouteKey, setPresentationRouteKey] = useState<string | null>(null);
  const [frameFresh, setFrameFresh] = useState(false);
  const [streamState, setStreamState] = useState<IOSSimulatorFramePumpSnapshot['state']>('idle');
  const [streamFps, setStreamFps] = useState(0);
  const [viewport, setViewport] = useState<IOSSimulatorPublicViewport | null>(null);
  const [liveMutation, setLiveMutation] = useState<IOSSimulatorMutationState | null>(null);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [streamProfile, setStreamProfile] = useState<StreamProfileName>('balanced');
  const requestVersionRef = useRef(0);
  const frameSequenceRef = useRef(0);
  const frameEncodingRef = useRef<'jpeg' | 'h264' | null>(null);
  const fpsWindowRef = useRef({ startedAt: 0, frames: 0 });
  const pointerGestureRef = useRef<PointerGesture | null>(null);
  const gestureSequenceRef = useRef(0);
  const streamProfileRef = useRef<StreamProfileName>('balanced');
  const profileRouteRef = useRef<{
    routeKey: string | null;
    nativeSelected: boolean;
    nativeActive: boolean;
  } | null>(null);
  const nativeProfileAppliedRef = useRef<{
    routeKey: string;
    profile: StreamProfileName;
  } | null>(null);
  const interactiveProfileActiveRef = useRef(false);
  const profileRestoreTimerRef = useRef<number | null>(null);
  const h264CanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const presentationEpochRef = useRef(0);
  const frameFreshnessTimerRef = useRef<number | null>(null);
  const currentRouteStatusRef = useRef<IOSSimulatorPublicRouteStatus | null>(null);
  const nativeRecoveryGateRef = useRef<NativeRecoveryGate>({
    routeKey: null,
    attemptCount: 0,
    retryAfter: 0,
    inFlight: false,
  });

  const replaceFrameUrl = useCallback((next: string | null) => {
    const previous = frameUrlRef.current;
    if (previous && previous !== next) URL.revokeObjectURL(previous);
    frameUrlRef.current = next;
    setFrameUrl(next);
  }, []);

  const clearViewerPresentation = useCallback(
    (nextState: IOSSimulatorFramePumpSnapshot['state'] = 'idle') => {
      presentationEpochRef.current += 1;
      if (frameFreshnessTimerRef.current !== null) {
        window.clearTimeout(frameFreshnessTimerRef.current);
        frameFreshnessTimerRef.current = null;
      }
      replaceFrameUrl(null);
      setFramePresentation(null);
      setPresentationRouteKey(null);
      setFrameFresh(false);
      setStreamState(nextState);
      setStreamFps(0);
      setViewport(null);
      frameSequenceRef.current = 0;
      frameEncodingRef.current = null;
      fpsWindowRef.current = { startedAt: 0, frames: 0 };
      const canvas = h264CanvasRef.current;
      const context = canvas?.getContext('2d', { alpha: false });
      if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    },
    [replaceFrameUrl],
  );

  const markFramePresented = useCallback((routeKey: string, presentation: 'jpeg' | 'h264') => {
    const now = performance.now();
    if (fpsWindowRef.current.startedAt === 0) fpsWindowRef.current.startedAt = now;
    fpsWindowRef.current.frames += 1;
    const elapsed = now - fpsWindowRef.current.startedAt;
    if (elapsed >= 1_000) {
      setStreamFps((fpsWindowRef.current.frames * 1_000) / elapsed);
      fpsWindowRef.current = { startedAt: now, frames: 0 };
    }
    if (frameFreshnessTimerRef.current !== null) {
      window.clearTimeout(frameFreshnessTimerRef.current);
    }
    setPresentationRouteKey(routeKey);
    setFramePresentation(presentation);
    setFrameFresh(true);
    frameFreshnessTimerRef.current = window.setTimeout(() => {
      frameFreshnessTimerRef.current = null;
      setFrameFresh(false);
    }, FRAME_FRESHNESS_TIMEOUT_MS);
  }, []);

  const refresh = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setRefreshing(true);
    setTransportError(false);
    try {
      const next = await window.electronAPI.maker.iosSimulator.status({
        sessionId: ctx.sessionId,
      });
      if (requestVersion === requestVersionRef.current) {
        setAccessRequired(false);
        setStatus(next);
      }
      return next;
    } catch (error) {
      if (requestVersion === requestVersionRef.current) {
        if (extractIpcError(error)?.code === 'PERMISSION_DENIED') {
          setAccessRequired(true);
          setStatus(null);
          setRouteStatuses({});
        } else {
          setTransportError(true);
        }
      }
      return null;
    } finally {
      if (requestVersion === requestVersionRef.current) setRefreshing(false);
    }
  }, [ctx.sessionId]);

  const requestAccess = useCallback(async () => {
    setRequestingAccess(true);
    setTransportError(false);
    try {
      const result = await window.electronAPI.maker.iosSimulator.requestAccess({
        sessionId: ctx.sessionId,
      });
      if (result.granted) {
        setAccessRequired(false);
        await refresh();
      }
    } catch {
      setTransportError(true);
    } finally {
      setRequestingAccess(false);
    }
  }, [ctx.sessionId, refresh]);

  useEffect(() => {
    void refresh();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!status?.ok || !status.routeStatuses) return;
    const nextStatuses = status.routeStatuses;
    setRouteStatuses((previous) => {
      let next = previous;
      for (const routeStatus of nextStatuses) {
        next = mergeRouteStatus(next, routeStatus, false);
      }
      return next;
    });
  }, [status]);

  useEffect(() => {
    const subscribe = window.electronAPI.maker.iosSimulator.onRouteStatus;
    if (typeof subscribe !== 'function') return undefined;
    return subscribe((routeStatus) => {
      if (routeStatus.sessionId !== ctx.sessionId) return;
      setRouteStatuses((previous) => mergeRouteStatus(previous, routeStatus));
    });
  }, [ctx.sessionId]);

  useEffect(() => {
    const subscribe = window.electronAPI.maker.iosSimulator.onFocusRequest;
    if (typeof subscribe !== 'function') return undefined;
    return subscribe((request) => {
      if (request.sessionId !== ctx.sessionId) return;
      // Main sends this only after minting a Host-owned renderer grant. A
      // restored tab can therefore leave its access-required state without a
      // remount when an Agent/Host flow opens the same Simulator session.
      void refresh();
    });
  }, [ctx.sessionId, refresh]);

  const environment = status?.ok ? status.environment : null;
  const instances = status?.ok ? status.instances : [];
  const resource = status?.ok ? (status.resource ?? null) : null;
  const maxInstancesPerTask = resource?.maxInstancesPerTask ?? 4;
  const availableDevices = environment?.devices.filter((device) => device.isAvailable) ?? [];
  const unavailableDevices = environment?.devices.filter((device) => !device.isAvailable) ?? [];
  const globalHardLimitReached = Boolean(resource && resource.runningCount >= resource.hardLimit);
  const attachedInstance =
    instances.find((instance) => instance.instanceId === state.instanceId) ?? instances[0] ?? null;
  const viewerRouteKey = attachedInstance
    ? `${attachedInstance.instanceId}:${attachedInstance.generation}`
    : null;
  const routeStatus = viewerRouteKey ? (routeStatuses[viewerRouteKey] ?? null) : null;
  currentRouteStatusRef.current = routeStatus;
  const nativeH264Selected = Boolean(
    routeStatus?.stream.adapter === 'native-sidecar' && routeStatus.stream.encoding === 'h264',
  );
  const nativeH264Active = Boolean(nativeH264Selected && routeStatus?.stream.state === 'active');
  const showExperimental60 =
    nativeH264Active || (nativeH264Selected && streamProfile === 'experimental60');
  const grant =
    status?.ok && attachedInstance
      ? status.deviceGrants.find(
          (candidate) => candidate.simulatorUdid === attachedInstance.simulatorUdid,
        )
      : null;
  const setupKeys = setupStepKeys(environment?.issue ?? null);
  const statusMutation =
    status?.ok && attachedInstance
      ? status.mutationStates.find(
          (candidate) => candidate.instanceId === attachedInstance.instanceId,
        )
      : null;
  const mutation =
    liveMutation?.instanceId === attachedInstance?.instanceId
      ? liveMutation
      : (statusMutation ?? null);
  const agentBusy = Boolean(
    mutation?.activeSource === 'agent' || (mutation?.queuedAgentMutations ?? 0) > 0,
  );
  const busy = operation !== null || interactionBusy || agentBusy;
  const viewerVisible = Boolean(
    active && shellVisible && attachedInstance?.lifecycleState === 'ready',
  );
  const presentationMatchesRoute = Boolean(
    viewerRouteKey && presentationRouteKey === viewerRouteKey && framePresentation !== null,
  );
  const viewerInteractive = Boolean(
    viewerVisible && streamState === 'streaming' && presentationMatchesRoute && frameFresh && !busy,
  );
  const streamRouteLabel =
    routeStatus?.stream.adapter === 'native-sidecar' && routeStatus.stream.encoding === 'h264'
      ? t('rightSidebar.iosSimulator.route.nativeH264')
      : routeStatus?.stream.adapter === 'wda'
        ? t('rightSidebar.iosSimulator.route.wdaJpeg')
        : t('rightSidebar.iosSimulator.route.hidden');
  const inputRouteLabel =
    routeStatus?.input.adapter === 'native-sidecar'
      ? t('rightSidebar.iosSimulator.route.nativeHid')
      : routeStatus?.input.adapter === 'wda'
        ? t('rightSidebar.iosSimulator.route.wdaInput')
        : t('rightSidebar.iosSimulator.route.hidden');
  const streamRouteStateLabel = routeStatus
    ? t(`rightSidebar.iosSimulator.route.state.${routeStatus.stream.state}`)
    : t('rightSidebar.iosSimulator.route.state.detecting');
  const inputRouteStateLabel = routeStatus
    ? t(`rightSidebar.iosSimulator.route.state.${routeStatus.input.state}`)
    : t('rightSidebar.iosSimulator.route.state.detecting');
  const formatActionError = useCallback(
    (result: Extract<IOSSimulatorToolResponse, { ok: false }>) =>
      t(actionErrorI18nKey(result.errorCode), {
        hardLimit: resource?.hardLimit ?? 4,
        taskLimit: maxInstancesPerTask,
      }),
    [maxInstancesPerTask, resource?.hardLimit, t],
  );

  useEffect(() => {
    const gate = nativeRecoveryGateRef.current;
    if (gate.routeKey !== viewerRouteKey) resetNativeRecoveryGate(gate, viewerRouteKey);
    const nativeActive = Boolean(
      (routeStatus?.stream.adapter === 'native-sidecar' && routeStatus.stream.state === 'active') ||
      (routeStatus?.input.adapter === 'native-sidecar' && routeStatus.input.state === 'active'),
    );
    if (nativeActive && !isRecoverableNativeFallback(routeStatus)) {
      resetNativeRecoveryGate(gate, viewerRouteKey);
    }
  }, [
    routeStatus?.input.adapter,
    routeStatus?.input.reasonCode,
    routeStatus?.input.state,
    routeStatus?.stream.adapter,
    routeStatus?.stream.reasonCode,
    routeStatus?.stream.state,
    viewerRouteKey,
  ]);

  useEffect(() => {
    const nextId = attachedInstance?.instanceId ?? null;
    if ((state.instanceId ?? null) !== nextId) ctx.patchState({ instanceId: nextId });
  }, [attachedInstance?.instanceId, ctx, state.instanceId]);

  useEffect(() => {
    clearViewerPresentation('idle');
  }, [
    attachedInstance?.generation,
    attachedInstance?.instanceId,
    attachedInstance?.lifecycleState,
    clearViewerPresentation,
  ]);

  useEffect(() => {
    if (!attachedInstance || attachedInstance.lifecycleState !== 'ready') return;
    const route = { sessionId: ctx.sessionId, ...routeFor(attachedInstance) };
    const viewerRoute = { ...route, viewerToken: window.crypto.randomUUID() };
    let cancelled = false;
    let polling = false;
    let nextRecoveryAt = 0;
    let routeRecoveryPending = false;
    let pollTimer: number | null = null;
    let preferredEncoding: 'jpeg' | 'h264' = 'jpeg';
    let nativeDecoderFallback = false;
    let mediaDisconnected = false;
    let routeInactive = false;
    let foregroundRecoveryArmed = document.visibilityState !== 'visible';
    const routeKey = `${route.instanceId}:${route.generation}`;
    const decoderRuntime = createBrowserIOSSimulatorH264DecoderRuntime();
    let decoder: IOSSimulatorH264Decoder | null = null;
    frameSequenceRef.current = 0;
    frameEncodingRef.current = null;
    fpsWindowRef.current = { startedAt: 0, frames: 0 };
    setViewport(null);
    const disconnectViewer = () => {
      if (cancelled) return;
      mediaDisconnected = true;
      clearViewerPresentation('disconnected');
    };
    const acceptStream = (stream: IOSSimulatorFramePumpSnapshot | null) => {
      if (cancelled) return;
      if (!stream || stream.state === 'disconnected') {
        disconnectViewer();
        return;
      }
      if (stream.instanceId !== route.instanceId || stream.generation !== route.generation) {
        disconnectViewer();
        return;
      }
      mediaDisconnected = false;
      setStreamState(stream.state);
      const frame = stream.latestFrame;
      if (frame && frame.encoding !== frameEncodingRef.current) {
        frameEncodingRef.current = frame.encoding;
        frameSequenceRef.current = 0;
      }
      if (!frame || frame.sequence <= frameSequenceRef.current) return;
      frameSequenceRef.current = frame.sequence;
      if (frame.encoding === 'h264') {
        void decoder?.decode(frame, stream.generation);
        return;
      }
      const bytes = frame.bytes instanceof Uint8Array ? frame.bytes : new Uint8Array(frame.bytes);
      const candidateUrl = URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/jpeg' }),
      );
      const candidateEpoch = presentationEpochRef.current;
      const candidateSequence = frame.sequence;
      const image = new Image();
      image.onload = () => {
        if (
          cancelled ||
          mediaDisconnected ||
          presentationEpochRef.current !== candidateEpoch ||
          frameEncodingRef.current !== 'jpeg' ||
          frameSequenceRef.current !== candidateSequence
        ) {
          URL.revokeObjectURL(candidateUrl);
          return;
        }
        replaceFrameUrl(candidateUrl);
        markFramePresented(routeKey, 'jpeg');
      };
      image.onerror = () => URL.revokeObjectURL(candidateUrl);
      image.src = candidateUrl;
    };
    const acceptViewerResult = (result: IOSSimulatorToolResponse) => {
      if (!result.ok) {
        disconnectViewer();
        if (
          viewerVisible &&
          !routeRecoveryPending &&
          (result.errorCode === 'LEASE_EXPIRED' || result.errorCode === 'STALE_GENERATION')
        ) {
          routeRecoveryPending = true;
          void refresh().finally(() => {
            routeRecoveryPending = false;
          });
        }
        return;
      }
      const nextInstance = resultInstance(result);
      if (nextInstance && nextInstance.lifecycleState !== 'ready') {
        routeInactive = true;
        disconnectViewer();
        void refresh();
        return;
      }
      acceptStream(resultStream(result));
      if (nextInstance) void refresh();
      const nextViewport = resultViewport(result);
      if (!cancelled && nextViewport) setViewport(nextViewport);
      const nextMutation = resultMutation(result);
      if (!cancelled && nextMutation) setLiveMutation(nextMutation);
    };
    const attemptNativeRecovery = async (): Promise<IOSSimulatorToolResponse | null> => {
      if (
        cancelled ||
        !viewerVisible ||
        preferredEncoding !== 'h264' ||
        nativeDecoderFallback ||
        document.visibilityState !== 'visible' ||
        !isRecoverableNativeFallback(currentRouteStatusRef.current)
      ) {
        return null;
      }
      const gate = nativeRecoveryGateRef.current;
      if (gate.routeKey !== routeKey) resetNativeRecoveryGate(gate, routeKey);
      const now = performance.now();
      if (gate.inFlight || now < gate.retryAfter) return null;
      gate.inFlight = true;
      const attemptCount = gate.attemptCount + 1;
      gate.attemptCount = attemptCount;
      try {
        return await window.electronAPI.maker.iosSimulator.setViewerVisibility({
          ...viewerRoute,
          visible: true,
          preferredEncoding: 'h264',
        });
      } finally {
        const currentGate = nativeRecoveryGateRef.current;
        if (
          currentGate.routeKey === routeKey &&
          currentGate.inFlight &&
          currentGate.attemptCount === attemptCount
        ) {
          currentGate.inFlight = false;
          currentGate.retryAfter = performance.now() + nativeRecoveryBackoff(attemptCount);
        }
      }
    };
    const activateCompatibilityViewer = () =>
      window.electronAPI.maker.iosSimulator.setViewerVisibility({
        ...viewerRoute,
        visible: true,
        preferredEncoding: 'jpeg',
      });
    const recoverNativeOnForeground = () => {
      if (document.visibilityState !== 'visible') {
        foregroundRecoveryArmed = true;
        return;
      }
      if (!foregroundRecoveryArmed) return;
      foregroundRecoveryArmed = false;
      if (!viewerVisible || nativeDecoderFallback || preferredEncoding !== 'h264') return;
      void attemptNativeRecovery()
        .then((result) => {
          // A failed optional recovery must not blank the healthy WDA fallback.
          if (result?.ok) acceptViewerResult(result);
        })
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', recoverNativeOnForeground);
    const acceptPushedH264Frame = (payload: IOSSimulatorH264FramePush) => {
      if (
        cancelled ||
        preferredEncoding !== 'h264' ||
        payload.frame.instanceId !== route.instanceId ||
        payload.frame.generation !== route.generation ||
        !(payload.frame.bytes instanceof ArrayBuffer)
      ) {
        return;
      }
      acceptStream({
        instanceId: payload.frame.instanceId,
        generation: payload.frame.generation,
        state: 'streaming',
        reconnectAttempt: 0,
        latestFrame: {
          ...payload.frame,
          bytes: new Uint8Array(payload.frame.bytes),
        },
      });
    };
    const unsubscribeH264Frame =
      window.electronAPI.maker.iosSimulator.onH264Frame(acceptPushedH264Frame);
    if (decoderRuntime) {
      preferredEncoding = 'h264';
      decoder = new IOSSimulatorH264Decoder({
        runtime: decoderRuntime,
        renderFrame(frame, width, height) {
          const canvas = h264CanvasRef.current;
          const context = canvas?.getContext('2d', { alpha: false });
          if (!canvas || !context) throw new Error('H.264 canvas is unavailable');
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          context.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
        },
        onFrameRendered() {
          if (!cancelled && !mediaDisconnected) markFramePresented(routeKey, 'h264');
        },
        onFallback() {
          if (cancelled) return;
          nativeDecoderFallback = true;
          setRouteStatuses((previous) => {
            const current = previous[routeKey];
            if (!current) return previous;
            return mergeRouteStatus(previous, {
              ...current,
              updatedAt: new Date().toISOString(),
              stream: {
                ...current.stream,
                adapter: 'wda',
                encoding: 'jpeg',
                state: 'fallback',
                reasonCode: 'native-decoder-fallback',
              },
            });
          });
          preferredEncoding = 'jpeg';
          decoder?.close();
          decoder = null;
          if (pollTimer !== null) window.clearTimeout(pollTimer);
          pollTimer = null;
          void window.electronAPI.maker.iosSimulator
            .setViewerVisibility({
              ...viewerRoute,
              visible: true,
              preferredEncoding: 'jpeg',
              fallbackReason: 'native-decoder-fallback',
            })
            .then(acceptViewerResult)
            .catch(() => {
              disconnectViewer();
            });
        },
      });
    }
    const poll = async () => {
      if (polling || cancelled) return;
      polling = true;
      try {
        if (
          mediaDisconnected &&
          viewerVisible &&
          !routeInactive &&
          performance.now() >= nextRecoveryAt
        ) {
          nextRecoveryAt = performance.now() + 3_000;
          const recovered = await window.electronAPI.maker.iosSimulator.setViewerVisibility({
            ...viewerRoute,
            visible: true,
            preferredEncoding,
            ...(nativeDecoderFallback
              ? { fallbackReason: 'native-decoder-fallback' as const }
              : {}),
          });
          acceptViewerResult(recovered);
          return;
        }
        const result = await window.electronAPI.maker.iosSimulator.latestFrame(route);
        acceptViewerResult(result);
        const stream = resultStream(result);
        if (
          viewerVisible &&
          stream?.state === 'disconnected' &&
          performance.now() >= nextRecoveryAt
        ) {
          nextRecoveryAt = performance.now() + 3_000;
          const recovered = await window.electronAPI.maker.iosSimulator.setViewerVisibility({
            ...viewerRoute,
            visible: true,
            preferredEncoding,
            ...(nativeDecoderFallback
              ? { fallbackReason: 'native-decoder-fallback' as const }
              : {}),
          });
          acceptViewerResult(recovered);
        }
        if (stream?.state !== 'disconnected') {
          // Keep presenting the healthy WDA/JPEG fallback while an optional
          // Sidecar recovery runs independently. The per-route gate prevents
          // parallel attempts and applies bounded exponential backoff.
          void attemptNativeRecovery()
            .then((recovered) => {
              if (recovered?.ok) acceptViewerResult(recovered);
            })
            .catch(() => undefined);
        }
      } catch {
        disconnectViewer();
      } finally {
        polling = false;
      }
    };
    const schedulePoll = () => {
      if (cancelled) return;
      pollTimer = window.setTimeout(
        () => {
          pollTimer = null;
          void poll().finally(schedulePoll);
        },
        mediaDisconnected
          ? 250
          : frameEncodingRef.current === 'jpeg' || preferredEncoding === 'jpeg'
            ? 50
            : 1_000,
      );
    };
    const startViewer = async () => {
      try {
        let result: IOSSimulatorToolResponse;
        if (viewerVisible && preferredEncoding === 'h264' && !nativeDecoderFallback) {
          const nativeResult = isRecoverableNativeFallback(currentRouteStatusRef.current)
            ? await attemptNativeRecovery().catch(() => null)
            : await window.electronAPI.maker.iosSimulator
                .setViewerVisibility({
                  ...viewerRoute,
                  visible: true,
                  preferredEncoding: 'h264',
                })
                .catch(() => null);
          if (cancelled) return;
          result = nativeResult?.ok ? nativeResult : await activateCompatibilityViewer();
        } else {
          result = await window.electronAPI.maker.iosSimulator.setViewerVisibility({
            ...viewerRoute,
            visible: viewerVisible,
            preferredEncoding,
          });
        }
        acceptViewerResult(result);
      } catch {
        disconnectViewer();
      }
      // H.264 frames arrive through the Main push channel. Poll slowly as a
      // recovery watchdog; JPEG keeps the compatibility polling cadence.
      if (viewerVisible && !cancelled) void poll().finally(schedulePoll);
    };
    void startViewer();
    return () => {
      cancelled = true;
      decoder?.close();
      unsubscribeH264Frame();
      document.removeEventListener('visibilitychange', recoverNativeOnForeground);
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      void window.electronAPI.maker.iosSimulator
        .setViewerVisibility({ ...viewerRoute, visible: false })
        .catch(() => undefined);
    };
  }, [
    attachedInstance,
    clearViewerPresentation,
    ctx.sessionId,
    markFramePresented,
    refresh,
    replaceFrameUrl,
    viewerVisible,
  ]);

  useEffect(
    () => () => {
      const current = frameUrlRef.current;
      frameUrlRef.current = null;
      if (current) URL.revokeObjectURL(current);
      if (frameFreshnessTimerRef.current !== null) {
        window.clearTimeout(frameFreshnessTimerRef.current);
        frameFreshnessTimerRef.current = null;
      }
    },
    [],
  );

  const call = useCallback(
    async (
      nextOperation: Exclude<Operation, null>,
      name: Parameters<typeof window.electronAPI.maker.iosSimulator.call>[0]['name'],
      args: Record<string, unknown>,
    ) => {
      setOperation(nextOperation);
      setActionError(null);
      try {
        const result = await window.electronAPI.maker.iosSimulator.call({
          sessionId: ctx.sessionId,
          name,
          args,
        });
        if (!result.ok) {
          setActionError(formatActionError(result));
          return;
        }
        const instance = resultInstance(result);
        if (name === 'detach_device') ctx.patchState({ instanceId: null });
        else if (instance) ctx.patchState({ instanceId: instance.instanceId });
        await refresh();
      } catch {
        setActionError(t('rightSidebar.iosSimulator.operationErrorWithRecovery'));
      } finally {
        setOperation(null);
      }
    },
    [ctx, formatActionError, refresh, t],
  );

  const setAgentControl = useCallback(async () => {
    if (!attachedInstance) return;
    setOperation('grant');
    setActionError(null);
    try {
      const result = await window.electronAPI.maker.iosSimulator.setAgentControl({
        sessionId: ctx.sessionId,
        instanceId: attachedInstance.instanceId,
        decision: grant?.agentControl === 'allowed' ? 'denied' : 'allowed',
      });
      if (!result.ok) setActionError(formatActionError(result));
      else await refresh();
    } catch {
      setActionError(t('rightSidebar.iosSimulator.operationErrorWithRecovery'));
    } finally {
      setOperation(null);
    }
  }, [attachedInstance, ctx.sessionId, formatActionError, grant?.agentControl, refresh, t]);

  const setMutationControl = useCallback(async () => {
    if (!attachedInstance) return;
    setOperation('control');
    setActionError(null);
    try {
      const result = await window.electronAPI.maker.iosSimulator.setMutationControl({
        sessionId: ctx.sessionId,
        ...routeFor(attachedInstance),
        paused: !mutation?.agentPaused,
      });
      if (!result.ok) setActionError(formatActionError(result));
      else {
        const nextMutation = resultMutation(result);
        if (nextMutation) setLiveMutation(nextMutation);
      }
    } catch {
      setActionError(t('rightSidebar.iosSimulator.operationErrorWithRecovery'));
    } finally {
      setOperation(null);
    }
  }, [attachedInstance, ctx.sessionId, formatActionError, mutation?.agentPaused, t]);

  const sendStreamProfile = useCallback(
    async (
      profileName: StreamProfileName,
      useNativeProfile: boolean,
    ): Promise<IOSSimulatorToolResponse | null> => {
      if (!attachedInstance || attachedInstance.lifecycleState !== 'ready') return null;
      const route = routeFor(attachedInstance);
      const result = await window.electronAPI.maker.iosSimulator.setStreamProfile({
        sessionId: ctx.sessionId,
        ...route,
        ...viewerStreamProfile(profileName, useNativeProfile),
      });
      if (result.ok) {
        nativeProfileAppliedRef.current = useNativeProfile
          ? {
              routeKey: `${route.instanceId}:${route.generation}`,
              profile: profileName,
            }
          : null;
      }
      return result;
    },
    [attachedInstance, ctx.sessionId],
  );

  const applyStreamProfile = useCallback(
    async (requested: StreamProfileName) => {
      if (!attachedInstance) return;
      const next = requested === 'experimental60' && !nativeH264Active ? 'high' : requested;
      const previous = streamProfile;
      setStreamProfile(next);
      streamProfileRef.current = next;
      setActionError(null);
      try {
        const result = await sendStreamProfile(next, nativeH264Active);
        if (result && !result.ok) {
          setStreamProfile(previous);
          streamProfileRef.current = previous;
          setActionError(formatActionError(result));
        }
      } catch {
        setStreamProfile(previous);
        streamProfileRef.current = previous;
        setActionError(t('rightSidebar.iosSimulator.operationErrorWithRecovery'));
      }
    },
    [attachedInstance, formatActionError, nativeH264Active, sendStreamProfile, streamProfile, t],
  );

  useEffect(() => {
    setStreamProfile('balanced');
    streamProfileRef.current = 'balanced';
    nativeProfileAppliedRef.current = null;
    if (!attachedInstance || attachedInstance.lifecycleState !== 'ready') return;
    void window.electronAPI.maker.iosSimulator
      .setStreamProfile({
        sessionId: ctx.sessionId,
        ...routeFor(attachedInstance),
        ...viewerStreamProfile('balanced', false),
      })
      .catch(() => undefined);
  }, [
    attachedInstance?.generation,
    attachedInstance?.instanceId,
    attachedInstance?.lease.id,
    attachedInstance?.lifecycleState,
    ctx.sessionId,
  ]);

  const applyTransientStreamProfile = useCallback(
    async (profile: StreamProfileName) => {
      await sendStreamProfile(profile, nativeH264Active).catch(() => undefined);
    },
    [nativeH264Active, sendStreamProfile],
  );

  useEffect(() => {
    const previous = profileRouteRef.current;
    const nextRoute = {
      routeKey: viewerRouteKey,
      nativeSelected: nativeH264Selected,
      nativeActive: nativeH264Active,
    };
    profileRouteRef.current = nextRoute;
    if (!attachedInstance || attachedInstance.lifecycleState !== 'ready') return;

    if (!nativeH264Selected) {
      if (previous?.nativeSelected || streamProfileRef.current === 'experimental60') {
        const nextProfile =
          streamProfileRef.current === 'experimental60' ? 'high' : streamProfileRef.current;
        setStreamProfile(nextProfile);
        streamProfileRef.current = nextProfile;
        void sendStreamProfile(nextProfile, false).catch(() => undefined);
      }
      return;
    }
    if (!nativeH264Active || !viewerRouteKey) return;
    const applied = nativeProfileAppliedRef.current;
    if (applied?.routeKey === viewerRouteKey && applied.profile === streamProfileRef.current)
      return;
    void sendStreamProfile(streamProfileRef.current, true)
      .then((result) => {
        if (result && !result.ok) setActionError(formatActionError(result));
      })
      .catch(() => undefined);
  }, [
    attachedInstance,
    formatActionError,
    nativeH264Active,
    nativeH264Selected,
    sendStreamProfile,
    viewerRouteKey,
  ]);

  const beginInteractiveFrameRate = useCallback(() => {
    if (profileRestoreTimerRef.current !== null) {
      window.clearTimeout(profileRestoreTimerRef.current);
      profileRestoreTimerRef.current = null;
    }
    if (
      !interactiveProfileActiveRef.current &&
      (streamProfileRef.current === 'low' || streamProfileRef.current === 'balanced')
    ) {
      interactiveProfileActiveRef.current = true;
      void applyTransientStreamProfile('high');
    }
  }, [applyTransientStreamProfile]);

  const endInteractiveFrameRate = useCallback(() => {
    if (!interactiveProfileActiveRef.current) return;
    if (profileRestoreTimerRef.current !== null) {
      window.clearTimeout(profileRestoreTimerRef.current);
    }
    profileRestoreTimerRef.current = window.setTimeout(() => {
      profileRestoreTimerRef.current = null;
      interactiveProfileActiveRef.current = false;
      if (streamProfileRef.current !== 'high') {
        void applyTransientStreamProfile(streamProfileRef.current);
      }
    }, 250);
  }, [applyTransientStreamProfile]);

  const runInteraction = useCallback(
    async (
      name:
        | 'tap'
        | 'swipe'
        | 'type_text'
        | 'press_home'
        | 'set_orientation'
        | 'lock_screen'
        | 'unlock_screen',
      args: Record<string, unknown>,
    ) => {
      if (!attachedInstance || !viewerInteractive) {
        return false;
      }
      setInteractionBusy(true);
      setActionError(null);
      try {
        const invoke = (instance: IOSSimulatorPublicInstance) =>
          window.electronAPI.maker.iosSimulator.call({
            sessionId: ctx.sessionId,
            name,
            args: { ...args, ...routeFor(instance) },
          });
        let result = await invoke(attachedInstance);
        if (
          !result.ok &&
          (result.errorCode === 'LEASE_EXPIRED' || result.errorCode === 'STALE_GENERATION')
        ) {
          const nextStatus = await refresh();
          const refreshedInstance = nextStatus?.ok
            ? nextStatus.instances.find(
                (instance) => instance.instanceId === attachedInstance.instanceId,
              )
            : null;
          if (refreshedInstance?.lifecycleState === 'ready') {
            result = await invoke(refreshedInstance);
          }
        }
        if (!result.ok) {
          setActionError(formatActionError(result));
          return false;
        }
        return true;
      } catch {
        setActionError(t('rightSidebar.iosSimulator.operationErrorWithRecovery'));
        return false;
      } finally {
        setInteractionBusy(false);
      }
    },
    [attachedInstance, ctx.sessionId, formatActionError, refresh, t, viewerInteractive],
  );

  const pointerRatio = useCallback(
    (event: ReactPointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      return {
        xRatio: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
        yRatio: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
      };
    },
    [],
  );

  const invokeLiveTouch = useCallback(
    async (
      gesture: Pick<PointerGesture, 'gestureId' | 'route'>,
      phase: 'begin' | 'move' | 'end' | 'cancel',
      point: { xRatio: number; yRatio: number },
    ) => {
      if (phase !== 'cancel' && !viewerInteractive) {
        throw new Error('Simulator instance is unavailable');
      }
      const result = await window.electronAPI.maker.iosSimulator.liveTouch({
        sessionId: ctx.sessionId,
        ...gesture.route,
        gestureId: gesture.gestureId,
        phase,
        ...point,
      });
      if (!result.ok) throw new Error(result.message);
    },
    [ctx.sessionId, viewerInteractive],
  );

  const finishPointerGesture = useCallback(
    (
      gesture: PointerGesture,
      options: {
        phase: 'end' | 'cancel';
        point: { xRatio: number; yRatio: number };
        fallback?: { name: 'tap' | 'swipe'; args: Record<string, unknown> };
        restoreProfile?: boolean;
      },
    ) => {
      if (gesture.terminalQueued) return;
      gesture.terminalQueued = true;
      if (options.phase === 'cancel') gesture.pendingMove = null;
      clearPointerGestureIdleTimer(gesture);
      if (pointerGestureRef.current === gesture) pointerGestureRef.current = null;
      releaseGesturePointerCapture(gesture);

      const restoreProfile = options.restoreProfile !== false;
      if (!restoreProfile) {
        if (profileRestoreTimerRef.current !== null) {
          window.clearTimeout(profileRestoreTimerRef.current);
          profileRestoreTimerRef.current = null;
        }
        interactiveProfileActiveRef.current = false;
      }

      gesture.tail = gesture.tail
        .then(async () => {
          if (options.phase === 'cancel') {
            if (gesture.beginAcknowledged) {
              await invokeLiveTouch(gesture, 'cancel', options.point).catch(() => undefined);
            }
            return;
          }

          if (!gesture.failed) {
            try {
              await invokeLiveTouch(gesture, 'end', options.point);
              return;
            } catch {
              gesture.failed = true;
            }
          }

          if (gesture.beginAcknowledged) {
            await invokeLiveTouch(gesture, 'cancel', options.point).catch(() => undefined);
            return;
          }

          if (options.fallback) {
            await runInteraction(options.fallback.name, options.fallback.args);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (restoreProfile) endInteractiveFrameRate();
        });
      void gesture.tail;
    },
    [endInteractiveFrameRate, invokeLiveTouch, runInteraction],
  );

  const cancelPointerGesture = useCallback(
    (gesture: PointerGesture, restoreProfile = true) => {
      finishPointerGesture(gesture, {
        phase: 'cancel',
        point: { xRatio: gesture.lastXRatio, yRatio: gesture.lastYRatio },
        restoreProfile,
      });
    },
    [finishPointerGesture],
  );

  const armPointerGestureWatchdog = useCallback(
    (gesture: PointerGesture) => {
      clearPointerGestureIdleTimer(gesture);
      gesture.idleTimer = window.setTimeout(() => {
        gesture.idleTimer = null;
        if (pointerGestureRef.current === gesture) cancelPointerGesture(gesture);
      }, POINTER_GESTURE_IDLE_TIMEOUT_MS);
    },
    [cancelPointerGesture],
  );

  const queueLiveMove = useCallback(
    (gesture: PointerGesture, point: { xRatio: number; yRatio: number }) => {
      if (gesture.terminalQueued || gesture.failed) return;
      gesture.pendingMove = point;
      if (gesture.moveDrainQueued) return;
      gesture.moveDrainQueued = true;
      gesture.tail = gesture.tail.then(async () => {
        try {
          while (!gesture.failed && gesture.pendingMove) {
            const latest = gesture.pendingMove;
            gesture.pendingMove = null;
            await invokeLiveTouch(gesture, 'move', latest);
          }
        } catch {
          gesture.failed = true;
          gesture.pendingMove = null;
        } finally {
          gesture.moveDrainQueued = false;
        }
      });
      void gesture.tail.then(() => {
        if (gesture.failed && gesture.beginAcknowledged && !gesture.terminalQueued) {
          cancelPointerGesture(gesture);
        }
      });
    },
    [cancelPointerGesture, invokeLiveTouch],
  );

  const onViewerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
      if (
        !attachedInstance ||
        !viewerInteractive ||
        pointerGestureRef.current ||
        event.button !== 0
      ) {
        return;
      }
      const point = pointerRatio(event);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      const gesture: PointerGesture = {
        pointerId: event.pointerId,
        gestureId: `viewer-${Date.now()}-${++gestureSequenceRef.current}`,
        route: routeFor(attachedInstance),
        captureTarget: event.currentTarget,
        startedAt: performance.now(),
        startClientX: event.clientX,
        startClientY: event.clientY,
        startXRatio: point.xRatio,
        startYRatio: point.yRatio,
        lastXRatio: point.xRatio,
        lastYRatio: point.yRatio,
        pendingMove: null,
        moveDrainQueued: false,
        beginAcknowledged: false,
        failed: false,
        terminalQueued: false,
        idleTimer: null,
        tail: Promise.resolve(),
      };
      gesture.tail = invokeLiveTouch(gesture, 'begin', point)
        .then(() => {
          gesture.beginAcknowledged = true;
        })
        .catch(() => {
          gesture.failed = true;
        });
      pointerGestureRef.current = gesture;
      beginInteractiveFrameRate();
      armPointerGestureWatchdog(gesture);
      event.preventDefault();
    },
    [
      armPointerGestureWatchdog,
      attachedInstance,
      beginInteractiveFrameRate,
      invokeLiveTouch,
      pointerRatio,
      viewerInteractive,
    ],
  );

  const completeViewerPointerGesture = useCallback(
    (event: ReactPointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
      const gesture = pointerGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const end = pointerRatio(event);
      gesture.lastXRatio = end.xRatio;
      gesture.lastYRatio = end.yRatio;
      const distance = Math.hypot(
        event.clientX - gesture.startClientX,
        event.clientY - gesture.startClientY,
      );
      const durationMs = Math.min(2_000, Math.max(100, performance.now() - gesture.startedAt));
      finishPointerGesture(gesture, {
        phase: 'end',
        point: end,
        fallback:
          distance < 8
            ? { name: 'tap', args: { xRatio: end.xRatio, yRatio: end.yRatio } }
            : {
                name: 'swipe',
                args: {
                  startXRatio: gesture.startXRatio,
                  startYRatio: gesture.startYRatio,
                  endXRatio: end.xRatio,
                  endYRatio: end.yRatio,
                  durationMs: Math.round(durationMs),
                },
              },
      });
      event.preventDefault();
    },
    [finishPointerGesture, pointerRatio],
  );

  const onViewerPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
      const gesture = pointerGestureRef.current;
      if (!viewerInteractive || !gesture || gesture.pointerId !== event.pointerId) return;
      if ((event.buttons & 1) === 0) {
        completeViewerPointerGesture(event);
        return;
      }
      const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
      const latest = coalesced.at(-1) ?? event.nativeEvent;
      const bounds = event.currentTarget.getBoundingClientRect();
      const point = {
        xRatio: Math.min(1, Math.max(0, (latest.clientX - bounds.left) / bounds.width)),
        yRatio: Math.min(1, Math.max(0, (latest.clientY - bounds.top) / bounds.height)),
      };
      gesture.lastXRatio = point.xRatio;
      gesture.lastYRatio = point.yRatio;
      armPointerGestureWatchdog(gesture);
      queueLiveMove(gesture, point);
      event.preventDefault();
    },
    [armPointerGestureWatchdog, completeViewerPointerGesture, queueLiveMove, viewerInteractive],
  );

  const onViewerPointerUp = completeViewerPointerGesture;

  const onViewerPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
      const gesture = pointerGestureRef.current;
      if (gesture?.pointerId === event.pointerId) cancelPointerGesture(gesture);
    },
    [cancelPointerGesture],
  );

  const onViewerLostPointerCapture = useCallback(
    (event: ReactPointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
      const gesture = pointerGestureRef.current;
      if (gesture?.pointerId === event.pointerId) cancelPointerGesture(gesture);
    },
    [cancelPointerGesture],
  );

  const cancelActivePointerGesture = useCallback(
    (restoreProfile: boolean) => {
      const gesture = pointerGestureRef.current;
      const hadInteractiveProfile = interactiveProfileActiveRef.current;
      if (gesture) {
        cancelPointerGesture(gesture, restoreProfile);
      } else if (restoreProfile && hadInteractiveProfile) {
        endInteractiveFrameRate();
      }
      if (!restoreProfile) {
        if (profileRestoreTimerRef.current !== null) {
          window.clearTimeout(profileRestoreTimerRef.current);
          profileRestoreTimerRef.current = null;
        }
        interactiveProfileActiveRef.current = false;
      }
    },
    [cancelPointerGesture, endInteractiveFrameRate],
  );

  useEffect(() => {
    if (!viewerInteractive) cancelActivePointerGesture(true);
  }, [cancelActivePointerGesture, viewerInteractive]);

  useEffect(() => {
    const cancelForLostContext = () => cancelActivePointerGesture(true);
    const cancelWhenHidden = () => {
      if (document.visibilityState !== 'visible') cancelForLostContext();
    };
    window.addEventListener('blur', cancelForLostContext);
    document.addEventListener('visibilitychange', cancelWhenHidden);
    return () => {
      window.removeEventListener('blur', cancelForLostContext);
      document.removeEventListener('visibilitychange', cancelWhenHidden);
    };
  }, [cancelActivePointerGesture]);

  useEffect(
    () => () => {
      cancelActivePointerGesture(false);
    },
    [cancelActivePointerGesture],
  );

  const sendTextInput = useCallback(async () => {
    if (!textInput) return;
    if (await runInteraction('type_text', { text: textInput })) setTextInput('');
  }, [runInteraction, textInput]);

  return (
    <div
      className="h-full overflow-y-auto bg-[var(--surface)] text-[var(--text-primary)]"
      aria-busy={busy || refreshing || requestingAccess}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Smartphone size={16} className="shrink-0" aria-hidden="true" />
              <h2 className="text-14 font-medium">{t('rightSidebar.iosSimulator.title')}</h2>
            </div>
            <p className="mt-1 text-12 leading-relaxed text-[var(--text-secondary)]">
              {t('rightSidebar.iosSimulator.description')}
            </p>
          </div>
          <ActionButton
            onClick={() => void refresh()}
            disabled={refreshing || busy}
            label={t('rightSidebar.iosSimulator.refresh')}
            icon={RefreshCw}
          />
        </header>

        {!status && !transportError && !accessRequired && (
          <StatusCard icon={RefreshCw} title={t('rightSidebar.iosSimulator.checking')} />
        )}

        {accessRequired && (
          <div className="flex gap-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3">
            <ShieldCheck
              size={15}
              className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="text-12 font-medium">
                {t('rightSidebar.iosSimulator.accessRequiredTitle')}
              </div>
              <div className="mt-1 text-11 leading-relaxed text-[var(--text-secondary)]">
                {t('rightSidebar.iosSimulator.accessRequiredDescription')}
              </div>
              <div className="mt-3">
                <ActionButton
                  onClick={() => void requestAccess()}
                  disabled={requestingAccess}
                  label={t(
                    requestingAccess
                      ? 'rightSidebar.iosSimulator.requestingAccess'
                      : 'rightSidebar.iosSimulator.allowTaskAccess',
                  )}
                  icon={requestingAccess ? Loader2 : ShieldCheck}
                  spinning={requestingAccess}
                />
              </div>
            </div>
          </div>
        )}

        {transportError && (
          <StatusCard
            icon={AlertTriangle}
            title={t('rightSidebar.iosSimulator.unavailableTitle')}
            description={t('rightSidebar.iosSimulator.connectionError')}
          />
        )}

        {status && !status.ok && (
          <StatusCard
            icon={AlertTriangle}
            title={t('rightSidebar.iosSimulator.unavailableTitle')}
            description={t(
              status.errorCode === 'UNSUPPORTED_SESSION_KIND'
                ? 'rightSidebar.iosSimulator.remoteUnsupported'
                : 'rightSidebar.iosSimulator.sessionUnavailable',
            )}
          />
        )}

        {actionError && (
          <div
            role="alert"
            className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3 text-12 text-[var(--text-primary)]"
          >
            {actionError}
          </div>
        )}

        {operation && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3 text-12 text-[var(--text-secondary)]"
          >
            <span className="inline-flex animate-spin" aria-hidden="true">
              <Loader2 size={14} />
            </span>
            <span>{t(`rightSidebar.iosSimulator.operations.${operation}`)}</span>
          </div>
        )}

        {environment && (
          <>
            <StatusCard
              icon={environment.ready ? CheckCircle2 : AlertTriangle}
              title={t(
                environment.ready
                  ? 'rightSidebar.iosSimulator.readyTitle'
                  : 'rightSidebar.iosSimulator.unavailableTitle',
              )}
              description={environment.xcodeVersion ?? undefined}
            />

            {!environment.ready && setupKeys.length > 0 && (
              <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3">
                <h3 className="text-12 font-medium">{t('rightSidebar.iosSimulator.setupTitle')}</h3>
                <ol className="mt-2 space-y-2">
                  {setupKeys.map((key, index) => (
                    <li
                      key={key}
                      className="flex gap-2 text-12 leading-relaxed text-[var(--text-secondary)]"
                    >
                      <span className="flex h-5 w-5 shrink-0 select-none items-center justify-center rounded-full bg-[var(--surface-hover)] text-10 text-[var(--text-primary)]">
                        {index + 1}
                      </span>
                      <span>{t(key)}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {instances.length > 1 && (
              <section>
                <h3 className="mb-2 text-12 font-medium">
                  {t('rightSidebar.iosSimulator.instancesTitle')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {instances.map((instance) => {
                    const selected = attachedInstance?.instanceId === instance.instanceId;
                    return (
                      <button
                        key={instance.instanceId}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => ctx.patchState({ instanceId: instance.instanceId })}
                        className={cn(
                          'inline-flex h-8 max-w-full select-none items-center gap-1.5 rounded-full border px-3 text-11 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                          selected
                            ? 'border-transparent bg-[var(--text-primary)] text-[var(--surface)]'
                            : 'border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
                        )}
                      >
                        <Smartphone size={12} className="shrink-0" aria-hidden="true" />
                        <span className="truncate">{instance.simulatorName}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {instances.length > 1 && (
              <IOSSimulatorInstanceGrid
                sessionId={ctx.sessionId}
                instances={instances}
                mutationStates={status?.ok ? status.mutationStates : []}
                selectedInstanceId={attachedInstance?.instanceId ?? null}
                active={active}
                shellVisible={shellVisible}
                title={t('rightSidebar.iosSimulator.instancesOverview')}
                countLabel={t('rightSidebar.iosSimulator.instancesCount', {
                  count: instances.filter((instance) => instance.lifecycleState === 'ready').length,
                })}
                onSelect={(instanceId) => ctx.patchState({ instanceId })}
                onRefresh={refresh}
              />
            )}

            {attachedInstance && (
              <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-12 font-medium">
                      {attachedInstance.simulatorName}
                    </h3>
                    <p className="mt-1 text-11 text-[var(--text-secondary)]">
                      {t('rightSidebar.iosSimulator.attachedDescription')}
                    </p>
                  </div>
                  <span className="shrink-0 select-none rounded-full bg-[var(--surface-chip)] px-2 py-1 text-10 text-[var(--text-secondary)]">
                    {t(`rightSidebar.iosSimulator.lifecycle.${attachedInstance.lifecycleState}`)}
                  </span>
                </div>

                {attachedInstance.lifecycleState === 'ready' &&
                  (agentBusy || mutation?.agentPaused) && (
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-3">
                      <div className="min-w-0">
                        <div className="text-11 font-medium text-[var(--warning-accent)]">
                          {t(
                            agentBusy
                              ? 'rightSidebar.iosSimulator.agentBusyTitle'
                              : 'rightSidebar.iosSimulator.manualControlTitle',
                          )}
                        </div>
                        <div className="mt-0.5 text-pretty text-10 leading-relaxed text-[var(--text-secondary)]">
                          {t(
                            mutation?.takeoverPending
                              ? 'rightSidebar.iosSimulator.takeoverPendingDescription'
                              : agentBusy
                                ? 'rightSidebar.iosSimulator.agentBusyDescription'
                                : 'rightSidebar.iosSimulator.manualControlDescription',
                          )}
                        </div>
                      </div>
                      <ActionButton
                        label={t(
                          mutation?.agentPaused
                            ? 'rightSidebar.iosSimulator.resumeAgentInput'
                            : 'rightSidebar.iosSimulator.takeControl',
                        )}
                        icon={mutation?.agentPaused ? Play : ShieldCheck}
                        disabled={operation !== null || mutation?.takeoverPending}
                        onClick={() => void setMutationControl()}
                      />
                    </div>
                  )}

                {attachedInstance.lifecycleState === 'ready' && (
                  <>
                    <div className="mt-3 flex items-center justify-between gap-2 text-11">
                      <span className="text-[var(--text-secondary)]">
                        {t('rightSidebar.iosSimulator.streamProfile')}
                      </span>
                      <select
                        value={streamProfile}
                        disabled={busy}
                        onChange={(event) =>
                          void applyStreamProfile(event.target.value as StreamProfileName)
                        }
                        aria-label={t('rightSidebar.iosSimulator.streamProfile')}
                        className="h-8 rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-3 text-11 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                      >
                        <option value="low">
                          {t('rightSidebar.iosSimulator.streamProfiles.low')}
                        </option>
                        <option value="balanced">
                          {t(
                            nativeH264Active
                              ? 'rightSidebar.iosSimulator.streamProfiles.balancedNative'
                              : 'rightSidebar.iosSimulator.streamProfiles.balanced',
                          )}
                        </option>
                        <option value="high">
                          {t(
                            nativeH264Active
                              ? 'rightSidebar.iosSimulator.streamProfiles.highNative'
                              : 'rightSidebar.iosSimulator.streamProfiles.high',
                          )}
                        </option>
                        {showExperimental60 && (
                          <option value="experimental60">
                            {t('rightSidebar.iosSimulator.streamProfiles.experimental60')}
                          </option>
                        )}
                      </select>
                    </div>
                    <div
                      role="status"
                      aria-live="polite"
                      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-10 text-[var(--text-secondary)] select-none"
                    >
                      <span>{streamRouteLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{streamRouteStateLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{inputRouteLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span>{inputRouteStateLabel}</span>
                      {routeStatus?.input.adapter === 'native-sidecar' &&
                        !routeStatus.input.multiTouch && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              {t('rightSidebar.iosSimulator.route.multiTouchUnavailable')}
                            </span>
                          </>
                        )}
                    </div>
                    <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface)]">
                      <div className="relative flex min-h-48 items-center justify-center p-2">
                        {frameUrl && presentationMatchesRoute && (
                          <img
                            src={frameUrl}
                            alt={t('rightSidebar.iosSimulator.streamAlt', {
                              device: attachedInstance.simulatorName,
                            })}
                            title={t('rightSidebar.iosSimulator.gestureHint')}
                            className={cn(
                              'max-h-[520px] max-w-full touch-none select-none object-contain',
                              framePresentation === 'jpeg' ? null : 'hidden',
                              busy
                                ? 'cursor-wait opacity-80'
                                : !viewerInteractive
                                  ? 'pointer-events-none cursor-default opacity-80'
                                  : 'cursor-crosshair',
                            )}
                            draggable={false}
                            onPointerDown={onViewerPointerDown}
                            onPointerMove={onViewerPointerMove}
                            onPointerUp={onViewerPointerUp}
                            onPointerCancel={onViewerPointerCancel}
                            onLostPointerCapture={onViewerLostPointerCapture}
                          />
                        )}
                        <canvas
                          ref={h264CanvasRef}
                          role="img"
                          aria-label={t('rightSidebar.iosSimulator.streamAlt', {
                            device: attachedInstance.simulatorName,
                          })}
                          aria-hidden={!(presentationMatchesRoute && framePresentation === 'h264')}
                          title={t('rightSidebar.iosSimulator.gestureHint')}
                          className={cn(
                            'max-h-[520px] max-w-full touch-none select-none object-contain',
                            presentationMatchesRoute && framePresentation === 'h264'
                              ? null
                              : 'hidden',
                            busy
                              ? 'cursor-wait opacity-80'
                              : !viewerInteractive
                                ? 'pointer-events-none cursor-default opacity-80'
                                : 'cursor-crosshair',
                          )}
                          onPointerDown={onViewerPointerDown}
                          onPointerMove={onViewerPointerMove}
                          onPointerUp={onViewerPointerUp}
                          onPointerCancel={onViewerPointerCancel}
                          onLostPointerCapture={onViewerLostPointerCapture}
                        />
                        {!presentationMatchesRoute && (
                          <div className="flex flex-col items-center gap-2 p-8 text-center text-11 text-[var(--text-secondary)]">
                            <Smartphone size={22} aria-hidden="true" />
                            <span className="text-pretty">
                              {t('rightSidebar.iosSimulator.waitingForFrame')}
                            </span>
                          </div>
                        )}
                        <span className="absolute right-2 top-2 rounded-full bg-[var(--surface-chip)] px-2 py-1 text-10 tabular-nums text-[var(--text-secondary)]">
                          {streamFps.toFixed(1)} FPS
                          {viewport ? ` · ${viewport.width}×${viewport.height}` : ''} ·{' '}
                          {t(`rightSidebar.iosSimulator.stream.${streamState}`)}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <div className="relative min-w-48 flex-1">
                        <Keyboard
                          size={13}
                          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]"
                          aria-hidden="true"
                        />
                        <input
                          value={textInput}
                          onChange={(event) => setTextInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (
                              event.key === 'Enter' &&
                              !event.nativeEvent.isComposing &&
                              !event.shiftKey
                            ) {
                              event.preventDefault();
                              void sendTextInput();
                            }
                          }}
                          disabled={!viewerInteractive}
                          aria-label={t('rightSidebar.iosSimulator.textInputLabel')}
                          placeholder={t('rightSidebar.iosSimulator.textInputPlaceholder')}
                          className="h-8 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface)] pl-8 pr-3 text-11 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
                        />
                      </div>
                      <ActionButton
                        label={t('rightSidebar.iosSimulator.sendText')}
                        icon={Send}
                        disabled={!viewerInteractive || !textInput}
                        onClick={() => void sendTextInput()}
                      />
                      <ActionButton
                        label={t('rightSidebar.iosSimulator.pressHome')}
                        icon={House}
                        disabled={!viewerInteractive}
                        onClick={() => void runInteraction('press_home', {})}
                      />
                      <ActionButton
                        label={t('rightSidebar.iosSimulator.rotateDevice')}
                        icon={RotateCw}
                        disabled={!viewerInteractive || !viewport}
                        onClick={() =>
                          void runInteraction('set_orientation', {
                            orientation:
                              viewport?.orientation === 'LANDSCAPE' ? 'PORTRAIT' : 'LANDSCAPE',
                          })
                        }
                      />
                      <ActionButton
                        label={t('rightSidebar.iosSimulator.lockScreen')}
                        icon={LockKeyhole}
                        disabled={!viewerInteractive}
                        onClick={() => void runInteraction('lock_screen', {})}
                      />
                      <ActionButton
                        label={t('rightSidebar.iosSimulator.unlockScreen')}
                        icon={UnlockKeyhole}
                        disabled={!viewerInteractive}
                        onClick={() => void runInteraction('unlock_screen', {})}
                      />
                    </div>
                    <p className="mt-2 text-pretty text-10 leading-relaxed text-[var(--text-secondary)]">
                      {t('rightSidebar.iosSimulator.gestureHint')}
                    </p>
                  </>
                )}

                {attachedInstance.lifecycleState === 'stopped' && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mt-3 flex gap-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-3"
                  >
                    <Square
                      size={15}
                      className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <div className="text-12 font-medium">
                        {t('rightSidebar.iosSimulator.viewerStoppedTitle')}
                      </div>
                      <div className="mt-1 text-pretty text-11 leading-relaxed text-[var(--text-secondary)]">
                        {t('rightSidebar.iosSimulator.viewerStoppedDescription')}
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {attachedInstance.lifecycleState === 'ready' ? (
                    <ActionButton
                      label={t('rightSidebar.iosSimulator.stopDevice')}
                      icon={Square}
                      disabled={busy}
                      onClick={() => void call('stop', 'stop_instance', routeFor(attachedInstance))}
                    />
                  ) : (
                    <ActionButton
                      label={t('rightSidebar.iosSimulator.startDevice')}
                      icon={Play}
                      disabled={busy}
                      onClick={() =>
                        void call('start', 'start_instance', routeFor(attachedInstance))
                      }
                    />
                  )}
                  <ActionButton
                    label={t('rightSidebar.iosSimulator.detachDevice')}
                    icon={Link2Off}
                    disabled={busy}
                    onClick={() => void call('detach', 'detach_device', routeFor(attachedInstance))}
                  />
                </div>

                {attachedInstance.lifecycleState === 'ready' && (
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--border-default)] pt-3">
                    <div className="min-w-0">
                      <div className="text-11 font-medium">
                        {t('rightSidebar.iosSimulator.agentControlTitle')}
                      </div>
                      <div className="mt-0.5 text-10 leading-relaxed text-[var(--text-secondary)]">
                        {t('rightSidebar.iosSimulator.agentControlDescription')}
                      </div>
                    </div>
                    <ActionButton
                      label={t(
                        grant?.agentControl === 'allowed'
                          ? 'rightSidebar.iosSimulator.disableAgentControl'
                          : 'rightSidebar.iosSimulator.allowAgentControl',
                      )}
                      icon={grant?.agentControl === 'allowed' ? ShieldOff : ShieldCheck}
                      disabled={busy}
                      onClick={() => void setAgentControl()}
                    />
                  </div>
                )}
              </section>
            )}

            {resource && resource.runningCount >= resource.softLimit && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3"
              >
                <AlertTriangle
                  size={14}
                  className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <div className="text-12 font-medium text-[var(--text-primary)]">
                    {t(
                      globalHardLimitReached
                        ? 'rightSidebar.iosSimulator.resourceHardLimitTitle'
                        : 'rightSidebar.iosSimulator.resourceSoftLimitTitle',
                      {
                        count: resource.runningCount,
                        limit: resource.hardLimit,
                      },
                    )}
                  </div>
                  <div className="mt-1 text-11 leading-relaxed text-[var(--text-secondary)]">
                    {t(
                      globalHardLimitReached
                        ? 'rightSidebar.iosSimulator.resourceHardLimitDescription'
                        : 'rightSidebar.iosSimulator.resourceSoftLimitDescription',
                    )}
                  </div>
                </div>
              </div>
            )}

            <section>
              <h3 className="mb-2 text-12 font-medium">
                {t('rightSidebar.iosSimulator.devicesTitle')}
              </h3>
              {environment.devices.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--border-default)] p-4 text-center text-12 text-[var(--text-secondary)]">
                  {t('rightSidebar.iosSimulator.noDevices')}
                </div>
              ) : availableDevices.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--border-default)] p-4 text-center text-12 text-[var(--text-secondary)]">
                  {t('rightSidebar.iosSimulator.noAvailableDevices')}
                </div>
              ) : (
                <ul className="space-y-2">
                  {availableDevices.map((device) => {
                    const boundInstance = instances.find(
                      (instance) => instance.simulatorUdid === device.udid,
                    );
                    const isAttached = Boolean(
                      attachedInstance &&
                      boundInstance &&
                      attachedInstance.instanceId === boundInstance.instanceId,
                    );
                    const connectionBlockReason = boundInstance
                      ? null
                      : device.ownership === 'other-task'
                        ? t('rightSidebar.iosSimulator.deviceInUseByOtherTask')
                        : instances.length >= maxInstancesPerTask
                          ? t('rightSidebar.iosSimulator.taskDeviceLimitReached', {
                              limit: maxInstancesPerTask,
                            })
                          : globalHardLimitReached && device.state.toLowerCase() === 'booted'
                            ? t('rightSidebar.iosSimulator.runningDeviceLimitReached', {
                                limit: resource?.hardLimit ?? 4,
                              })
                            : null;
                    const connectionBlockDescriptionId = connectionBlockReason
                      ? `${ctx.tabId}-${device.udid}-connection-blocked`
                      : undefined;
                    return (
                      <li
                        key={device.udid}
                        className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-12 font-medium">{device.name}</div>
                            <div className="mt-1 truncate text-11 text-[var(--text-secondary)]">
                              {device.runtimeName} · {device.state}
                            </div>
                            <div className="mt-1 truncate font-mono text-10 text-[var(--text-tertiary)]">
                              {device.udid}
                            </div>
                          </div>
                          {isAttached ? (
                            <span className="inline-flex shrink-0 select-none items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2 py-1 text-10 text-[var(--text-secondary)]">
                              <Link2 size={11} aria-hidden="true" />
                              {t('rightSidebar.iosSimulator.attached')}
                            </span>
                          ) : boundInstance ? (
                            <ActionButton
                              label={t('rightSidebar.iosSimulator.openDevice')}
                              icon={Smartphone}
                              disabled={busy}
                              onClick={() =>
                                ctx.patchState({ instanceId: boundInstance.instanceId })
                              }
                            />
                          ) : (
                            <ActionButton
                              label={t('rightSidebar.iosSimulator.attachDevice')}
                              icon={Link2}
                              disabled={busy || Boolean(connectionBlockReason)}
                              describedBy={connectionBlockDescriptionId}
                              onClick={() =>
                                void call('attach', 'attach_device', { udid: device.udid })
                              }
                            />
                          )}
                        </div>
                        {connectionBlockReason && (
                          <div
                            id={connectionBlockDescriptionId}
                            className="mt-2 flex items-start gap-1.5 text-11 leading-relaxed text-[var(--text-secondary)]"
                          >
                            <AlertTriangle
                              size={12}
                              className="mt-0.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span>{connectionBlockReason}</span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {unavailableDevices.length > 0 && (
              <section>
                <h3>
                  <button
                    type="button"
                    aria-expanded={unavailableDevicesExpanded}
                    aria-controls={`${ctx.tabId}-ios-simulator-unavailable-devices`}
                    onClick={() => setUnavailableDevicesExpanded((expanded) => !expanded)}
                    className="flex w-full select-none items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2.5 text-left text-12 font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    <AlertTriangle
                      size={14}
                      className="shrink-0 text-[var(--text-secondary)]"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      {t('rightSidebar.iosSimulator.unavailableDevicesTitle')}
                    </span>
                    <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 font-normal text-[var(--text-secondary)]">
                      {t('rightSidebar.iosSimulator.unavailableDevicesCount', {
                        count: unavailableDevices.length,
                      })}
                    </span>
                    <ChevronDown
                      size={14}
                      aria-hidden="true"
                      className={cn(
                        'shrink-0 text-[var(--text-secondary)] transition-transform motion-reduce:transition-none',
                        unavailableDevicesExpanded && 'rotate-180',
                      )}
                    />
                  </button>
                </h3>
                {unavailableDevicesExpanded && (
                  <div id={`${ctx.tabId}-ios-simulator-unavailable-devices`} className="mt-2">
                    <p className="mb-2 text-11 leading-relaxed text-[var(--text-secondary)]">
                      {t('rightSidebar.iosSimulator.unavailableDevicesDescription')}
                    </p>
                    <ul className="space-y-2">
                      {unavailableDevices.map((device) => {
                        const missingRuntime = device.unavailableReason?.code === 'missing-runtime';
                        return (
                          <li
                            key={device.udid}
                            className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3"
                          >
                            <div className="truncate text-12 font-medium">{device.name}</div>
                            <div className="mt-1 truncate text-11 text-[var(--text-secondary)]">
                              {device.runtimeName} · {device.state}
                            </div>
                            <div className="mt-1 truncate font-mono text-10 text-[var(--text-tertiary)]">
                              {device.udid}
                            </div>
                            <div className="mt-2 flex items-start gap-1.5 text-11 leading-relaxed text-[var(--text-primary)]">
                              <AlertTriangle
                                size={12}
                                className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
                                aria-hidden="true"
                              />
                              <span>
                                {t(unavailableDeviceReasonKey(device), {
                                  runtime:
                                    device.unavailableReason?.code === 'missing-runtime'
                                      ? device.unavailableReason.runtimeName
                                      : device.runtimeName,
                                })}
                              </span>
                            </div>
                            <p className="mt-1 pl-[18px] text-10 leading-relaxed text-[var(--text-secondary)]">
                              {t(
                                missingRuntime
                                  ? 'rightSidebar.iosSimulator.missingRuntimeHelp'
                                  : 'rightSidebar.iosSimulator.deviceUnavailableHelp',
                              )}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  icon: Icon,
  disabled,
  describedBy,
  spinning,
  onClick,
}: {
  label: string;
  icon: typeof AlertTriangle;
  disabled?: boolean;
  describedBy?: string;
  spinning?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-describedby={describedBy}
      className="inline-flex h-8 shrink-0 select-none items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-11 text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50"
    >
      {spinning ? (
        <span className="inline-flex animate-spin motion-reduce:animate-none" aria-hidden="true">
          <Icon size={12} />
        </span>
      ) : (
        <Icon size={12} aria-hidden="true" />
      )}
      {label}
    </button>
  );
}

function StatusCard({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof AlertTriangle;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3">
      <Icon size={15} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-12 font-medium">{title}</div>
        {description && (
          <div className="mt-1 whitespace-pre-line text-11 leading-relaxed text-[var(--text-secondary)]">
            {description}
          </div>
        )}
      </div>
    </div>
  );
}
