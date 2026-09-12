import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, ipcMain } from 'electron';
import type { AgentIslandSessionActivity } from '../../shared/agentIsland.js';
import { registerInputDevice } from '../input-devices/registry.js';
import { createLogger } from '../logger.js';
import { openMainWindowSession } from '../deepLink.js';
import { buildWorkLouderCodexTaskCatalog, listWorkLouderCodexTaskCatalog } from '../worklouder-codex/taskSlots.js';
import { readRendererTaskCatalog, subscribeRendererTaskCatalog } from '../worklouder-codex/taskCatalogPublication.js';
import {
  DeviceLinkOwnershipArbiter,
  createSqliteExclusiveFileLock,
  type OwnershipLock,
} from '../device-link/ownership.js';
import { PassportController } from './controller.js';
import { createPassportTaskCatalogReader } from './catalogReader.js';
import { PassportTaskHistory, passportTextPage, type PassportAction } from './protocol.js';
import { latestMessage } from '../localDb/latestMessageText.js';
import { PassportVoice } from './voice.js';
import type { PassportDictation, PassportState } from '../../shared/passport.js';
import {
  activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireString, requireBoolean, throwIpcError } from '../utils/ipcValidate.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { transcribeVoiceInputOpus } from '../voice-input/index.js';
import { classifyVoiceInputConnectionTestError } from '../voice-input/voiceInputConnectionTest.js';

const log = createLogger('passport');
let registered = false;

const PASSPORT_HELPER_LOCK_FILE = 'passport-helper-ownership.lock.db';
const PASSPORT_HELPER_RESTART_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000] as const;

export function registerPassportInputDevice(): void {
  // Explicit opt-in development feature; does not prompt every Mac for Bluetooth.
  if (registered) return;
  registered = true;
  const settings = createOverrideSettingsFile({
    filePath: () => ownerScopedUserDataPath('passport-settings.json'),
    defaults: { enabled: process.env.CINDY_PASSPORT_BLE === '1' },
    normalize: (raw) => ({ enabled: !!raw && typeof raw === 'object' && 'enabled' in raw && typeof raw.enabled === 'boolean'
      ? raw.enabled : process.env.CINDY_PASSPORT_BLE === '1' }),
    mergeOverrides: ({ patch, overrides }) => ({ ...overrides, ...patch }),
    log, label: 'Passport', scopeKey: activeOwnerScopeKey, maxBytes: 1024, preserveUnreadableFile: true,
  });
  const isEnabled = (): boolean => process.platform === 'darwin' && settings.read().enabled;
  let devices: string[] = [], bluetooth = 0;
  let voiceState: PassportState['voice'] = 'idle';
  let pending: (PassportDictation & { owner: string; recordingToken: number; page: number; confirmed: boolean; confirmedAt: number; claimed: boolean; sendFailed: boolean }) | null = null;
  let reading: { id: string; owner: string; page: number; text: string; createdAt: number | null } | null = null;
  let voiceOwner = '';
  let voiceTaskId = '';
  let voiceToken = 0, voiceRevision = 0;
  const voice = new PassportVoice();
  let child: ChildProcessWithoutNullStreams | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let wanted = false;
  let starting = false;
  let generation = 0;
  let refreshing = false;
  let heartbeatAt = 0;
  let childExit: Promise<void> = Promise.resolve();
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartAttempt = 0;
  let ownershipLock: OwnershipLock | null = null;
  let ownershipLockPath = '';
  let expectedExitChild: ChildProcessWithoutNullStreams | null = null;
  let launchPromise: Promise<void> | null = null;
  const history = new PassportTaskHistory();
  let activity: readonly AgentIslandSessionActivity[] = [];
  const catalogReader = createPassportTaskCatalogReader({
    getScope: () => (isAppSessionBoundaryPending() ? null : activeOwnerScopeKey()),
    readPublished: (scope) => readRendererTaskCatalog(scope),
    readLocal: () => listWorkLouderCodexTaskCatalog(),
    build: (rows) => buildWorkLouderCodexTaskCatalog(rows, { publishedVisibleOrder: true }),
  });
  const releaseOwnershipLock = (): void => {
    ownershipLock?.release();
    ownershipLock = null;
    ownershipLockPath = '';
  };
  const getOwnershipLock = (): OwnershipLock | null => {
    if (isAppSessionBoundaryPending()) {
      // A boundary invalidates the current owner. Drop a held lock so a
      // sibling instance can take over once the new owner is ready.
      releaseOwnershipLock();
      return null;
    }
    if (!wanted) return ownershipLock;
    let lockPath: string;
    try {
      lockPath = path.join(app.getPath('userData'), PASSPORT_HELPER_LOCK_FILE);
    } catch {
      return null;
    }
    if (ownershipLock && ownershipLockPath === lockPath) return ownershipLock;
    // userData is fixed for a running Electron instance. If that assumption
    // ever changes, do not release a live lock behind the arbiter's back.
    if (ownershipLock?.isHeld()) return null;
    releaseOwnershipLock();
    ownershipLock = createSqliteExclusiveFileLock(lockPath);
    ownershipLockPath = lockPath;
    return ownershipLock;
  };
  const controller = new PassportController((line) => {
    if (child && !child.stdin.destroyed) child.stdin.write(line);
  }, (id) => {
    const version = controller.connectionVersion;
    // Recheck the current canonical catalog before routing a device-supplied ID.
    void catalogReader.readFresh().then((catalog) => {
      if (wanted && version === controller.connectionVersion && controller.canOpen(id) &&
          catalog.options.some((task) => task.id === id))
        openMainWindowSession(id, { focus: true });
    }).catch(() => log.warn('Passport task selection failed'));
  }, (action) => { void handleAction(action).catch(() => log.warn('Passport action failed')); });
  const handleAction = async (action: PassportAction): Promise<void> => {
    const owner = activeOwnerScopeKey(), version = controller.connectionVersion;
    const draft = pending;
    const matches = draft && draft.owner === owner && draft.sessionId === action.id && draft.recordingToken === action.token;
    if (action.action === 4 || action.action === 6) {
      // Leaving the page drops tracking; it cannot undo a message already claimed by Cindy.
      if ((matches && (action.action === 6 || !draft.confirmed)) || (!draft && action.id === voiceTaskId && action.token === voiceToken)) {
        pending = null; voice.reset(); voiceState = 'idle'; voiceRevision++;
      }
      if (action.action === 6 && reading?.id === action.id) reading = null;
      void refresh(); return;
    }
    if (matches && !draft.confirmed && (action.action === 2 || action.action === 3)) {
      const page = passportTextPage(draft.text, draft.page);
      draft.page = action.action === 2 ? Math.max(0, page.page - 1) : (page.page + 1) % page.count;
      void refresh(); return;
    }
    const catalog = await catalogReader.readFresh();
    if (!wanted || owner !== activeOwnerScopeKey() || version !== controller.connectionVersion ||
        !catalog.options.some((task) => task.id === action.id)) return;
    if (action.action === 5) {
      if (!matches || pending !== draft || draft.confirmed) return;
      draft.confirmed = true; draft.confirmedAt = Date.now(); voiceState = 'sending';
      log.info('Passport dictation confirmed on hardware');
      try { openMainWindowSession(draft.sessionId, { focus: true }); }
      catch { draft.confirmed = false; draft.sendFailed = true; voiceState = 'draft'; }
    } else if (action.token === 0 && action.action <= 3) {
      if (!reading || reading.id !== action.id || action.action === 1) {
        reading = { id: action.id, owner, page: 0, text: '', createdAt: null };
      } else reading.page += action.action === 2 ? -1 : 1;
    }
    void refresh();
  };
  ipcMain.handle('passport:state', (event): PassportState => {
    assertTrustedAppRendererEvent(event);
    return { enabled: isEnabled(), supported: process.platform === 'darwin', connected: controller.isReady, voice: voiceState, devices, bluetooth };
  });
  ipcMain.handle('passport:dictation', async (event, value: unknown): Promise<PassportDictation | null> => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(value, 'sessionId');
    if (id.length >= 40 || !pending || pending.sessionId !== id || !pending.confirmed || pending.claimed) return null;
    const current = pending;
    const catalog = await catalogReader.readFresh();
    if (pending !== current || !current.confirmed || current.claimed || current.owner !== activeOwnerScopeKey() || !catalog.options.some((task) => task.id === id)) return null;
    current.claimed = true;
    return { token: current.token, sessionId: current.sessionId, text: current.text, ownerStamp: current.ownerStamp };
  });
  ipcMain.handle('passport:dictation-ack', (event, value: unknown, accepted: unknown) => {
    assertTrustedAppRendererEvent(event);
    const token = requireString(value, 'token');
    const sent = requireBoolean(accepted, 'sent');
    if (pending?.token === token && pending.claimed && pending.owner === activeOwnerScopeKey()) {
      if (sent) { pending = null; voiceState = 'idle'; log.info('Passport dictation accepted by task queue'); }
      else { pending.confirmed = false; pending.claimed = false; pending.sendFailed = true; voiceState = 'draft'; }
      void refresh();
    }
  });
  const handleVoice = (line: string): void => {
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object' || !('kind' in event) || event.kind !== 'voice') return;
    try {
      if (!('packet' in event) || typeof event.packet !== 'string' || event.packet.length > 272) throw new Error('Invalid voice frame');
      const packet = Buffer.from(event.packet, 'base64');
      if (packet.toString('base64') !== event.packet) throw new Error('Invalid voice encoding');
      if (packet[0] === 1) {
        if (voiceState === 'transcribing' || pending) throw new Error('Previous dictation is pending');
        voiceOwner = activeOwnerScopeKey();
        voiceToken = packet.readUInt32LE(1); voiceRevision++;
      }
      const result = voice.accept(packet, (id) => voiceOwner === activeOwnerScopeKey() && controller.canOpen(id));
      if (packet[0] === 1) voiceTaskId = packet.subarray(7, packet.indexOf(0, 7)).toString('utf8');
      voiceState = packet[0] === 4 ? 'idle' : 'recording';
      if (!result) return;
      voiceState = 'transcribing';
      const owner = voiceOwner, version = controller.connectionVersion, revision = voiceRevision;
      const current = (): boolean => wanted && owner === activeOwnerScopeKey() && version === controller.connectionVersion && revision === voiceRevision;
      void (async () => {
        try {
          const catalog = await catalogReader.readFresh();
          if (!current() || !catalog.options.some((task) => task.id === result.id)) return;
          const transcription = await transcribeVoiceInputOpus(result.audio);
          const latest = await catalogReader.readFresh();
          if (!current() || !latest.options.some((task) => task.id === result.id)) return;
          if (!transcription.text.trim()) throw new Error('Empty dictation');
          pending = { token: randomUUID(), sessionId: result.id, text: transcription.text, owner, ownerStamp: getActiveDataOwnerPushStamp(),
            recordingToken: result.token, page: 0, confirmed: false, confirmedAt: 0, claimed: false, sendFailed: false };
          voiceState = 'draft'; void refresh();
        } catch (error) {
          if (current()) {
            voiceState = 'error';
            log.warn('Passport transcription failed', { reason: classifyVoiceInputConnectionTestError(error) });
          }
        }
      })();
    } catch { voice.reset(); if (!pending && voiceState !== 'transcribing') voiceState = 'error'; log.warn('Passport recording rejected'); }
  };
  const refresh = async (): Promise<void> => {
    if (!wanted || refreshing) return;
    refreshing = true;
    const epoch = generation, owner = activeOwnerScopeKey();
    try {
      const catalog = await catalogReader.readForRefresh();
      if (pending && pending.owner !== owner) { pending = null; voiceState = 'idle'; voiceRevision++; }
      if (pending?.confirmed && !pending.claimed && Date.now() - pending.confirmedAt > 15_000) {
        pending.confirmed = false; pending.sendFailed = true; voiceState = 'draft';
      }
      if (reading && reading.owner !== owner) reading = null;
      if (voiceTaskId && !catalog.options.some((task) => task.id === voiceTaskId)) {
        pending = null; voice.reset(); voiceState = 'idle'; voiceRevision++; voiceTaskId = '';
      }
      if (reading && !catalog.options.some((task) => task.id === reading!.id)) reading = null;
      const view = reading;
      if (view && !pending && voiceState === 'idle' && catalog.options.some((task) => task.id === view.id)) {
        const reply = await latestMessage(view.id, 'assistant');
        if (reading === view && owner === activeOwnerScopeKey()) {
          if (view.createdAt !== reply.createdAt) view.page = 0;
          view.text = reply.text; view.createdAt = reply.createdAt;
        }
      }
      if (wanted && epoch === generation && owner === activeOwnerScopeKey()) {
        const feedback: Record<PassportState['voice'], string> = {
          idle: '', recording: '正在接收录音', transcribing: 'Cindy 正在转写',
          draft: '', sending: '正在发送到原任务', error: '转写失败，请重新录音',
        };
        const selected = pending?.sessionId ?? reading?.id;
        const tasks = history.tasks(catalog.options, activity, selected);
        controller.update(tasks.map((task) => {
          if (pending?.sessionId === task.id) {
            if (pending.confirmed) return { ...task, status: 'sending', message: feedback.sending };
            const page = passportTextPage(pending.text, pending.page); pending.page = page.page;
            return { ...task, status: `${pending.sendFailed ? 'retry' : 'draft'}:${pending.recordingToken.toString(16).padStart(8, '0')}`,
              message: page.message };
          }
          if (task.id === voiceTaskId && feedback[voiceState]) {
            const status = voiceState === 'error' || voiceState === 'transcribing'
              ? `${voiceState === 'error' ? 'error' : 'asr'}:${voiceToken.toString(16).padStart(8, '0')}` : voiceState;
            return { ...task, status, message: feedback[voiceState] };
          }
          if (reading?.id === task.id) {
            const page = passportTextPage(reading.text || '等待 Cindy 返回结果', reading.page); reading.page = page.page;
            return { ...task, message: page.message };
          }
          return task;
        }));
      }
      if (wanted && epoch === generation && Date.now() - heartbeatAt >= 5000) {
        heartbeatAt = Date.now(); controller.heartbeat();
      }
    } catch {
      if (wanted && epoch === generation) {
        if (!catalogReader.hasCurrentSnapshot()) controller.update([]);
        log.warn('Passport task catalog unavailable');
      }
    }
    finally { refreshing = false; }
  };
  const unsubscribeTaskCatalog = subscribeRendererTaskCatalog(() => { void refresh(); });
  const cancelRestart = (): void => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
  };
  const resetHelperState = (): void => {
    controller.reset();
    voice.reset();
    pending = null; reading = null; voiceRevision++;
    voiceState = 'idle';
    devices = [];
    bluetooth = 0;
  };
  const requestChildStop = (): Promise<void> => {
    const current = child;
    if (!current) return childExit;
    expectedExitChild = current;
    try { current.stdin.end(); } catch { /* The child may already be closing. */ }
    try { current.kill(); } catch { /* The child may already be gone. */ }
    return childExit;
  };
  const scheduleRestart = (reason: string): void => {
    if (!wanted || !ownership.isOwner() || restartTimer) return;
    if (restartAttempt >= PASSPORT_HELPER_RESTART_DELAYS_MS.length) {
      log.warn('Passport helper restart limit reached; disable and enable the accessory to retry');
      return;
    }
    const delay = PASSPORT_HELPER_RESTART_DELAYS_MS[Math.min(restartAttempt, PASSPORT_HELPER_RESTART_DELAYS_MS.length - 1)];
    restartAttempt++;
    log.warn(`Passport helper ${reason}; retrying in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (wanted && ownership.isOwner()) launchPromise = launchHelper();
    }, delay);
    restartTimer.unref?.();
  };
  const launchHelper = async (): Promise<void> => {
    if (!wanted || !ownership.isOwner() || starting) return;
    // A deliberately stopped child may still be delivering its final exit
    // event. Wait for that event before creating the replacement.
    if (child && child !== expectedExitChild) return;
    starting = true;
    const epoch = generation;
    let launchFailed = false;
    try {
      await childExit;
      if (!wanted || !ownership.isOwner() || epoch !== generation) return;
      let executable: string;
      if (app.isPackaged) {
        executable = path.join(process.resourcesPath, 'tools', 'passport', 'cindy-passport');
        await fs.access(executable);
      } else {
        const source = path.join(app.getAppPath(), 'native', 'passport', 'passport.swift');
        const dir = path.join(app.getPath('userData'), 'passport');
        await fs.mkdir(dir, { recursive: true });
        executable = path.join(dir, 'cindy-passport');
        await promisify(execFile)('xcrun', ['swiftc', source, '-O', '-framework', 'AppKit', '-framework', 'CoreBluetooth',
          '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
          '-Xlinker', path.join(path.dirname(source), 'Info.plist'), '-o', executable]);
      }
      if (!wanted || !ownership.isOwner() || epoch !== generation) return;
      const profile = createHash('sha256').update(app.getPath('userData') + ':' + getActiveDataOwnerPushStamp().dataOwnerId).digest('hex').slice(0, 16);
      const next = spawn(executable, [profile], { stdio: ['pipe', 'pipe', 'pipe'] });
      child = next;
      expectedExitChild = null;
      const launchedAt = Date.now();
      let exited = false;
      let failure = false;
      let resolveChildExit!: () => void;
      childExit = new Promise<void>((resolve) => {
        resolveChildExit = resolve;
      });
      const failChild = (reason: string): void => {
        if (child !== next || expectedExitChild === next) return;
        if (!failure) {
          failure = true;
          resetHelperState();
          log.warn(`Passport helper ${reason}`);
        }
        try { next.stdin.end(); } catch { /* The child may already be closing. */ }
        try { next.kill(); } catch { /* The child may already be gone. */ }
      };
      const settleChildExit = (): void => {
        if (exited) return;
        exited = true;
        resolveChildExit();
        if (child !== next) return;
        const expected = expectedExitChild === next;
        if (expected) expectedExitChild = null;
        child = null;
        if (expected) {
          if (!wanted) void ownership.stop();
          return;
        }
        resetHelperState();
        if (Date.now() - launchedAt >= 60_000) restartAttempt = 0;
        if (wanted && ownership.isOwner()) scheduleRestart(failure ? 'failed' : 'exited');
      };
      let buffer = '';
      next.stdout.setEncoding('utf8');
      next.stdout.on('data', (data: string) => {
        if (child !== next) return;
        buffer += data;
        if (buffer.length > 8192) { failChild('output exceeded limit'); return; }
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let helperKind: unknown;
          try {
            const event = JSON.parse(line);
            helperKind = event && typeof event === 'object' && 'kind' in event
              ? (event as { kind?: unknown }).kind
              : undefined;
            if (event.kind === 'devices' && Array.isArray(event.devices) && event.devices.length <= 64 &&
                event.devices.every((id: unknown) => typeof id === 'string' && /^[0-9A-F-]{36}$/i.test(id)) &&
                Number.isInteger(event.bluetooth) && event.bluetooth >= 0 && event.bluetooth <= 5) {
              devices = event.devices; bluetooth = event.bluetooth;
            }
          } catch { /* Invalid helper events have no authority. */ }
          const previousVersion = controller.connectionVersion;
          controller.handle(line);
          if (helperKind === 'ready') {
            cancelRestart();
          }
          if (previousVersion !== controller.connectionVersion) {
            voice.reset(); pending = null; reading = null; voiceRevision++; voiceState = 'idle';
          }
          handleVoice(line);
        }
      });
      next.stderr.resume();
      next.stdin.on('error', () => failChild('stdin failed'));
      next.on('error', () => {
        failChild('failed');
        // A failed spawn may not emit `exit`; no process exists to wait for.
        if (next.pid === undefined) settleChildExit();
      });
      next.once('exit', settleChildExit);
      next.once('close', settleChildExit);
      if (!timer) {
        timer = setInterval(() => { void refresh(); }, 1000);
        timer.unref();
      }
      void refresh();
    } catch (error) {
      launchFailed = true;
      log.warn('Passport helper could not start', error);
    } finally {
      starting = false;
      // A stop/start boundary may have advanced the generation while the
      // previous compile was in flight. Re-arm the current owner once that
      // stale launch settles instead of leaving the requested helper absent.
      if (wanted && ownership.isOwner() && !child && !restartTimer && epoch !== generation) {
        launchPromise = launchHelper();
      }
    }
    if (launchFailed && wanted && ownership.isOwner() && epoch === generation) scheduleRestart('could not start');
  };
  const ownership = new DeviceLinkOwnershipArbiter({
    getLock: getOwnershipLock,
    onAcquire: () => { if (wanted) launchPromise = launchHelper(); },
    onDemote: () => {
      generation++;
      cancelRestart();
      resetHelperState();
      controller.update([]);
      void requestChildStop();
    },
    retryMs: 500,
  });
  const stop = (): void => {
    wanted = false; generation++;
    cancelRestart(); restartAttempt = 0;
    if (timer) clearInterval(timer); timer = null;
    catalogReader.clear();
    controller.reset(); controller.update([]); history.clear(); activity = []; voice.reset(); pending = null; reading = null; voiceRevision++;
    voiceTaskId = ''; voiceState = 'idle'; devices = []; bluetooth = 0;
    const childDone = requestChildStop();
    if (!child) void ownership.stop();
    else void childDone.then(() => { if (!wanted) void ownership.stop(); });
  };
  const start = async (): Promise<void> => {
    if (!isEnabled() || wanted) return;
    wanted = true; generation++;
    ownership.start();
    if (ownership.isOwner()) {
      if (!launchPromise || !starting) launchPromise = launchHelper();
      await launchPromise;
      // A stop/start race can invalidate the launch promise while it is
      // compiling. Re-check after it settles so the resumed request still
      // starts a helper instead of silently finishing with no child.
      if (wanted && ownership.isOwner() && !child && !starting && !restartTimer) {
        launchPromise = launchHelper();
        await launchPromise;
      }
    }
  };
  ipcMain.handle('passport:enabled', async (event, value: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (process.platform !== 'darwin') throwIpcError('INVALID_PARAMS', 'Passport requires macOS');
    try {
      if (value === null) await settings.resetAtomic();
      else await settings.writePatchAtomic({ enabled: requireBoolean(value, 'enabled') });
      if (isEnabled()) await start(); else stop();
    } catch { throwIpcError('INTERNAL', 'Passport settings could not be saved'); }
  });
  ipcMain.handle('passport:connect', (event, value: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireString(value, 'device');
    if (!isEnabled() || !devices.includes(id) || !child) throwIpcError('INVALID_PARAMS', 'Passport device unavailable');
    child.stdin.write(JSON.stringify({ kind: 'connect', id }) + '\n');
  });
  ipcMain.handle('passport:disconnect', (event) => {
    assertTrustedAppRendererEvent(event);
    child?.stdin.write(JSON.stringify({ kind: 'forget' }) + '\n');
  });
  registerInputDevice({
    descriptor: { id: 'cindy-passport', label: 'Cindy Passport', capabilities: [{ kind: 'task-slots', count: 8 }] },
    start: () => { void start(); },
    updateSessionActivity: (next) => { activity = next; history.observe(next); void refresh(); },
    resumeTaskSlots: start,
    suspendTaskSlots: stop,
    dispose: async () => { unsubscribeTaskCatalog(); stop(); await childExit; },
  });
}
