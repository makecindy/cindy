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
let hidListeningRequested = false;
let applying = false;
let applyTask: Promise<void> | null = null;
let stopping = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastLoggedError: string | null = null;
let lastActivityPostedAt = 0;
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
    } else if (request?.kind === 'listen') {
      hidListeningRequested = true;
      requestListen();
    } else if (request?.kind === 'apply') {
      latestFrame = request.frame;
      requestApply();
    } else if (request?.kind === 'probe') {
      requestProbe();
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
  warn: (...args) => hostLog('warn', `Work Louder SDK reported a warning${formatSdkLog(args)}`),
  error: (...args) => {
    transportFaulted = true;
    hostLog('error', `Work Louder SDK reported an error${formatSdkLog(args)}`);
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
  if (stopping) return;
  applyPending = true;
  kickQueue();
}

function requestListen(): void {
  if (stopping) return;
  listenPending = true;
  kickQueue();
}

function requestProbe(): void {
  if (stopping) return;
  probePending = true;
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
    while ((applyPending || listenPending || probePending) && !stopping) {
      // Drop a stale handle before lighting or HID reuse it.
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
      throw new Error(transportFaulted ? 'lighting transport faulted' : 'lighting RPC returned false');
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
    post({ kind: 'state', status: 'error', reason: classifyConnectionError(message) });
    scheduleRetry();
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
  if (stopping) return;
  if (api) {
    const faulted = transportFaulted;
    if (typeof api.getDeviceStatus === 'function' && !faulted) {
      try {
        // Call it directly rather than through postDeviceStatus, which swallows
        // failures — swallowing here would make every probe "succeed" and defeat
        // the whole point. Same round trip also keeps battery and firmware fresh.
        const status = await api.getDeviceStatus();
        if (!transportFaulted) {
          const device = connectedDevice;
          if (device) postDeviceState(device.deviceType, device.isUsb, status);
          post({ kind: 'state', status: 'connected' });
          return;
        }
      } catch (error) {
        hostLog('debug', `probe found the device gone: ${safeErrorMessage(error)}`);
      }
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
  } catch {
    post({ kind: 'state', status: 'not-detected' });
    scheduleRetry();
  }
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
    post({ kind: 'state', status: 'error', reason: classifyConnectionError(message) });
    scheduleRetry();
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
  const loaded = loadSdk();
  const discovery = new loaded.WLDeviceDiscovery(sdkLogger);
  const candidates = [
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
  const candidate = candidates[0];
  if (!candidate) return null;
  const nextComm = new loaded.WLDeviceCommImpl(sdkLogger);
  if (!(await nextComm.connect(candidate.device))) return null;
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
  await postDeviceStatus(nextApi, candidate.deviceType, candidate.device.isUsbConnection === true);
  return nextApi;
}

function postActivity(): void {
  const now = Date.now();
  if (now - lastActivityPostedAt < 250) return;
  lastActivityPostedAt = now;
  post({ kind: 'activity' });
}

async function postDeviceStatus(
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

function classifyConnectionError(message: string): 'connection-failed' | 'permission-required' {
  return /permission|not permitted|access denied|input monitoring|operation not allowed/i.test(
    message,
  )
    ? 'permission-required'
    : 'connection-failed';
}

function scheduleRetry(): void {
  if (
    retryTimer ||
    stopping ||
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
  transportFaulted = false;
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

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  listenPending = false;
  probePending = false;
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
