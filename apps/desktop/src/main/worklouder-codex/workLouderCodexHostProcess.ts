/**
 * Isolated utility-process host for the optional Work Louder Codex Micro SDK.
 * The package is loaded only from a path resolved by Electron main; Cindy does
 * not bundle or copy the proprietary SDK.
 */

import { createRequire } from 'node:module';

import {
  createWorkLouderCodexOffFrame,
  isWorkLouderCodexLightingFrameOff,
  parseWorkLouderCodexHidEvent,
  parseWorkLouderCodexJoystickEvent,
  type WorkLouderCodexHostMessage,
  type WorkLouderCodexHostRequest,
  type WorkLouderCodexLightingFrame,
} from './protocol.js';

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

interface WorkLouderDevice {
  isUsbConnection?: boolean;
}

interface WorkLouderDeviceStatus {
  firmwareVersion?: string;
  batteryPercentage?: number;
  isCharging?: boolean;
}

interface WorkLouderComm {
  connect(device: WorkLouderDevice): Promise<boolean>;
  disconnect(): Promise<void>;
}

interface WorkLouderApi {
  sendLightingConfig(
    config: Pick<WorkLouderCodexLightingFrame, 'ambient' | 'keys'>,
  ): Promise<boolean>;
  sendThreadsLighting(threads: WorkLouderCodexLightingFrame['threads']): Promise<boolean>;
  onHidReceived?(listener: (event: unknown) => void): (() => void) | void;
  onJoystickMove?(listener: (event: unknown) => void): (() => void) | void;
  getDeviceStatus?(): Promise<WorkLouderDeviceStatus>;
}

interface WorkLouderSdk {
  DeviceType: { CodexMicro: unknown; CreatorMicroV2?: unknown };
  WLDeviceDiscovery: new (logger?: WorkLouderLogger) => {
    findWLDevices(filter?: unknown[]): WorkLouderDevice[];
  };
  WLDeviceCommImpl: new (logger?: WorkLouderLogger) => WorkLouderComm;
  RPCApiOAI: new (comm: WorkLouderComm, logger?: WorkLouderLogger) => WorkLouderApi;
}

interface WorkLouderLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
const requireFromHost = createRequire(__filename);
const RETRY_MS = 3_000;
const SDK_LOG_WINDOW_MS = 60_000;
const SDK_LOG_BURST = 3;

let sdk: WorkLouderSdk | null = null;
let sdkEntry: string | null = null;
let comm: WorkLouderComm | null = null;
let api: WorkLouderApi | null = null;
let unsubscribeHid: (() => void) | null = null;
let unsubscribeJoystick: (() => void) | null = null;
let latestFrame: WorkLouderCodexLightingFrame | null = null;
let applyPending = false;
let listenPending = false;
let probePending = false;
let discoverPending = false;
let hidListeningRequested = false;
let applying = false;
let applyTask: Promise<void> | null = null;
let stopping = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastLoggedError: string | null = null;
let lastActivityPostedAt = 0;
let lastTransportError: string | null = null;
let permissionBlocked = false;
const sdkLogBuckets = new Map<string, { startedAt: number; emitted: number; suppressed: number }>();
/** The native SDK often logs a dead USB/BT handle instead of throwing. */
let transportFaulted = false;
/** Which device the current `api` handle belongs to, so probes can refresh it. */
let connectedDevice: { deviceType: 'codex-micro' | 'creator-micro-2'; isUsb: boolean } | null =
  null;

if (parentPort) {
  parentPort.on('message', (event) => {
    const request = event.data as WorkLouderCodexHostRequest;
    if (request?.kind === 'init') {
      sdkEntry = request.sdkEntry;
      permissionBlocked = false;
      transportFaulted = false;
      lastTransportError = null;
      lastLoggedError = null;
    } else if (request?.kind === 'listen') {
      hidListeningRequested = true;
      requestListen();
    } else if (request?.kind === 'apply') {
      latestFrame = request.frame;
      requestApply();
    } else if (request?.kind === 'probe') {
      // A probe is an explicit recovery request (for example after the user
      // grants Input Monitoring or unlocks macOS), so it is allowed to clear
      // the permission circuit breaker once.
      permissionBlocked = false;
      requestProbe();
    } else if (request?.kind === 'discover') {
      requestDiscover();
    } else if (request?.kind === 'stop') {
      void stop();
    }
  });
}

function post(message: WorkLouderCodexHostMessage): void {
  parentPort?.postMessage(message);
}

function hostLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  post({ kind: 'log', level, message });
}

const sdkLogger: WorkLouderLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args) => logSdkMessage('warn', 'Work Louder SDK reported a warning', args),
  error: (...args) => {
    transportFaulted = true;
    const detail = formatSdkLog(args);
    lastTransportError = `Work Louder SDK reported an error${detail}`;
    logSdkMessage('error', 'Work Louder SDK reported an error', args);
    if (api && !stopping && !probePending && !applying) requestProbe();
  },
};

function loadSdk(): WorkLouderSdk {
  if (sdk) return sdk;
  if (!sdkEntry) throw new Error('Work Louder SDK entry is missing');
  const loaded = requireFromHost(sdkEntry) as Partial<WorkLouderSdk>;
  if (
    !loaded.DeviceType ||
    typeof loaded.WLDeviceDiscovery !== 'function' ||
    typeof loaded.WLDeviceCommImpl !== 'function' ||
    typeof loaded.RPCApiOAI !== 'function'
  ) {
    throw new Error('Work Louder SDK exports are incompatible');
  }
  sdk = loaded as WorkLouderSdk;
  return sdk;
}

function requestApply(): void {
  if (stopping || permissionBlocked) return;
  applyPending = true;
  kickQueue();
}

function requestListen(): void {
  if (stopping || permissionBlocked) return;
  listenPending = true;
  kickQueue();
}

function requestProbe(): void {
  if (stopping || permissionBlocked) return;
  probePending = true;
  kickQueue();
}

function requestDiscover(): void {
  if (stopping) return;
  discoverPending = true;
  kickQueue();
}

function kickQueue(): void {
  if (applying) return;
  const task = drainApplyQueue();
  applyTask = task;
  const clearApplyTask = () => {
    if (applyTask === task) applyTask = null;
  };
  void task.then(clearApplyTask, clearApplyTask);
}

async function drainApplyQueue(): Promise<void> {
  applying = true;
  try {
    while ((applyPending || listenPending || probePending || discoverPending) && !stopping) {
      // Drop a stale handle before lighting or HID reuse it.
      if (discoverPending) {
        discoverPending = false;
        discoverPresence();
      }
      if (probePending) {
        probePending = false;
        await probeConnection();
      }
      if (listenPending) {
        listenPending = false;
        await listenForAgentKeys();
      }
      if (applyPending) {
        applyPending = false;
        const frame = latestFrame;
        if (frame) await applyFrame(frame);
      }
    }
  } finally {
    applying = false;
  }
}

async function applyFrame(frame: WorkLouderCodexLightingFrame): Promise<void> {
  if (!api && isWorkLouderCodexLightingFrameOff(frame) && !hidListeningRequested) {
    clearRetry();
    return;
  }
  try {
    const deviceApi = await ensureConnected();
    if (!deviceApi) {
      post({ kind: 'state', status: 'not-detected' });
      scheduleRetry();
      return;
    }
    const lightingOk = await deviceApi.sendLightingConfig({
      ambient: frame.ambient,
      keys: frame.keys,
    });
    const threadsOk = await deviceApi.sendThreadsLighting(frame.threads);
    if (!lightingOk || !threadsOk || transportFaulted) {
      throw new Error(
        transportFaulted
          ? (lastTransportError ?? 'lighting transport faulted')
          : 'lighting RPC returned false',
      );
    }
    clearRetry();
    lastLoggedError = null;
    post({ kind: 'state', status: 'connected' });
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message !== lastLoggedError) {
      lastLoggedError = message;
      hostLog('error', `lighting apply failed: ${message}`);
    }
    await disconnect();
    reportConnectionError(message);
  }
}

/**
 * Check the device is still physically there.
 *
 * Nothing in the SDK reports a disconnect, and a cached `api` handle keeps
 * looking valid after the cable is pulled — so the only way to find out is to
 * ask the device something and see whether it answers. `getDeviceStatus` is
 * that question: it is the cheapest round trip that reaches the hardware, and
 * its answer doubles as fresh battery and firmware values.
 *
 * Callers drive the cadence. This runs only while something is actually
 * showing connection state, so an idle app is not waking the device on a timer.
 */
async function probeConnection(): Promise<void> {
  if (stopping || permissionBlocked) return;
  if (api) {
    const faulted = transportFaulted;
    let probeError: string | null = null;
    let optionalStatusFailure = false;
    if (typeof api.getDeviceStatus === 'function' && !faulted) {
      try {
        // Call it directly so a successful round trip keeps battery and firmware
        // values fresh while still letting an explicit transport fault trigger
        // reconnect handling below.
        const status = await api.getDeviceStatus();
        if (!transportFaulted) {
          const device = connectedDevice;
          if (device) postDeviceState(device.deviceType, device.isUsb, status);
          post({ kind: 'state', status: 'connected' });
          return;
        }
      } catch (error) {
        probeError = safeErrorMessage(error);
        optionalStatusFailure = isOptionalDeviceStatusError(error);
        hostLog(
          'debug',
          optionalStatusFailure
            ? `probe status unavailable: ${probeError}`
            : `probe found the device gone: ${probeError}`,
        );
      }
    }
    const transportError = transportFaulted ? lastTransportError : null;
    if (transportError) {
      await disconnect();
      reportConnectionError(transportError);
      return;
    }
    if (probeError && optionalStatusFailure) {
      // Status is optional telemetry. Keep the healthy HID transport when a
      // firmware/RPC implementation explicitly reports that this query is not
      // supported; a rejected hardware request must still invalidate the handle.
      post({ kind: 'state', status: 'connected' });
      return;
    }
    if (probeError) {
      await disconnect();
      reportConnectionError(probeError);
      return;
    }
    hostLog('debug', 'probe dropped a stale Work Louder transport');
    await disconnect();
  }

  try {
    const deviceApi = await ensureConnected();
    if (!deviceApi) {
      post({ kind: 'state', status: 'not-detected' });
      scheduleRetry();
      return;
    }
    lastLoggedError = null;
    post({ kind: 'state', status: 'connected' });
    if (hidListeningRequested) requestListen();
    if (latestFrame && !isWorkLouderCodexLightingFrameOff(latestFrame)) requestApply();
  } catch (error) {
    const message = safeErrorMessage(error);
    await disconnect();
    reportConnectionError(message);
  }
}

function discoverPresence(): void {
  try {
    const candidate = findCandidates()[0];
    if (!candidate) {
      post({ kind: 'presence', present: false });
      return;
    }
    post({
      kind: 'presence',
      present: true,
      deviceType: candidate.deviceType,
      isUsbConnection: candidate.device.isUsbConnection === true,
    });
  } catch (error) {
    hostLog('debug', `presence discovery failed: ${safeErrorMessage(error)}`);
    post({ kind: 'presence', present: false });
  } finally {
    // Presence discovery does not own a HID transport. Do not let an SDK
    // discovery diagnostic poison the next real connection attempt.
    clearTransportFault();
  }
}

function findCandidates(): Array<{
  device: WorkLouderDevice;
  deviceType: 'codex-micro' | 'creator-micro-2';
}> {
  const loaded = loadSdk();
  const discovery = new loaded.WLDeviceDiscovery(sdkLogger);
  return [
    ...discovery.findWLDevices([loaded.DeviceType.CodexMicro]).map((device) => ({
      device,
      deviceType: 'codex-micro' as const,
    })),
    ...(loaded.DeviceType.CreatorMicroV2 === undefined
      ? []
      : discovery.findWLDevices([loaded.DeviceType.CreatorMicroV2]).map((device) => ({
          device,
          deviceType: 'creator-micro-2' as const,
        }))),
  ].toSorted(
    (left, right) => Number(right.device.isUsbConnection) - Number(left.device.isUsbConnection),
  );
}

async function listenForAgentKeys(): Promise<void> {
  try {
    const deviceApi = await ensureConnected();
    if (!deviceApi) {
      post({ kind: 'state', status: 'not-detected' });
      scheduleRetry();
      return;
    }
    clearRetry();
    lastLoggedError = null;
    post({ kind: 'state', status: 'connected' });
  } catch (error) {
    const message = safeErrorMessage(error);
    if (message !== lastLoggedError) {
      lastLoggedError = message;
      hostLog('error', `HID listening failed: ${message}`);
    }
    await disconnect();
    reportConnectionError(message);
  }
}

function formatSdkLog(args: unknown[]): string {
  if (args.length === 0) return '';
  const detail = args
    .map((value) => safeErrorMessage(value))
    .filter((value) => value.length > 0)
    .join(' ')
    .trim();
  return detail ? `: ${detail}` : '';
}

function logSdkMessage(level: 'warn' | 'error', prefix: string, args: unknown[]): void {
  const detail = formatSdkLog(args);
  const message = `${prefix}${detail}`;
  const signature = normalizeSdkLogSignature(message);
  const now = Date.now();
  const previous = sdkLogBuckets.get(signature);
  if (!previous || now - previous.startedAt >= SDK_LOG_WINDOW_MS) {
    if (previous?.suppressed) {
      hostLog(
        level,
        `${prefix} (suppressed ${previous.suppressed} repeated messages in the previous minute): ${signature}`,
      );
    }
    if (!previous && sdkLogBuckets.size >= 128) {
      const oldest = sdkLogBuckets.keys().next().value;
      if (typeof oldest === 'string') sdkLogBuckets.delete(oldest);
    }
    sdkLogBuckets.set(signature, { startedAt: now, emitted: 1, suppressed: 0 });
    hostLog(level, message);
    return;
  }
  if (previous.emitted < SDK_LOG_BURST) {
    previous.emitted += 1;
    hostLog(level, message);
  } else {
    previous.suppressed += 1;
  }
}

function normalizeSdkLogSignature(message: string): string {
  return message
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .slice(0, 240);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\/Users\/[^/]+/g, '/Users/<user>')
    .replace(/[A-Za-z]:\\Users\\[^\\]+/g, 'C:\\Users\\<user>')
    .slice(0, 400);
}

async function ensureConnected(): Promise<WorkLouderApi | null> {
  if (api && transportFaulted) await disconnect();
  if (api) return api;
  // Discovery runs with the same SDK logger as the HID transport, but it is
  // independent of any connection. Start each new connection with a clean
  // transport-fault state.
  clearTransportFault();
  const candidate = findCandidates()[0];
  clearTransportFault();
  if (!candidate) return null;
  const loaded = loadSdk();
  const nextComm = new loaded.WLDeviceCommImpl(sdkLogger);
  let connected = false;
  try {
    connected = await nextComm.connect(candidate.device);
  } catch (error) {
    const message = transportFaulted ? (lastTransportError ?? safeErrorMessage(error)) : null;
    try {
      await nextComm.disconnect();
    } catch {
      // Connection setup failed; teardown is best effort.
    }
    throw new Error(message ?? safeErrorMessage(error));
  }
  if (!connected) {
    if (transportFaulted) {
      throw new Error(lastTransportError ?? 'Work Louder transport faulted');
    }
    return null;
  }
  comm = nextComm;
  const nextApi = new loaded.RPCApiOAI(nextComm, sdkLogger);
  if (typeof nextApi.onHidReceived === 'function') {
    const unsubscribe = nextApi.onHidReceived((event) => {
      postActivity();
      const parsed = parseWorkLouderCodexHidEvent(event);
      if (parsed) post({ kind: 'hid', event: parsed });
    });
    unsubscribeHid = typeof unsubscribe === 'function' ? unsubscribe : null;
  } else {
    hostLog('warn', 'Work Louder SDK does not expose HID key events');
  }
  if (typeof nextApi.onJoystickMove === 'function') {
    const unsubscribe = nextApi.onJoystickMove((event) => {
      postActivity();
      const parsed = parseWorkLouderCodexJoystickEvent(event);
      if (parsed) post({ kind: 'joystick', event: parsed });
    });
    unsubscribeJoystick = typeof unsubscribe === 'function' ? unsubscribe : null;
  }
  api = nextApi;
  connectedDevice = {
    deviceType: candidate.deviceType,
    isUsb: candidate.device.isUsbConnection === true,
  };
  try {
    await postDeviceStatus(
      nextApi,
      candidate.deviceType,
      candidate.device.isUsbConnection === true,
    );
    if (transportFaulted) {
      throw new Error(lastTransportError ?? 'Work Louder transport faulted');
    }
  } catch (error) {
    const message = transportFaulted ? (lastTransportError ?? safeErrorMessage(error)) : null;
    await disconnect();
    throw new Error(message ?? safeErrorMessage(error));
  }
  return nextApi;
}

function postActivity(): void {
  const now = Date.now();
  if (now - lastActivityPostedAt < 250) return;
  lastActivityPostedAt = now;
  post({ kind: 'activity' });
}

/**
 * The SDK exposes status as an optional RPC on some firmware versions. Keep
 * that compatibility failure non-fatal, but treat every other rejection as a
 * failed hardware round trip so unplugged handles are recycled promptly.
 */
export function isOptionalDeviceStatusError(error: unknown): boolean {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
  const code = typeof record?.code === 'string' ? record.code : '';
  if (
    /not[_ -]?supported|unsupported|not[_ -]?implemented|method[_ -]?not[_ -]?found|enosys/i.test(
      code,
    )
  ) {
    return true;
  }

  const message = safeErrorMessage(error);
  return (
    /(?:getDeviceStatus|device status|status rpc|status request).*(?:not supported|unsupported|not implemented|unknown method|method not found)/i.test(
      message,
    ) ||
    /(?:not supported|unsupported|not implemented|unknown method|method not found).*(?:getDeviceStatus|device status|status rpc|status request)/i.test(
      message,
    )
  );
}

export async function postDeviceStatus(
  deviceApi: WorkLouderApi,
  deviceType: 'codex-micro' | 'creator-micro-2',
  isUsbConnection: boolean,
): Promise<void> {
  let status: WorkLouderDeviceStatus = {};
  if (typeof deviceApi.getDeviceStatus === 'function') {
    try {
      status = await deviceApi.getDeviceStatus();
    } catch (error) {
      hostLog('warn', `device status unavailable: ${safeErrorMessage(error)}`);
      // Device status is optional telemetry only when the SDK explicitly says
      // this RPC is unsupported. A rejected hardware request still means the
      // transport may be dead and must not be reported as connected.
      if (transportFaulted || !isOptionalDeviceStatusError(error)) throw error;
    }
  }
  postDeviceState(deviceType, isUsbConnection, status);
}

/** Publish a device snapshot, clamping whatever the SDK handed back. */
function postDeviceState(
  deviceType: 'codex-micro' | 'creator-micro-2',
  isUsbConnection: boolean,
  status: WorkLouderDeviceStatus,
): void {
  post({
    kind: 'device',
    device: {
      deviceType,
      isUsbConnection,
      firmwareVersion:
        typeof status.firmwareVersion === 'string' ? status.firmwareVersion.slice(0, 128) : null,
      batteryPercentage:
        typeof status.batteryPercentage === 'number' && Number.isFinite(status.batteryPercentage)
          ? Math.max(0, Math.min(100, status.batteryPercentage))
          : null,
      isCharging: typeof status.isCharging === 'boolean' ? status.isCharging : null,
      inputMonitoringPermission: process.platform === 'darwin' ? 'unknown' : 'not-required',
    },
  });
}

export function classifyConnectionError(
  message: string,
): 'connection-failed' | 'permission-required' {
  const looksLikePermissionError =
    /permission|not permitted|access denied|input monitoring|operation not allowed/i.test(message);
  // Input Monitoring is a macOS authorization boundary. On Windows, the HID
  // backend also reports transient handle contention as "access denied"; that
  // must stay on the bounded connection retry path instead of tripping the
  // permanent permission circuit breaker.
  return process.platform === 'darwin' && looksLikePermissionError
    ? 'permission-required'
    : 'connection-failed';
}

function reportConnectionError(message: string): void {
  const reason = classifyConnectionError(message);
  if (reason === 'permission-required') {
    permissionBlocked = true;
    clearRetry();
  }
  post({ kind: 'state', status: 'error', reason });
  if (reason !== 'permission-required') scheduleRetry();
}

function scheduleRetry(): void {
  if (
    retryTimer ||
    stopping ||
    permissionBlocked ||
    (!latestFrame && !hidListeningRequested) ||
    (latestFrame && isWorkLouderCodexLightingFrameOff(latestFrame) && !hidListeningRequested)
  ) {
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    requestProbe();
    if (hidListeningRequested) requestListen();
    if (latestFrame && !isWorkLouderCodexLightingFrameOff(latestFrame)) requestApply();
  }, RETRY_MS);
  retryTimer.unref?.();
}

function clearRetry(): void {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

async function disconnect(): Promise<void> {
  clearTransportFault();
  connectedDevice = null;
  const unsubscribe = unsubscribeHid;
  unsubscribeHid = null;
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      // Subscription teardown is best effort before closing the HID transport.
    }
  }
  const unsubscribeStick = unsubscribeJoystick;
  unsubscribeJoystick = null;
  if (unsubscribeStick) {
    try {
      unsubscribeStick();
    } catch {
      // Subscription teardown is best effort before closing the HID transport.
    }
  }
  const current = comm;
  comm = null;
  api = null;
  if (!current) return;
  try {
    await current.disconnect();
  } catch {
    // Connection teardown is best effort after a failed HID RPC.
  }
}

function clearTransportFault(): void {
  transportFaulted = false;
  lastTransportError = null;
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  listenPending = false;
  probePending = false;
  discoverPending = false;
  hidListeningRequested = false;
  clearRetry();
  try {
    await applyTask;
  } catch (error) {
    hostLog('warn', `lighting apply stopped unexpectedly: ${safeErrorMessage(error)}`);
  }
  const currentApi = api;
  if (currentApi) {
    const off = createWorkLouderCodexOffFrame();
    await Promise.allSettled([
      currentApi.sendLightingConfig({ ambient: off.ambient, keys: off.keys }),
      currentApi.sendThreadsLighting(off.threads),
    ]);
  }
  await disconnect();
  post({ kind: 'stopped' });
}
