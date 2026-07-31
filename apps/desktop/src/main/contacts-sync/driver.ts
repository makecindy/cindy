/**
 * 智能通讯录 Desktop ↔ Desktop 同步驱动。
 *
 * 数据层交换完整、可重复合并的状态；传输层优先同一局域网 TCP，失败自动走
 * Device Link relay。两条路搬运的是同一份逐设备 AES-GCM 密文。整个流程都是
 * 确定性程序逻辑，不调用模型、不产生 token 消耗。
 */

import type { ContactsSyncClock } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import { activeOwnerScopeKey, getActiveAppSession } from '../appSessionState.js';
import { getDesktopContactsManager } from '../maker-host/maker-contacts-host.js';
import {
  commitContactsDeviceSyncSettingIntent,
  readContactsDeviceSyncSettingIntent,
  readContactsSettings,
  writeContactsDeviceSyncSettingIntent,
} from '../maker-host/contacts-settings-store.js';
import {
  onLocalContactsChanged,
  readContactsChangeToken,
} from '../maker-host/contacts-change-events.js';
import { broadcastContactsChanged } from '../maker-host/contacts-change-broadcast.js';
import {
  resolveBetterSqliteModuleEntry,
  resolveBetterSqliteNativeBinding,
} from '../localDb/betterSqliteFactory.js';
import type { ContactsSyncDatabaseSource } from './contactsSyncCodec.js';
import { prepareContactsSyncDatabase } from './contactsSyncCodecWorkerClient.js';
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
  readContactsSyncRequestToken,
  readPersistedContactsSyncStatus,
  readPersistedContactsSyncRuntimeStatus,
  writeContactsSyncRequestToken,
  writePersistedContactsSyncStatus,
  writePersistedContactsSyncRuntimeStatus,
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
const CROSS_PROCESS_STATUS_POLL_MS = 2_000;
const RUNTIME_STATUS_HEARTBEAT_MS = 5_000;
const RUNTIME_STATUS_STALE_MS = 15_000;

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
/** transport 每个实例都会注入；只有仲裁 acquire 后才允许持有 Device Link 能力。 */
let deviceLinkOwnerActive = false;
let lan: LanContactsSyncTransport | null = null;
const decoder = new ContactsSyncWireDecoder();
const peerKnownClocks = new Map<string, ContactsSyncClock[]>();
let debounceTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let syncAttemptTimer: NodeJS.Timeout | null = null;
let crossProcessStatusTimer: NodeJS.Timeout | null = null;
let initialized = false;
let unsubscribeLocalChanges: (() => void) | null = null;
let runtimeGeneration = 0;
let codecAbortController = new AbortController();
let localPreparation:
  | {
      generation: number;
      ownerScopeKey: string;
      promise: Promise<void>;
    }
  | null = null;
const announcedTo = new Map<string, number>();
const respondedToKeyAnnouncement = new Map<string, number>();
const statusListeners = new Set<(status: ContactsDeviceSyncStatus) => void>();
/** 关闭落盘失败时仍保持本进程 fail-closed，直到明确重试成功。 */
const locallyDisabledOwners = new Set<string>();
let liveStatus: ContactsDeviceSyncStatus = emptyContactsDeviceSyncStatus();
/** undefined 强制首次 init/get 按当前 owner 装载，避免模块求值期提前碰 userData。 */
let statusOwnerId: string | null | undefined;
let observedContactsChangeToken: string | null | undefined;
let observedSyncRequestToken: string | null | undefined;
let usingSharedRuntimeStatus = false;
let lastRuntimeStatusWriteAt = 0;
let settingsIntentGeneration = 0;
let recoveringDisableIntentToken: string | null = null;
const activeDisableIntentTokens = new Set<string>();
let activeDisableIntentWrites = 0;
const outbound = new ContactsSyncOutbound({
  getGeneration: () => runtimeGeneration,
  getOwnerId: () => getActiveAppSession().dataOwnerId,
  getTransport: () => transport,
  getDirectTransport: () => lan,
  getCodecAbortSignal: () => codecAbortController.signal,
  isEnabled,
  getIdentity: () => contactsSyncKeyStore.getIdentity(),
  getPeerPublicKey: (deviceId) => contactsSyncKeyStore.getPeerPublicKey(deviceId),
  getDatabaseSource: getContactsSyncDatabaseSource,
  getKnownClocks: (deviceId) => peerKnownClocks.get(deviceId),
  onLocalMaterialized: () => broadcastContactsChanged({ origin: 'remote' }),
  announceKey,
  onError: recordError,
});

export function initContactsDeviceSync(next: ContactsDeviceSyncTransport): void {
  transport = next;
  deviceLinkOwnerActive = false;
  initialized = true;
  ensureCurrentOwnerStatus();
  unsubscribeLocalChanges?.();
  unsubscribeLocalChanges = onLocalContactsChanged(notifyLocalContactsChanged);
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = setInterval(() => {
    if (deviceLinkOwnerActive && isEnabled()) runSyncTask(() => broadcastContactsNow(true));
  }, BROADCAST_INTERVAL_MS);
  intervalTimer.unref?.();
  pollContactsDeviceSyncCrossProcessState();
}

/** Device Link 多实例仲裁的权威持有态；transport 是否存在不能用于判定 ownership。 */
export function setContactsDeviceLinkOwnerActive(active: boolean): void {
  ensureCurrentOwnerStatus();
  if (deviceLinkOwnerActive === active) return;
  deviceLinkOwnerActive = active;
  if (!active) {
    stopContactsDeviceSyncRuntime();
    pollContactsDeviceSyncCrossProcessState();
    return;
  }

  usingSharedRuntimeStatus = false;
  liveStatus = buildInitialStatus();
  refreshOnlineCount(false);
  emitStatus();
  if (isEnabled()) {
    prepareAndRun(() => {
      startLan();
      setPhase(onlinePeers().length > 0 ? 'syncing' : 'waiting');
      runSyncTask(() => broadcastContactsNow(true));
    });
  }
}

export function stopContactsDeviceSyncRuntime(): void {
  runtimeGeneration += 1;
  codecAbortController.abort();
  codecAbortController = new AbortController();
  localPreparation = null;
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
  deviceLinkOwnerActive = false;
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
  startCrossProcessStatusPolling();
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size === 0 && crossProcessStatusTimer) {
      clearInterval(crossProcessStatusTimer);
      crossProcessStatusTimer = null;
    }
  };
}

export function getContactsDeviceSyncStatus(): ContactsDeviceSyncStatus {
  ensureCurrentOwnerStatus();
  pollContactsDeviceSyncCrossProcessState();
  if (deviceLinkOwnerActive) refreshOnlineCount(false);
  return { ...liveStatus };
}

export async function setContactsDeviceSyncEnabled(enabled: boolean): Promise<void> {
  ensureCurrentOwnerStatus();
  const intentGeneration = ++settingsIntentGeneration;
  const ownerId = getActiveAppSession().dataOwnerId;
  const ownerScopeKey = activeOwnerScopeKey();
  if (enabled && !isCloudSession()) {
    throw new Error('contacts device sync requires a signed-in cloud account');
  }
  if (!enabled) {
    // “关闭”是隐私意图：先让当前进程立即停传，再等待任何跨进程落盘。
    if (ownerId) locallyDisabledOwners.add(ownerId);
    liveStatus = { ...liveStatus, enabled: false, errorCode: null };
    stopContactsDeviceSyncRuntime();
    setPhase('off');
    activeDisableIntentWrites += 1;
  }
  let persistedIntent: Awaited<ReturnType<typeof writeContactsDeviceSyncSettingIntent>>;
  try {
    persistedIntent = await writeContactsDeviceSyncSettingIntent(enabled);
  } catch (error) {
    if (!enabled) activeDisableIntentWrites = Math.max(0, activeDisableIntentWrites - 1);
    if (settingsIntentGeneration === intentGeneration && activeOwnerScopeKey() === ownerScopeKey) {
      recordError(error);
    }
    throw error;
  }
  if (!enabled) {
    activeDisableIntentWrites = Math.max(0, activeDisableIntentWrites - 1);
    activeDisableIntentTokens.add(persistedIntent.token);
  }
  const intentIsCurrent = () => {
    if (settingsIntentGeneration !== intentGeneration || activeOwnerScopeKey() !== ownerScopeKey) {
      return false;
    }
    const current = readContactsDeviceSyncSettingIntent();
    // 关闭是隐私方向：意图文件读坏/瞬时不可读时仍继续 durable false；只有读到一个
    // 明确的后发意图才让路。开启则必须精确匹配 token，任何异常都 fail closed。
    return sameSettingIntent(current, persistedIntent) || (!enabled && current === null);
  };
  if (!intentIsCurrent()) {
    activeDisableIntentTokens.delete(persistedIntent.token);
    reconcileSupersededDisable(enabled, ownerId, ownerScopeKey);
    return;
  }
  if (enabled) {
    // await intent 期间本实例也可能被另一进程的 disable 轮询停掉；即使调用开始时
    // 已开启，也要重新 prepare，不能拿旧快照跳过密钥缓存恢复。
    try {
      await prepareLocalSync();
    } catch (error) {
      if (!intentIsCurrent()) return;
      recordError(error);
      throw error;
    }
    if (!intentIsCurrent()) return;
    if (!(await commitContactsDeviceSyncSettingIntent(persistedIntent))) return;
    if (!intentIsCurrent()) return;
    if (ownerId) locallyDisabledOwners.delete(ownerId);
    if (activeOwnerScopeKey() !== ownerScopeKey) {
      ensureCurrentOwnerStatus();
      return;
    }
    liveStatus = { ...liveStatus, enabled: true, errorCode: null };
    startLan();
    setPhase(onlinePeers().length > 0 ? 'syncing' : 'waiting');
    await broadcastContactsNow(true);
    return;
  }
  // 落盘失败时保留本进程的关闭抑制，不能由轮询读到旧的 true 后偷偷重启。
  try {
    if (!(await commitContactsDeviceSyncSettingIntent(persistedIntent))) {
      activeDisableIntentTokens.delete(persistedIntent.token);
      reconcileSupersededDisable(enabled, ownerId, ownerScopeKey);
      return;
    }
    activeDisableIntentTokens.delete(persistedIntent.token);
    if (ownerId) locallyDisabledOwners.delete(ownerId);
    if (activeOwnerScopeKey() !== ownerScopeKey) ensureCurrentOwnerStatus();
  } catch (error) {
    activeDisableIntentTokens.delete(persistedIntent.token);
    reconcileSupersededDisable(enabled, ownerId, ownerScopeKey);
    if (settingsIntentGeneration === intentGeneration && activeOwnerScopeKey() === ownerScopeKey) {
      recordError(error);
    } else {
      log.warn('contacts device sync setting write failed after owner changed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

function reconcileSupersededDisable(
  enabled: boolean,
  ownerId: string | null,
  ownerScopeKey: string,
): void {
  if (enabled || !ownerId || activeOwnerScopeKey() !== ownerScopeKey) return;
  const latestIntent = readContactsDeviceSyncSettingIntent();
  if (latestIntent?.enabled !== true) return;
  locallyDisabledOwners.delete(ownerId);
  pollContactsDeviceSyncSettingChange();
}

function sameSettingIntent(
  current: ReturnType<typeof readContactsDeviceSyncSettingIntent>,
  expected: Awaited<ReturnType<typeof writeContactsDeviceSyncSettingIntent>>,
): boolean {
  return current?.token === expected.token && current.enabled === expected.enabled;
}

/** Device Link 持有者定期调用，应用其它共享 userData 实例写入的同步开关。 */
export function pollContactsDeviceSyncSettingChange(): void {
  ensureCurrentOwnerStatus();
  const ownerId = getActiveAppSession().dataOwnerId;
  const configuredEnabled = isConfiguredEnabled();
  recoverPendingDisableIntent(configuredEnabled);
  if (!configuredEnabled && ownerId) locallyDisabledOwners.delete(ownerId);
  const enabled = isEnabled();
  if (enabled === liveStatus.enabled) {
    if (
      !enabled &&
      !configuredEnabled &&
      (liveStatus.phase !== 'off' || liveStatus.errorCode !== null)
    ) {
      liveStatus = { ...liveStatus, enabled: false, errorCode: null };
      stopContactsDeviceSyncRuntime();
      setPhase('off');
    }
    return;
  }
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

function recoverPendingDisableIntent(configuredEnabled: boolean): void {
  const intent = readContactsDeviceSyncSettingIntent();
  if (
    !configuredEnabled ||
    intent?.enabled !== false ||
    activeDisableIntentWrites > 0 ||
    activeDisableIntentTokens.has(intent.token) ||
    recoveringDisableIntentToken === intent.token
  ) {
    return;
  }
  recoveringDisableIntentToken = intent.token;
  runSyncTask(async () => {
    try {
      await commitContactsDeviceSyncSettingIntent(intent);
    } finally {
      if (recoveringDisableIntentToken === intent.token) recoveringDisableIntentToken = null;
    }
    pollContactsDeviceSyncSettingChange();
  });
}

export async function broadcastContactsNow(requestReply = true): Promise<void> {
  ensureCurrentOwnerStatus();
  if (!isEnabled()) return;
  if (!deviceLinkOwnerActive || !transport) {
    // 被动实例没有 Device Link；用无内容 token 委托同 userData 的持有者执行。
    writeContactsSyncRequestToken();
    setPhase('syncing');
    scheduleSyncAttemptTimeout();
    return;
  }
  await prepareLocalSync();
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
  // DB-bound encode 有意串行：N 台在线设备不应把正常 fan-out 塞爆全局 worker 队列。
  for (const peer of peers) {
    if (!outbound.isCurrent(context)) break;
    await outbound.ensureKeyThenSend(peer.deviceId, requestReply, context);
  }
  if (outbound.isCurrent(context)) scheduleSyncAttemptTimeout();
}

export function handleContactsDeviceLinkStatusChanged(online: boolean): void {
  if (!deviceLinkOwnerActive) return;
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

/**
 * 同机多实例桥：持有者发布无内容运行态并消费“立即同步” token；被动实例读取
 * 持有者状态供本进程窗口展示。由常驻状态订阅定期调用，也可由 Device Link tick 调用。
 */
export function pollContactsDeviceSyncCrossProcessState(): void {
  ensureCurrentOwnerStatus();
  if (deviceLinkOwnerActive && transport) {
    const requestToken = readContactsSyncRequestToken();
    if (observedSyncRequestToken === undefined) {
      observedSyncRequestToken = requestToken;
    } else if (requestToken !== observedSyncRequestToken) {
      observedSyncRequestToken = requestToken;
      if (requestToken && isEnabled() && initialized) {
        runSyncTask(() => broadcastContactsNow(true));
      }
    }
    publishRuntimeStatus(false);
    return;
  }

  const shared = readPersistedContactsSyncRuntimeStatus();
  const sharedAge = shared ? Date.now() - shared.updatedAt : Number.POSITIVE_INFINITY;
  const fresh =
    shared && sharedAge >= -RUNTIME_STATUS_STALE_MS && sharedAge <= RUNTIME_STATUS_STALE_MS;
  if (fresh && shared.enabled === isEnabled() && shared.available === isCloudSession()) {
    // 持有者已经接管状态机后，本地 delegated-request 超时不得再覆盖真实 syncing。
    if (syncAttemptTimer) clearTimeout(syncAttemptTimer);
    syncAttemptTimer = null;
    const nextStatus: ContactsDeviceSyncStatus = {
      available: shared.available,
      enabled: shared.enabled,
      phase: shared.phase,
      onlineDeviceCount: shared.onlineDeviceCount,
      errorCode: shared.errorCode,
      lastSyncAt: shared.lastSyncAt,
      lastSyncDeviceId: shared.lastSyncDeviceId,
      lastSyncDeviceName: shared.lastSyncDeviceName,
      lastRoute: shared.lastRoute,
    };
    if (!sameStatus(liveStatus, nextStatus)) {
      liveStatus = nextStatus;
      usingSharedRuntimeStatus = true;
      emitStatus();
    } else {
      usingSharedRuntimeStatus = true;
    }
    return;
  }
  if (usingSharedRuntimeStatus || liveStatus.enabled !== isEnabled()) {
    usingSharedRuntimeStatus = false;
    liveStatus = buildInitialStatus();
    emitStatus();
  }
}

export function handleContactsPeerPresenceChanged(peer: {
  deviceId: string;
  online: boolean;
}): void {
  if (!deviceLinkOwnerActive) return;
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
  if (
    !deviceLinkOwnerActive ||
    !isEnabled() ||
    !transport?.isPeerAllowed(srcDeviceId) ||
    !isContactsSyncWireFrame(raw)
  ) {
    return;
  }
  if (raw.type === 'key') {
    prepareAndRun(async (isCurrent) => {
      const firstSeen = await contactsSyncKeyStore.pinPeerPublicKey(srcDeviceId, raw.publicKey);
      if (!isCurrent() || !deviceLinkOwnerActive || !transport?.isPeerAllowed(srcDeviceId)) return;
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
  if (!deviceLinkOwnerActive || !isEnabled() || !transport?.isPeerAllowed(srcDeviceId)) return;
  prepareAndRun(async (isCurrent) => {
    const selfDeviceId = requireSelfDeviceId();
    const identity = contactsSyncKeyStore.getIdentity();
    const peerKey = contactsSyncKeyStore.getPeerPublicKey(srcDeviceId);
    if (!peerKey) {
      announceKey(srcDeviceId);
      return;
    }
    const message = await decoder.accept({
      srcDeviceId,
      dstDeviceId: selfDeviceId,
      frame,
      ownPrivateKey: identity.privateKey,
      expectedPeerPublicKey: peerKey,
      databaseSource: getContactsSyncDatabaseSource(),
    });
    if (!message || !isCurrent()) return;
    if (message.type !== 'applied-state') {
      throw new Error('contacts sync worker did not apply the decoded state');
    }

    peerKnownClocks.set(
      srcDeviceId,
      message.clocks.map((clock) => ({ ...clock })),
    );
    recordSuccessfulSync(srcDeviceId, route);
    if (message.changed) {
      broadcastContactsChanged({ origin: 'remote' });
      log.info(`merged contacts state from ${shortId(srcDeviceId)} via ${route}`);
    }
    if (message.changed || message.requestReply === true) {
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

function prepareLocalSync(): Promise<void> {
  if (!isCloudSession()) {
    return Promise.reject(new Error('contacts device sync requires a signed-in cloud account'));
  }
  const generation = runtimeGeneration;
  const ownerScopeKey = activeOwnerScopeKey();
  if (
    localPreparation?.generation === generation &&
    localPreparation.ownerScopeKey === ownerScopeKey
  ) {
    return localPreparation.promise;
  }

  const promise = (async () => {
    await contactsSyncKeyStore.prepare();
    const result = await prepareContactsSyncDatabase(
      getContactsSyncDatabaseSource(),
      codecAbortController.signal,
    );
    if (
      result.materialized &&
      runtimeGeneration === generation &&
      activeOwnerScopeKey() === ownerScopeKey
    ) {
      broadcastContactsChanged({ origin: 'remote' });
    }
  })();
  const preparation = { generation, ownerScopeKey, promise };
  localPreparation = preparation;
  void promise.catch(() => {
    if (localPreparation === preparation) localPreparation = null;
  });
  return promise;
}

let contactsSyncDatabaseRuntime:
  | Pick<ContactsSyncDatabaseSource, 'betterSqliteModulePath' | 'nativeBinding'>
  | undefined;

function getContactsSyncDatabaseSource(): ContactsSyncDatabaseSource {
  contactsSyncDatabaseRuntime ??= {
    betterSqliteModulePath: resolveBetterSqliteModuleEntry(),
    nativeBinding: resolveBetterSqliteNativeBinding(),
  };
  return {
    dbPath: getDesktopContactsManager().getDbPath(),
    ...contactsSyncDatabaseRuntime,
  };
}

function startLan(): void {
  if (!deviceLinkOwnerActive || !transport || lan || !isEnabled()) return;
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

function prepareAndRun(action: (isCurrent: () => boolean) => void | Promise<void>): void {
  const generation = runtimeGeneration;
  const ownerScopeKey = activeOwnerScopeKey();
  const isCurrent = () =>
    runtimeGeneration === generation && activeOwnerScopeKey() === ownerScopeKey && isEnabled();
  void (async () => {
    await prepareLocalSync();
    if (!isCurrent()) return;
    startLan();
    await action(isCurrent);
  })().catch((error) => {
    if (runtimeGeneration === generation && activeOwnerScopeKey() === ownerScopeKey) {
      recordError(error);
    }
  });
}

function runSyncTask(task: () => Promise<void>): void {
  const generation = runtimeGeneration;
  const ownerScopeKey = activeOwnerScopeKey();
  void task().catch((error) => {
    if (runtimeGeneration === generation && activeOwnerScopeKey() === ownerScopeKey) {
      recordError(error);
    }
  });
}

function onlinePeers(): ContactsSyncPeer[] {
  if (!deviceLinkOwnerActive) return [];
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
  const databaseMayHaveChanged =
    typeof error === 'object' &&
    error !== null &&
    'contactsDatabaseMayHaveChanged' in error &&
    error.contactsDatabaseMayHaveChanged === true;
  if (databaseMayHaveChanged) {
    // 原子事务可能已提交但 ACK 尚未返回；保守刷新覆盖这个窄窗口。
    localPreparation = null;
    broadcastContactsChanged({ origin: 'remote' });
    if (deviceLinkOwnerActive && isEnabled() && !debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        prepareAndRun(() => broadcastContactsNow(true));
      }, BROADCAST_DEBOUNCE_MS);
      debounceTimer.unref?.();
    }
  }
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
  const enabled = isEnabled();
  return {
    available: true,
    enabled,
    phase: enabled ? 'waiting' : 'off',
    onlineDeviceCount: 0,
    errorCode: null,
    ...readPersistedContactsSyncStatus(),
  };
}

function isEnabled(): boolean {
  const session = getActiveAppSession();
  const ownerId = session.dataOwnerId;
  return (
    session.mode === 'cloud' &&
    ownerId !== null &&
    !locallyDisabledOwners.has(ownerId) &&
    readContactsDeviceSyncSettingIntent()?.enabled !== false &&
    readContactsSettings().deviceSyncEnabled
  );
}

function isConfiguredEnabled(): boolean {
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
  publishRuntimeStatus(true);
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

function publishRuntimeStatus(force: boolean): void {
  if (!deviceLinkOwnerActive || !transport || !isCloudSession()) return;
  const now = Date.now();
  if (!force && now - lastRuntimeStatusWriteAt < RUNTIME_STATUS_HEARTBEAT_MS) return;
  try {
    writePersistedContactsSyncRuntimeStatus({ ...liveStatus, updatedAt: now });
    lastRuntimeStatusWriteAt = now;
  } catch (error) {
    log.warn('contacts sync runtime status persistence failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function startCrossProcessStatusPolling(): void {
  if (crossProcessStatusTimer) return;
  pollContactsDeviceSyncCrossProcessState();
  crossProcessStatusTimer = setInterval(
    pollContactsDeviceSyncCrossProcessState,
    CROSS_PROCESS_STATUS_POLL_MS,
  );
  crossProcessStatusTimer.unref?.();
}

function sameStatus(a: ContactsDeviceSyncStatus, b: ContactsDeviceSyncStatus): boolean {
  return (
    a.available === b.available &&
    a.enabled === b.enabled &&
    a.phase === b.phase &&
    a.onlineDeviceCount === b.onlineDeviceCount &&
    a.errorCode === b.errorCode &&
    a.lastSyncAt === b.lastSyncAt &&
    a.lastSyncDeviceId === b.lastSyncDeviceId &&
    a.lastSyncDeviceName === b.lastSyncDeviceName &&
    a.lastRoute === b.lastRoute
  );
}

function ensureCurrentOwnerStatus(): void {
  const ownerId = getActiveAppSession().dataOwnerId;
  if (ownerId === statusOwnerId) return;
  settingsIntentGeneration += 1;
  runtimeGeneration += 1;
  codecAbortController.abort();
  codecAbortController = new AbortController();
  localPreparation = null;
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
  observedSyncRequestToken = readContactsSyncRequestToken();
  usingSharedRuntimeStatus = false;
  lastRuntimeStatusWriteAt = 0;
  recoveringDisableIntentToken = null;
  activeDisableIntentTokens.clear();
  activeDisableIntentWrites = 0;
  liveStatus = buildInitialStatus();
  emitStatus();
}

function shortId(deviceId: string): string {
  return deviceId.slice(0, 8);
}

export const __testing = {
  reset(): void {
    disposeContactsDeviceSync();
    if (crossProcessStatusTimer) clearInterval(crossProcessStatusTimer);
    crossProcessStatusTimer = null;
    deviceLinkOwnerActive = false;
    locallyDisabledOwners.clear();
    statusOwnerId = getActiveAppSession().dataOwnerId;
    observedContactsChangeToken = readContactsChangeToken();
    observedSyncRequestToken = readContactsSyncRequestToken();
    usingSharedRuntimeStatus = false;
    lastRuntimeStatusWriteAt = 0;
    settingsIntentGeneration += 1;
    recoveringDisableIntentToken = null;
    activeDisableIntentTokens.clear();
    activeDisableIntentWrites = 0;
    liveStatus = buildInitialStatus();
    statusListeners.clear();
  },
};
