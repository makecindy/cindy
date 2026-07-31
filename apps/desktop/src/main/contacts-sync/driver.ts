/**
 * 智能通讯录 Desktop ↔ Desktop 同步驱动。
 *
 * 数据层交换完整、可重复合并的状态；传输层优先同一局域网 TCP，失败自动走
 * Device Link relay。两条路搬运的是同一份逐设备 AES-GCM 密文。整个流程都是
 * 确定性程序逻辑，不调用模型、不产生 token 消耗。
 */

import { type ContactsSyncClock, type ContactsSyncState } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import { getActiveAppSession } from '../appSessionState.js';
import { getDesktopContactsManager } from '../maker-host/maker-contacts-host.js';
import {
  readContactsSettings,
  writeContactsDeviceSyncEnabled,
} from '../maker-host/contacts-settings-store.js';
import {
  onLocalContactsChanged,
  readContactsChangeToken,
} from '../maker-host/contacts-change-events.js';
import { broadcastContactsChanged } from '../maker-host/contacts-change-broadcast.js';
import { contactsSyncKeyStore } from './keyStore.js';
import { LanContactsSyncTransport } from './lanTransport.js';
import {
  createContactsSyncKeyFrame,
  isContactsSyncWireFrame,
  ContactsSyncWireDecoder,
  type ContactsSyncCipherChunkFrame,
  type ContactsSyncWireFrame,
} from './wire.js';
import { ContactsSyncOutbound } from './sender.js';
import {
  readPersistedContactsSyncStatus,
  writePersistedContactsSyncStatus,
  type PersistedContactsSyncStatus,
} from './statusStore.js';
import {
  contactsDeviceSyncErrorCode,
  emptyContactsDeviceSyncStatus,
  type ContactsDeviceSyncPhase,
  type ContactsDeviceSyncStatus,
} from './statusModel.js';

const log = createLogger('contacts-device-sync');
const BROADCAST_DEBOUNCE_MS = 2_000;
const BROADCAST_INTERVAL_MS = 30 * 60 * 1000;
const KEY_ANNOUNCEMENT_RETRY_MS = 10_000;
const SYNC_ATTEMPT_TIMEOUT_MS = 10_000;

export interface ContactsSyncPeer {
  deviceId: string;
  deviceName: string;
  publicKey?: string | null;
}

export interface ContactsDeviceSyncTransport {
  getSelfDeviceId(): string | null;
  listOnlineDesktopDevices(): ContactsSyncPeer[];
  isPeerAllowed(deviceId: string): boolean;
  sendRelayFrame(deviceId: string, frame: ContactsSyncWireFrame): void;
}

let transport: ContactsDeviceSyncTransport | null = null;
let lan: LanContactsSyncTransport | null = null;
const decoder = new ContactsSyncWireDecoder();
const peerKnownClocks = new Map<string, ContactsSyncClock[]>();
let debounceTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let syncAttemptTimer: NodeJS.Timeout | null = null;
let initialized = false;
let unsubscribeLocalChanges: (() => void) | null = null;
let runtimeGeneration = 0;
const announcedTo = new Map<string, number>();
const respondedToKeyAnnouncement = new Map<string, number>();
const statusListeners = new Set<(status: ContactsDeviceSyncStatus) => void>();
let liveStatus: ContactsDeviceSyncStatus = emptyContactsDeviceSyncStatus();
/** undefined 强制首次 init/get 按当前 owner 装载，避免模块求值期提前碰 userData。 */
let statusOwnerId: string | null | undefined;
let observedContactsChangeToken: string | null | undefined;
const outbound = new ContactsSyncOutbound({
  getGeneration: () => runtimeGeneration,
  getOwnerId: () => getActiveAppSession().dataOwnerId,
  getTransport: () => transport,
  getDirectTransport: () => lan,
  isEnabled,
  getIdentity: () => contactsSyncKeyStore.getIdentity(),
  getPeerPublicKey: (deviceId) => contactsSyncKeyStore.getPeerPublicKey(deviceId),
  readLocalState,
  getKnownClocks: (deviceId) => peerKnownClocks.get(deviceId),
  announceKey,
  onError: recordError,
});

export function initContactsDeviceSync(next: ContactsDeviceSyncTransport): void {
  transport = next;
  initialized = true;
  ensureCurrentOwnerStatus();
  unsubscribeLocalChanges?.();
  unsubscribeLocalChanges = onLocalContactsChanged(notifyLocalContactsChanged);
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = setInterval(() => {
    if (isEnabled()) runSyncTask(() => broadcastContactsNow(true));
  }, BROADCAST_INTERVAL_MS);
  intervalTimer.unref?.();
  refreshOnlineCount();
  if (isEnabled()) {
    try {
      prepareLocalSync();
      startLan();
      setPhase(next.listOnlineDesktopDevices().length > 0 ? 'syncing' : 'waiting');
      runSyncTask(() => broadcastContactsNow(true));
    } catch (error) {
      recordError(error);
    }
  }
}

export function stopContactsDeviceSyncRuntime(): void {
  runtimeGeneration += 1;
  lan?.stop();
  lan = null;
  decoder.reset();
  announcedTo.clear();
  respondedToKeyAnnouncement.clear();
  peerKnownClocks.clear();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (syncAttemptTimer) clearTimeout(syncAttemptTimer);
  syncAttemptTimer = null;
  contactsSyncKeyStore.resetMemory();
  setPhase(isEnabled() ? 'waiting' : 'off');
}

export function disposeContactsDeviceSync(): void {
  stopContactsDeviceSyncRuntime();
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = null;
  transport = null;
  initialized = false;
  unsubscribeLocalChanges?.();
  unsubscribeLocalChanges = null;
}

export function onContactsDeviceSyncStatusChanged(
  listener: (status: ContactsDeviceSyncStatus) => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function getContactsDeviceSyncStatus(): ContactsDeviceSyncStatus {
  ensureCurrentOwnerStatus();
  refreshOnlineCount(false);
  return { ...liveStatus };
}

export async function setContactsDeviceSyncEnabled(enabled: boolean): Promise<void> {
  ensureCurrentOwnerStatus();
  if (enabled && !isCloudSession()) {
    throw new Error('contacts device sync requires a signed-in cloud account');
  }
  if (enabled === isEnabled()) {
    if (enabled) await broadcastContactsNow(true);
    return;
  }
  if (enabled) {
    // 先确认数据库与系统安全存储都可用；失败时不把开关留在“已开启但不可工作”。
    try {
      prepareLocalSync();
    } catch (error) {
      recordError(error);
      throw error;
    }
    writeContactsDeviceSyncEnabled(true);
    liveStatus = { ...liveStatus, enabled: true, errorCode: null };
    startLan();
    setPhase(onlinePeers().length > 0 ? 'syncing' : 'waiting');
    await broadcastContactsNow(true);
    return;
  }
  writeContactsDeviceSyncEnabled(false);
  liveStatus = { ...liveStatus, enabled: false, errorCode: null };
  stopContactsDeviceSyncRuntime();
  setPhase('off');
}

/** Device Link 持有者定期调用，应用其它共享 userData 实例写入的同步开关。 */
export function pollContactsDeviceSyncSettingChange(): void {
  ensureCurrentOwnerStatus();
  const enabled = isEnabled();
  if (enabled === liveStatus.enabled) return;
  if (!enabled) {
    liveStatus = { ...liveStatus, enabled: false, errorCode: null };
    stopContactsDeviceSyncRuntime();
    setPhase('off');
    return;
  }

  liveStatus = { ...liveStatus, enabled: true, errorCode: null };
  prepareAndRun(() => {
    setPhase(onlinePeers().length > 0 ? 'syncing' : 'waiting');
    runSyncTask(() => broadcastContactsNow(true));
  });
}

export async function broadcastContactsNow(requestReply = true): Promise<void> {
  ensureCurrentOwnerStatus();
  if (!isEnabled() || !transport) return;
  prepareLocalSync();
  startLan();
  const peers = onlinePeers();
  refreshOnlineCount();
  if (peers.length === 0) {
    setPhase('waiting');
    return;
  }
  const context = outbound.capture();
  if (!context) return;
  setPhase('syncing');
  // 用户强制同步、重连和首次启用都做完整校准；普通本地变化走已知版本增量。
  if (requestReply) peerKnownClocks.clear();
  await Promise.all(
    peers.map((peer) => outbound.ensureKeyThenSend(peer.deviceId, requestReply, context)),
  );
  if (outbound.isCurrent(context)) scheduleSyncAttemptTimeout();
}

export function handleContactsDeviceLinkStatusChanged(online: boolean): void {
  if (!online) {
    stopContactsDeviceSyncRuntime();
    refreshOnlineCount();
    return;
  }
  // 账号/区域切换后 driver 仍是同一进程级实例；从当前 owner 的文件重建可见状态。
  ensureCurrentOwnerStatus();
  liveStatus = buildInitialStatus();
  emitStatus();
  if (!isEnabled()) return;
  prepareAndRun(() => {
    startLan();
    runSyncTask(() => broadcastContactsNow(true));
  });
}

/** 通讯录本地写入后的去抖入口；远端物化不走这里，避免广播风暴。 */
export function notifyLocalContactsChanged(): void {
  observedContactsChangeToken = readContactsChangeToken();
  if (!isEnabled() || !initialized) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSyncTask(() => broadcastContactsNow(false));
  }, BROADCAST_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/** Device Link 持有者调用；发现其它共享 userData 实例的本地写入后立即补发。 */
export function pollContactsDeviceSyncDataChange(): void {
  ensureCurrentOwnerStatus();
  const token = readContactsChangeToken();
  if (observedContactsChangeToken === undefined) {
    observedContactsChangeToken = token;
    return;
  }
  if (token === observedContactsChangeToken) return;
  observedContactsChangeToken = token;
  if (!isEnabled() || !initialized) return;
  runSyncTask(() => broadcastContactsNow(false));
}

export function handleContactsPeerPresenceChanged(peer: {
  deviceId: string;
  online: boolean;
}): void {
  if (!peer.online) {
    announcedTo.delete(peer.deviceId);
    respondedToKeyAnnouncement.delete(peer.deviceId);
    peerKnownClocks.delete(peer.deviceId);
  }
  refreshOnlineCount();
  if (!peer.online || !isEnabled() || !transport?.isPeerAllowed(peer.deviceId)) return;
  prepareAndRun(() => {
    announceKey(peer.deviceId);
    const pinned = contactsSyncKeyStore.getPeerPublicKey(peer.deviceId);
    if (pinned) runSyncTask(() => outbound.send(peer.deviceId, true));
  });
}

/** relay 入站。key 帧只允许走这条同账号认证通道；LAN 只收已经加密的 cipher 帧。 */
export function handleIncomingContactsRelayFrame(srcDeviceId: string, raw: unknown): void {
  if (!isEnabled() || !transport?.isPeerAllowed(srcDeviceId) || !isContactsSyncWireFrame(raw)) {
    return;
  }
  if (raw.type === 'key') {
    prepareAndRun(() => {
      const firstSeen = contactsSyncKeyStore.pinPeerPublicKey(srcDeviceId, raw.publicKey);
      if (firstSeen) log.info(`pinned contacts sync peer ${shortId(srcDeviceId)}`);
      respondToKey(srcDeviceId);
      startLan();
      runSyncTask(() => outbound.send(srcDeviceId, true));
    });
    return;
  }
  handleIncomingCipherFrame(srcDeviceId, raw, 'relay');
}

function handleIncomingCipherFrame(
  srcDeviceId: string,
  frame: ContactsSyncCipherChunkFrame,
  route: 'lan' | 'relay',
): void {
  if (!isEnabled() || !transport?.isPeerAllowed(srcDeviceId)) return;
  prepareAndRun(() => {
    const selfDeviceId = requireSelfDeviceId();
    const identity = contactsSyncKeyStore.getIdentity();
    const peerKey = contactsSyncKeyStore.getPeerPublicKey(srcDeviceId);
    if (!peerKey) {
      announceKey(srcDeviceId);
      return;
    }
    const message = decoder.accept({
      srcDeviceId,
      dstDeviceId: selfDeviceId,
      frame,
      ownPrivateKey: identity.privateKey,
      expectedPeerPublicKey: peerKey,
    });
    if (!message) return;

    const changed = getDesktopContactsManager().getStore().mergeDeviceSyncState(message.state);
    const remoteState = message.state as ContactsSyncState;
    peerKnownClocks.set(
      srcDeviceId,
      remoteState.clocks.map((clock) => ({ ...clock })),
    );
    recordSuccessfulSync(srcDeviceId, route);
    if (changed) {
      broadcastContactsChanged({ origin: 'remote' });
      log.info(`merged contacts state from ${shortId(srcDeviceId)} via ${route}`);
    }
    if (changed || message.requestReply === true) {
      runSyncTask(() => outbound.send(srcDeviceId, false));
    }
  });
}

function announceKey(deviceId: string): void {
  if (!transport || !transport.isPeerAllowed(deviceId)) return;
  const now = Date.now();
  const lastAnnouncedAt = announcedTo.get(deviceId);
  if (lastAnnouncedAt !== undefined && now - lastAnnouncedAt < KEY_ANNOUNCEMENT_RETRY_MS) return;
  sendKeyAnnouncement(deviceId, now);
}

/** 入站 key 的握手响应独立节流，不能被此前主动公告占掉；否则连续开启两台设备会卡住。 */
function respondToKey(deviceId: string): void {
  if (!transport || !transport.isPeerAllowed(deviceId)) return;
  const now = Date.now();
  const lastRespondedAt = respondedToKeyAnnouncement.get(deviceId);
  if (lastRespondedAt !== undefined && now - lastRespondedAt < KEY_ANNOUNCEMENT_RETRY_MS) return;
  sendKeyAnnouncement(deviceId, now);
  respondedToKeyAnnouncement.set(deviceId, now);
}

function sendKeyAnnouncement(deviceId: string, announcedAt: number): void {
  if (!transport || !transport.isPeerAllowed(deviceId)) return;
  const identity = contactsSyncKeyStore.getIdentity();
  transport.sendRelayFrame(deviceId, createContactsSyncKeyFrame(identity.publicKey));
  announcedTo.set(deviceId, announcedAt);
}

function prepareLocalSync(): void {
  if (!isCloudSession()) {
    throw new Error('contacts device sync requires a signed-in cloud account');
  }
  getDesktopContactsManager().getStore().activateDeviceSync();
  contactsSyncKeyStore.getIdentity();
}

function readLocalState(): ContactsSyncState {
  const store = getDesktopContactsManager().getStore();
  return store.readDeviceSyncState() ?? store.activateDeviceSync();
}

function startLan(): void {
  if (!transport || lan || !isEnabled()) return;
  const selfDeviceId = transport.getSelfDeviceId();
  if (!selfDeviceId) return;
  const identity = contactsSyncKeyStore.getIdentity();
  lan = new LanContactsSyncTransport({
    getSelf: () => {
      const deviceId = transport?.getSelfDeviceId();
      return deviceId
        ? {
            deviceId,
            publicKey: identity.publicKey,
            privateKey: identity.privateKey,
          }
        : null;
    },
    isPeerAllowed: (deviceId, publicKey) =>
      transport?.isPeerAllowed(deviceId) === true &&
      contactsSyncKeyStore.getPeerPublicKey(deviceId) === publicKey,
    onFrame: (srcDeviceId, frame) => handleIncomingCipherFrame(srcDeviceId, frame, 'lan'),
    logger: {
      debug: (message, meta) => log.debug(message, meta),
      warn: (message, meta) => log.warn(message, meta),
    },
  });
  lan.start();
}

function prepareAndRun(action: () => void): void {
  try {
    prepareLocalSync();
    startLan();
    action();
  } catch (error) {
    recordError(error);
  }
}

function runSyncTask(task: () => Promise<void>): void {
  void task().catch((error) => recordError(error));
}

function onlinePeers(): ContactsSyncPeer[] {
  return (
    transport
      ?.listOnlineDesktopDevices()
      .filter((peer) => transport?.isPeerAllowed(peer.deviceId)) ?? []
  );
}

function requireSelfDeviceId(): string {
  const deviceId = transport?.getSelfDeviceId();
  if (!deviceId) throw new Error('contacts sync device link is not online');
  return deviceId;
}

function recordSuccessfulSync(deviceId: string, route: 'lan' | 'relay'): void {
  if (syncAttemptTimer) clearTimeout(syncAttemptTimer);
  syncAttemptTimer = null;
  const peer = onlinePeers().find((candidate) => candidate.deviceId === deviceId);
  const persisted: PersistedContactsSyncStatus = {
    lastSyncAt: new Date().toISOString(),
    lastSyncDeviceId: deviceId,
    lastSyncDeviceName: peer?.deviceName ?? shortId(deviceId),
    lastRoute: route,
  };
  try {
    writePersistedContactsSyncStatus(persisted);
  } catch (error) {
    log.warn('contacts sync status persistence failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  liveStatus = {
    ...liveStatus,
    ...persisted,
    phase: 'up-to-date',
    errorCode: null,
  };
  emitStatus();
}

function recordError(error: unknown): void {
  if (syncAttemptTimer) clearTimeout(syncAttemptTimer);
  syncAttemptTimer = null;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = contactsDeviceSyncErrorCode(error);
  liveStatus = { ...liveStatus, phase: 'error', errorCode };
  emitStatus();
  log.warn('contacts device sync failed', { error: message, errorCode });
}

function scheduleSyncAttemptTimeout(): void {
  if (liveStatus.phase !== 'syncing') return;
  if (syncAttemptTimer) clearTimeout(syncAttemptTimer);
  syncAttemptTimer = setTimeout(() => {
    syncAttemptTimer = null;
    if (liveStatus.phase === 'syncing') setPhase('waiting');
  }, SYNC_ATTEMPT_TIMEOUT_MS);
  syncAttemptTimer.unref?.();
}

function buildInitialStatus(): ContactsDeviceSyncStatus {
  if (!isCloudSession()) return emptyContactsDeviceSyncStatus();
  return {
    available: true,
    enabled: readContactsSettings().deviceSyncEnabled,
    phase: readContactsSettings().deviceSyncEnabled ? 'waiting' : 'off',
    onlineDeviceCount: 0,
    errorCode: null,
    ...readPersistedContactsSyncStatus(),
  };
}

function isEnabled(): boolean {
  return isCloudSession() ? readContactsSettings().deviceSyncEnabled : false;
}

function isCloudSession(): boolean {
  const session = getActiveAppSession();
  return session.mode === 'cloud' && Boolean(session.dataOwnerId);
}

function setPhase(phase: ContactsDeviceSyncPhase): void {
  if (liveStatus.phase === phase && liveStatus.enabled === isEnabled()) return;
  liveStatus = { ...liveStatus, enabled: isEnabled(), phase };
  emitStatus();
}

function refreshOnlineCount(emit = true): void {
  const onlineDeviceCount = onlinePeers().length;
  if (liveStatus.onlineDeviceCount === onlineDeviceCount) return;
  liveStatus = { ...liveStatus, onlineDeviceCount };
  if (emit) emitStatus();
}

function emitStatus(): void {
  const snapshot = { ...liveStatus };
  for (const listener of statusListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      log.warn('contacts sync status listener failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function ensureCurrentOwnerStatus(): void {
  const ownerId = getActiveAppSession().dataOwnerId;
  if (ownerId === statusOwnerId) return;
  runtimeGeneration += 1;
  lan?.stop();
  lan = null;
  decoder.reset();
  announcedTo.clear();
  respondedToKeyAnnouncement.clear();
  peerKnownClocks.clear();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  if (syncAttemptTimer) clearTimeout(syncAttemptTimer);
  syncAttemptTimer = null;
  contactsSyncKeyStore.resetMemory();
  statusOwnerId = ownerId;
  observedContactsChangeToken = readContactsChangeToken();
  liveStatus = buildInitialStatus();
  emitStatus();
}

function shortId(deviceId: string): string {
  return deviceId.slice(0, 8);
}

export const __testing = {
  reset(): void {
    disposeContactsDeviceSync();
    statusOwnerId = getActiveAppSession().dataOwnerId;
    observedContactsChangeToken = readContactsChangeToken();
    liveStatus = buildInitialStatus();
    statusListeners.clear();
  },
};
