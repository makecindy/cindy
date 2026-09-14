/**
 * Isolated utility-process host for the optional Work Louder Codex Micro SDK.
 * The package is loaded only from a path resolved by Electron main; Cindy does
 * not bundle or copy the proprietary SDK.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  applyCreatorMicro2AgentLayer,
  CREATOR_MICRO_2_AGENT_KEYMAP,
  CREATOR_MICRO_2_KEYMAP_RELOAD_MS,
  createWorkLouderCodexOffFrame,
  creatorMicro2KeymapBackupFileName,
  creatorMicro2KeymapSessionFileName,
  isWorkLouderHidContention,
  isWorkLouderSdkTransportDeath,
  shouldRequestWorkLouderLivenessProbe,
  isWorkLouderCodexLightingFrameOff,
  parseWorkLouderCodexHidEvent,
  parseWorkLouderKeymapDocument,
  resolveWorkLouderActiveLayerIndex,
  resolveWorkLouderActiveProfileIndex,
  rewriteBareWorkLouderNotifyJson,
  readWorkLouderDeviceStatusOrThrow,
  unwrapWorkLouderKeymapText,
  isCindyExclusiveAgentKeymap,
  WORKLOUDER_DEVICE_KEYMAP_FILE,
  workLouderFirmwareIdlesHidRead,
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
  portPath?: string;
  devicePid?: string;
  serialNumber?: string;
}

interface WorkLouderDeviceStatus {
  firmwareVersion?: string;
  batteryPercentage?: number;
  isCharging?: boolean;
  layerIndex?: number;
  profileIndex?: number;
}

interface WorkLouderComm {
  connect(device: WorkLouderDevice): Promise<boolean>;
  disconnect(): Promise<void>;
}

interface WorkLouderRpcResult {
  ok?: boolean;
  value?: unknown;
  error?: { message?: string };
}

interface WorkLouderFsApi {
  readFile(fileName: string): Promise<WorkLouderRpcResult>;
  writeFile(fileName: string, data: unknown): Promise<WorkLouderRpcResult>;
}

interface WorkLouderApi {
  sendLightingConfig(
    config: Pick<WorkLouderCodexLightingFrame, 'ambient' | 'keys'>,
  ): Promise<unknown>;
  sendThreadsLighting(threads: WorkLouderCodexLightingFrame['threads']): Promise<unknown>;
  onHidReceived?(listener: (event: unknown) => void): (() => void) | void;
  onJoystickMove?(listener: (event: unknown) => void): (() => void) | void;
  getDeviceStatus?(): Promise<WorkLouderDeviceStatus | WorkLouderRpcResult>;
  /** Runtime field on `RPCApiOAI`; sharing it avoids a second RPC client on the same HID. */
  api?: WorkLouderFsApi;
}

interface WorkLouderSdk {
  DeviceType: { CodexMicro: unknown; CreatorMicroV2?: unknown };
  WLDeviceDiscovery: new (logger?: WorkLouderLogger) => {
    findWLDevices(filter?: unknown[]): WorkLouderDevice[];
  };
  WLDeviceCommImpl: new (logger?: WorkLouderLogger) => WorkLouderComm;
  RPCApiOAI: new (comm: WorkLouderComm, logger?: WorkLouderLogger) => WorkLouderApi;
  WLRPCApi?: new (comm: WorkLouderComm, logger?: WorkLouderLogger) => WorkLouderFsApi;
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
const CREATOR_KEYMAP_RETRY_MS = 8_000;
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
let permissionBlocked = false;
const sdkLogBuckets = new Map<string, { startedAt: number; emitted: number; suppressed: number }>();
/** The native SDK often logs a dead USB/BT handle instead of throwing. */
let transportFaulted = false;
/** Which device the current `api` handle belongs to, so probes can refresh it. */
let connectedDevice: {
  deviceType: 'codex-micro' | 'creator-micro-2';
  isUsb: boolean;
  backupId: string | null;
} | null = null;
let keymapBackupDir: string | null = null;
let creatorKeymapBound = false;
let creatorKeymapWritten = false;
let creatorKeymapBinding: Promise<void> | null = null;
let creatorKeymapRetryTimer: ReturnType<typeof setTimeout> | null = null;
let creatorKeymapRetryAt = 0;
let creatorKeymap: readonly (readonly string[])[] = CREATOR_MICRO_2_AGENT_KEYMAP;
let creatorKeymapGeneration = 0;

if (parentPort) {
  parentPort.on('message', (event) => {
    const request = event.data as WorkLouderCodexHostRequest;
    if (request?.kind === 'init') {
      sdkEntry = request.sdkEntry;
      permissionBlocked = false;
      transportFaulted = false;
      lastLoggedError = null;
      keymapBackupDir =
        typeof request.keymapBackupDir === 'string' && request.keymapBackupDir.length > 0
          ? request.keymapBackupDir
          : null;
      if (Array.isArray(request.creatorKeymap) && request.creatorKeymap.length > 0) {
        creatorKeymap = request.creatorKeymap.map((row) => [...row]);
      }
    } else if (request?.kind === 'rebind-creator-keymap') {
      if (Array.isArray(request.keymap) && request.keymap.length > 0) {
        creatorKeymap = request.keymap.map((row) => [...row]);
        creatorKeymapGeneration += 1;
        creatorKeymapBound = false;
        if (api) void bindCreatorAgentKeysWhenIdle(api);
      }
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
    const detail = formatSdkLog(args);
    if (isWorkLouderSdkTransportDeath(detail, connectedDevice?.deviceType)) {
      transportFaulted = true;
    }
    logSdkMessage('error', 'Work Louder SDK reported an error', args);
    if (
      api &&
      !stopping &&
      !probePending &&
      !applying &&
      !creatorKeymapBinding &&
      shouldRequestWorkLouderLivenessProbe(detail, connectedDevice?.deviceType)
    ) {
      requestProbe();
    }
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

function loadWorkLouderFsApi(
  deviceApi: WorkLouderApi,
  deviceComm: WorkLouderComm,
): WorkLouderFsApi | null {
  const existing = deviceApi.api;
  if (
    existing &&
    typeof existing.readFile === 'function' &&
    typeof existing.writeFile === 'function'
  ) {
    return existing;
  }
  const loaded = loadSdk();
  if (typeof loaded.WLRPCApi === 'function') {
    return new loaded.WLRPCApi(deviceComm, sdkLogger);
  }
  if (!sdkEntry) return null;
  const sdkDir = /\.[cm]?js$/.test(sdkEntry) ? path.dirname(sdkEntry) : sdkEntry;
  const nestedKit = path.join(sdkDir, 'node_modules', '@worklouder', 'wl-device-kit');
  for (const root of [sdkDir, nestedKit]) {
    try {
      const kit = createRequire(path.join(root, 'package.json'))(
        '@worklouder/wl-device-kit',
      ) as Partial<WorkLouderSdk>;
      if (typeof kit.WLRPCApi === 'function') return new kit.WLRPCApi(deviceComm, sdkLogger);
    } catch {
      // ChatGPT nests the filesystem API under wl-device-kit; cindy-package may hoist it.
    }
  }
  return null;
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
    const lightingOk = lightingRpcSucceeded(
      await deviceApi.sendLightingConfig({
        ambient: frame.ambient,
        keys: frame.keys,
      }),
    );
    const threadsOk = lightingRpcSucceeded(await deviceApi.sendThreadsLighting(frame.threads));
    if (transportFaulted) throw new Error('lighting transport faulted');
    if (!lightingOk || !threadsOk) {
      hostLog(
        'warn',
        `Work Louder lighting RPC failed (threads=${frame.threads.length}); keeping HID listening`,
      );
    } else {
      hostLog('debug', `Work Louder lighting applied threads=${frame.threads.length}`);
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
    if (isWorkLouderHidContention(message)) {
      post({ kind: 'state', status: 'error', reason: 'device-in-use' });
      scheduleRetry();
      return;
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
    if (transportFaulted) {
      hostLog('debug', 'probe dropped a stale Work Louder transport');
      await disconnect();
    } else if (typeof api.getDeviceStatus === 'function') {
      try {
        // Call it directly rather than through postDeviceStatus, which swallows
        // failures — swallowing here would make every probe "succeed" and defeat
        // the whole point. Same round trip also keeps battery and firmware fresh.
        const status = readWorkLouderDeviceStatusOrThrow(await api.getDeviceStatus());
        if (!transportFaulted) {
          const device = connectedDevice;
          if (device) postDeviceState(device.deviceType, device.isUsb, status);
          post({ kind: 'state', status: 'connected' });
          return;
        }
      } catch (error) {
        hostLog('debug', `probe status failed: ${safeErrorMessage(error)}`);
        if (isOptionalDeviceStatusError(error)) {
          post({ kind: 'state', status: 'connected' });
          return;
        }
        const creatorStillPresent =
          workLouderFirmwareIdlesHidRead(connectedDevice?.deviceType) &&
          findCandidates().some(
            (candidate) => candidate.deviceType === connectedDevice?.deviceType,
          );
        if (!transportFaulted && creatorStillPresent) {
          post({ kind: 'state', status: 'connected' });
          return;
        }
      }
      hostLog('debug', 'probe dropped a stale Work Louder transport');
      await disconnect();
    } else {
      post({ kind: 'state', status: 'connected' });
      return;
    }
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
    if (isWorkLouderHidContention(message)) {
      post({ kind: 'state', status: 'error', reason: 'device-in-use' });
      scheduleCreatorKeymapRetry();
      return;
    }
    post({ kind: 'state', status: 'not-detected' });
    scheduleRetry();
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
    if (isWorkLouderHidContention(message)) {
      post({ kind: 'state', status: 'error', reason: 'device-in-use' });
      scheduleCreatorKeymapRetry();
      return;
    }
    await disconnect();
    post({ kind: 'state', status: 'error', reason: classifyConnectionError(message) });
    scheduleRetry();
  }
}

/**
 * Creator firmware often omits `method` on HID reports. Patch the SDK's JSON
 * parser so those lines become `v.oai.hid` / `v.oai.rad` notifies instead of
 * being dropped as "RPC call without id and method".
 */
function recoverBareWorkLouderNotifies(comm: WorkLouderComm): void {
  const target = comm as WorkLouderComm & {
    parseRpcData?: (data: string) => boolean;
    rpcResponse?: string;
  };
  const original = target.parseRpcData;
  if (typeof original !== 'function') return;
  let loggedRecovery = false;
  target.parseRpcData = function parseRpcDataWithBareNotifyRecovery(
    this: { rpcResponse?: string },
    data: string,
  ): boolean {
    const pending = typeof this.rpcResponse === 'string' ? this.rpcResponse : '';
    const combined =
      pending.length === 0
        ? (() => {
            const jsonStart = data.indexOf('{');
            return jsonStart === -1 ? data : data.slice(jsonStart);
          })()
        : pending + data;
    const rewritten = rewriteBareWorkLouderNotifyJson(combined);
    if (rewritten) {
      if (!loggedRecovery) {
        loggedRecovery = true;
        hostLog('info', 'recovered a compact Work Louder HID notify');
      }
      this.rpcResponse = '';
      return original.call(this, rewritten);
    }
    return original.call(this, data);
  };
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

function lightingRpcSucceeded(result: unknown): boolean {
  if (result === true) return true;
  if (result === false || result == null) return false;
  if (typeof result === 'object' && 'ok' in result) return (result as { ok: unknown }).ok === true;
  return true;
}

function describeHidEvent(event: unknown): string {
  if (!event || typeof event !== 'object') return safeErrorMessage(event);
  const hid = event as { key?: unknown; act?: unknown; agent?: unknown };
  return JSON.stringify({ key: hid.key, act: hid.act, agent: hid.agent });
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\/Users\/[^/]+/g, '/Users/<user>')
    .replace(/[A-Za-z]:\\Users\\[^\\]+/g, 'C:\\Users\\<user>')
    .slice(0, 400);
}

function sleep(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (stopping || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(50, deadline - Date.now())).unref?.();
    };
    tick();
  });
}

function workLouderFsSucceeded(result: WorkLouderRpcResult | null | undefined): boolean {
  return Boolean(result && result.ok !== false);
}

async function restoreCreatorKeymap(deviceApi: WorkLouderApi): Promise<void> {
  if (connectedDevice?.deviceType !== 'creator-micro-2' || !keymapBackupDir || !comm) return;
  const sessionPath = path.join(
    keymapBackupDir,
    creatorMicro2KeymapSessionFileName(connectedDevice.backupId),
  );
  const factoryPath = path.join(
    keymapBackupDir,
    creatorMicro2KeymapBackupFileName(connectedDevice.backupId),
  );
  let liveText: string | null = null;
  try {
    liveText = await fs.readFile(sessionPath, 'utf8');
  } catch {
    try {
      liveText = await fs.readFile(factoryPath, 'utf8');
    } catch {
      return;
    }
  }
  const fsApi = loadWorkLouderFsApi(deviceApi, comm);
  if (!fsApi) return;
  const writeResult = await fsApi.writeFile(WORKLOUDER_DEVICE_KEYMAP_FILE, liveText);
  if (!workLouderFsSucceeded(writeResult)) {
    throw new Error(writeResult?.error?.message ?? 'fs.write keymap.json restore failed');
  }
  creatorKeymapBound = false;
  creatorKeymapWritten = false;
  hostLog('info', 'Work Louder pre-occupancy keymap restored');
}

async function writeKeymapSnapshot(filePath: string, liveText: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, liveText, 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function backupCreatorKeymap(
  liveText: string,
  profileIndex: number,
  layerIndex: number,
): Promise<void> {
  if (!keymapBackupDir) {
    throw new Error('Creator Micro 2 keymap backup directory is missing');
  }
  await fs.mkdir(keymapBackupDir, { recursive: true });
  const factoryPath = path.join(
    keymapBackupDir,
    creatorMicro2KeymapBackupFileName(connectedDevice?.backupId),
  );
  try {
    await fs.access(factoryPath);
  } catch {
    await writeKeymapSnapshot(factoryPath, liveText);
  }
  // Snapshot the whole document, but decide from the layer Cindy is about to
  // overwrite. A stale Cindy map on another layer must not skip this capture.
  if (!isCindyExclusiveAgentKeymap(liveText, profileIndex, layerIndex)) {
    await writeKeymapSnapshot(
      path.join(keymapBackupDir, creatorMicro2KeymapSessionFileName(connectedDevice?.backupId)),
      liveText,
    );
  }
}

async function bindCreatorAgentKeys(deviceApi: WorkLouderApi): Promise<void> {
  if (creatorKeymapBound || stopping) return;
  if (connectedDevice?.deviceType !== 'creator-micro-2') return;
  if (!comm) return;
  const generation = creatorKeymapGeneration;
  const fsApi = loadWorkLouderFsApi(deviceApi, comm);
  if (!fsApi) {
    hostLog('warn', 'Work Louder keymap bind could not load WLRPCApi');
    return;
  }
  const liveResult = await fsApi.readFile(WORKLOUDER_DEVICE_KEYMAP_FILE);
  if (!workLouderFsSucceeded(liveResult)) {
    throw new Error(liveResult?.error?.message ?? 'fs.read keymap.json failed');
  }
  const liveText = unwrapWorkLouderKeymapText(liveResult);
  if (!liveText) throw new Error('fs.read keymap.json returned an empty payload');
  const document = parseWorkLouderKeymapDocument(liveText);
  if (!document) throw new Error('keymap.json is not a Work Louder keymap document');
  const status =
    typeof deviceApi.getDeviceStatus === 'function'
      ? readWorkLouderDeviceStatusOrThrow(await deviceApi.getDeviceStatus())
      : {};
  const profileIndex = resolveWorkLouderActiveProfileIndex(
    status.profileIndex,
    document.profiles.length,
  );
  const layerCount = document.profiles[profileIndex]?.layers.length ?? 0;
  const layerIndex = resolveWorkLouderActiveLayerIndex(status.layerIndex, layerCount);
  const next = applyCreatorMicro2AgentLayer(document, layerIndex, creatorKeymap, profileIndex);
  if (!next.changed) {
    creatorKeymapBound = true;
    if (next.alreadyBound) creatorKeymapWritten = true;
    clearCreatorKeymapRetry();
    hostLog(
      'info',
      next.alreadyBound
        ? `Work Louder layer ${layerIndex + 1} already emits agent keys`
        : `Work Louder keymap layer ${layerIndex + 1} was not rewritten`,
    );
    return;
  }
  await backupCreatorKeymap(liveText, profileIndex, layerIndex);
  const writeResult = await fsApi.writeFile(
    WORKLOUDER_DEVICE_KEYMAP_FILE,
    JSON.stringify(next.document),
  );
  if (!workLouderFsSucceeded(writeResult)) {
    throw new Error(writeResult?.error?.message ?? 'fs.write keymap.json failed');
  }
  creatorKeymapWritten = true;
  await sleep(CREATOR_MICRO_2_KEYMAP_RELOAD_MS);
  if (generation !== creatorKeymapGeneration || stopping) return;
  creatorKeymapBound = true;
  clearCreatorKeymapRetry();
  hostLog('info', `Work Louder layer ${layerIndex + 1} now emits agent keys instead of keystrokes`);
}

async function bindCreatorAgentKeysWhenIdle(deviceApi: WorkLouderApi): Promise<void> {
  if (connectedDevice?.deviceType !== 'creator-micro-2') return;
  while (!stopping && !creatorKeymapBound) {
    if (Date.now() < creatorKeymapRetryAt) break;
    if (creatorKeymapBinding) {
      await creatorKeymapBinding;
      continue;
    }
    const task = bindCreatorAgentKeys(deviceApi)
      .catch((error) => {
        const message = safeErrorMessage(error);
        hostLog('warn', `Creator Micro 2 keymap bind failed: ${message}`);
        if (isWorkLouderHidContention(message)) {
          hostLog(
            'warn',
            'Creator Micro 2 vendor HID is busy; another app may be using the keyboard',
          );
          scheduleCreatorKeymapRetry();
        }
        throw error;
      })
      .finally(() => {
        if (creatorKeymapBinding === task) creatorKeymapBinding = null;
      });
    creatorKeymapBinding = task;
    await task;
  }
  if (!stopping && !creatorKeymapBound && Date.now() < creatorKeymapRetryAt) {
    throw new Error('Creator Micro 2 vendor HID is busy; device has been closed');
  }
}

function scheduleCreatorKeymapRetry(): void {
  if (stopping || creatorKeymapBound || creatorKeymapRetryTimer) return;
  creatorKeymapRetryAt = Date.now() + CREATOR_KEYMAP_RETRY_MS;
  creatorKeymapRetryTimer = setTimeout(() => {
    creatorKeymapRetryTimer = null;
    creatorKeymapRetryAt = 0;
    if (stopping || creatorKeymapBound || !api) return;
    requestListen();
    if (latestFrame && !isWorkLouderCodexLightingFrameOff(latestFrame)) requestApply();
  }, CREATOR_KEYMAP_RETRY_MS);
  creatorKeymapRetryTimer.unref?.();
}

function clearCreatorKeymapRetry(): void {
  creatorKeymapRetryAt = 0;
  if (!creatorKeymapRetryTimer) return;
  clearTimeout(creatorKeymapRetryTimer);
  creatorKeymapRetryTimer = null;
}

async function ensureConnected(): Promise<WorkLouderApi | null> {
  if (api && transportFaulted) await disconnect();
  if (api) {
    await bindCreatorAgentKeysWhenIdle(api);
    return api;
  }
  const candidate = findCandidates()[0];
  if (!candidate) return null;
  const loaded = loadSdk();
  const nextComm = new loaded.WLDeviceCommImpl(sdkLogger);
  recoverBareWorkLouderNotifies(nextComm);
  if (!(await nextComm.connect(candidate.device))) return null;
  comm = nextComm;
  const nextApi = new loaded.RPCApiOAI(nextComm, sdkLogger);
  if (typeof nextApi.onHidReceived === 'function') {
    const unsubscribe = nextApi.onHidReceived((event) => {
      postActivity();
      const parsed = parseWorkLouderCodexHidEvent(event);
      if (parsed) {
        post({ kind: 'hid', event: parsed });
        return;
      }
      hostLog('debug', `ignored Work Louder HID event ${describeHidEvent(event)}`);
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
    backupId: creatorKeymapBackupId(candidate.device),
  };
  await postDeviceStatus(nextApi, candidate.deviceType, candidate.device.isUsbConnection === true);
  await bindCreatorAgentKeysWhenIdle(nextApi);
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
      status = readWorkLouderDeviceStatusOrThrow(await deviceApi.getDeviceStatus());
    } catch (error) {
      hostLog('warn', `device status unavailable: ${safeErrorMessage(error)}`);
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
): 'connection-failed' | 'permission-required' | 'device-in-use' {
  if (isWorkLouderHidContention(message)) return 'device-in-use';
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

function creatorKeymapBackupId(device: WorkLouderDevice): string | null {
  const serial = typeof device.serialNumber === 'string' ? device.serialNumber.trim() : '';
  if (serial) return serial;
  const pid = typeof device.devicePid === 'string' ? device.devicePid.trim() : '';
  const portPath = typeof device.portPath === 'string' ? device.portPath.trim() : '';
  if (pid && portPath) return `${pid}-${portPath}`;
  if (portPath) return portPath;
  if (pid) return pid;
  return null;
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
  const currentApi = api;
  if (currentApi && creatorKeymapWritten) {
    try {
      await restoreCreatorKeymap(currentApi);
    } catch (error) {
      hostLog('warn', `Creator Micro 2 keymap restore failed: ${safeErrorMessage(error)}`);
    }
  }
  transportFaulted = false;
  connectedDevice = null;
  creatorKeymapBound = false;
  creatorKeymapWritten = false;
  creatorKeymapBinding = null;
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

async function awaitWithTimeout(task: Promise<unknown> | null, ms: number): Promise<void> {
  if (!task) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  listenPending = false;
  probePending = false;
  discoverPending = false;
  hidListeningRequested = false;
  clearRetry();
  clearCreatorKeymapRetry();
  // Client disconnectHost() kills this process after 1s. Do not wait on SDK RPCs.
  await awaitWithTimeout(applyTask, 400);
  await awaitWithTimeout(creatorKeymapBinding, 400);
  const currentApi = api;
  if (currentApi) {
    const off = createWorkLouderCodexOffFrame();
    await awaitWithTimeout(
      Promise.allSettled([
        currentApi.sendLightingConfig({ ambient: off.ambient, keys: off.keys }),
        currentApi.sendThreadsLighting(off.threads),
      ]),
      200,
    );
  }
  await disconnect();
  post({ kind: 'stopped' });
}
