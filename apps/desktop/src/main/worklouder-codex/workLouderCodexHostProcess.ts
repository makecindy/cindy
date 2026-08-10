/**
 * Isolated utility-process host for the optional Work Louder Codex Micro SDK.
 * The package is loaded only from a path resolved by Electron main; Cindy does
 * not bundle or copy the proprietary SDK.
 */

import { createRequire } from 'node:module';

import {
  isWorkLouderCodexLightingFrameOff,
  parseWorkLouderCodexAgentKeyPress,
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
}

interface WorkLouderSdk {
  DeviceType: { CodexMicro: unknown };
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
let latestFrame: WorkLouderCodexLightingFrame | null = null;
let applyPending = false;
let listenPending = false;
let hidListeningRequested = false;
let applying = false;
let applyTask: Promise<void> | null = null;
let stopping = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastLoggedError: string | null = null;

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
  warn: () => hostLog('warn', 'Work Louder SDK reported a warning'),
  error: () => hostLog('error', 'Work Louder SDK reported an error'),
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
  if (!applying) {
    const task = drainApplyQueue();
    applyTask = task;
    const clearApplyTask = () => {
      if (applyTask === task) applyTask = null;
    };
    void task.then(clearApplyTask, clearApplyTask);
  }
}

function requestListen(): void {
  if (stopping) return;
  listenPending = true;
  if (!applying) {
    const task = drainApplyQueue();
    applyTask = task;
    const clearApplyTask = () => {
      if (applyTask === task) applyTask = null;
    };
    void task.then(clearApplyTask, clearApplyTask);
  }
}

async function drainApplyQueue(): Promise<void> {
  applying = true;
  try {
    while ((applyPending || listenPending) && !stopping) {
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
    if (!lightingOk || !threadsOk) throw new Error('lighting RPC returned false');
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
    post({ kind: 'state', status: 'error' });
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
    post({ kind: 'state', status: 'error' });
    scheduleRetry();
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\/Users\/[^/]+/g, '/Users/<user>')
    .replace(/[A-Za-z]:\\Users\\[^\\]+/g, 'C:\\Users\\<user>')
    .slice(0, 400);
}

async function ensureConnected(): Promise<WorkLouderApi | null> {
  if (api) return api;
  const loaded = loadSdk();
  const discovery = new loaded.WLDeviceDiscovery(sdkLogger);
  const devices = discovery
    .findWLDevices([loaded.DeviceType.CodexMicro])
    .toSorted((left, right) => Number(right.isUsbConnection) - Number(left.isUsbConnection));
  const device = devices[0];
  if (!device) return null;
  const nextComm = new loaded.WLDeviceCommImpl(sdkLogger);
  if (!(await nextComm.connect(device))) return null;
  comm = nextComm;
  const nextApi = new loaded.RPCApiOAI(nextComm, sdkLogger);
  if (typeof nextApi.onHidReceived === 'function') {
    const unsubscribe = nextApi.onHidReceived((event) => {
      const slot = parseWorkLouderCodexAgentKeyPress(event);
      if (slot !== null) post({ kind: 'agent-key', slot });
    });
    unsubscribeHid = typeof unsubscribe === 'function' ? unsubscribe : null;
  } else {
    hostLog('warn', 'Work Louder SDK does not expose Agent key events');
  }
  api = nextApi;
  return nextApi;
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
  const unsubscribe = unsubscribeHid;
  unsubscribeHid = null;
  if (unsubscribe) {
    try {
      unsubscribe();
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
  hidListeningRequested = false;
  clearRetry();
  try {
    await applyTask;
  } catch (error) {
    hostLog('warn', `lighting apply stopped unexpectedly: ${safeErrorMessage(error)}`);
  }
  const currentApi = api;
  if (currentApi) {
    const off = offFrame();
    await Promise.allSettled([
      currentApi.sendLightingConfig({ ambient: off.ambient, keys: off.keys }),
      currentApi.sendThreadsLighting(off.threads),
    ]);
  }
  await disconnect();
  post({ kind: 'stopped' });
}

function offFrame(): WorkLouderCodexLightingFrame {
  const offSide = { effect: 0, brightness: 0, speed: 0, magic: 0, color: 0 };
  return {
    ambient: offSide,
    keys: offSide,
    threads: Array.from({ length: 6 }, (_, id) => ({
      id,
      color: 0,
      brightness: 0,
      effect: 0,
      speed: 0,
      syncKeysLighting: false,
      syncAmbientLighting: false,
    })),
  };
}
