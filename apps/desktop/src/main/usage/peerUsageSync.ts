/**
 * peerUsageSync — 用量历史的跨设备拉取与本机缓存 (控制端)。
 *
 * 数据来源:同账号其它电脑经 device-link 的 `maker:usage:device-rows`(见
 * usageDeviceRows.ts)。只能拉到**在线、对方开启远程控制、本机允许控制它**的电脑;
 * 因此每台设备最近一次拿到的原始行按账号落盘缓存,设备离线时仍按上次数据合并,并在
 * 设备列表里带上 syncedAt 让界面标注「数据截至」。
 *
 * 同步节奏:
 *   - 读取多设备范围的用量历史时触发(含本机 turn 结束后的刷新),统一按
 *     SYNC_MIN_INTERVAL_MS 节流;页面不打开就不会读其它设备。
 *   - 增量:已有缓存时从缓存 todayKey 的前一天起拉(对方当天、跨午夜前一天的行仍在变),
 *     返回区间内的行整体替换缓存里同区间的行。
 *   - 并发上限 PEER_FANOUT,与伙伴跨设备目录同口径,不随设备数放大 relay 负载。
 *   - 单台失败只更新该设备状态,不清掉它的缓存,不影响其它设备,也不重试。
 *
 * 缓存只存按天聚合的 token / 金额行,不含会话、消息或任何凭证。
 */

import { compareAppUpdateVersions } from '../updateVersionPolicy.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { createLogger } from '../logger.js';
import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import {
  decodeUsageDeviceRowsResponse,
  isDayKey,
  isUnixMs,
  sanitizeUsageDeviceRows,
  type UsageDeviceRows,
} from './usageDeviceRows.js';

const log = createLogger('peerUsageSync');

const USAGE_DEVICE_ROWS_CHANNEL = MAKER_INVOKE.USAGE_DEVICE_ROWS;
const SYNC_MIN_INTERVAL_MS = 60_000;
const PEER_FANOUT = 3;
// v2:缓存行追加每日 × 任务用量;v1 缓存没有这部分,整份作废后全量重拉。
const CACHE_VERSION = 2;
const MOBILE_PLATFORMS = new Set(['ios', 'android']);

export type UsageDeviceStatus =
  /** 本次或最近一次已成功读取。 */
  | 'ok'
  /** 正在读取。 */
  | 'syncing'
  | 'offline'
  /** 对方未开启远程控制,或本机关闭了对它的控制。 */
  | 'remote-disabled'
  /** 对方版本不支持读取用量。 */
  | 'unsupported'
  | 'error';

export interface UsageDeviceSummary {
  deviceId: string;
  name: string;
  platform: string | null;
  isSelf: boolean;
  /** 最近一次成功读取的时间;本机与从未读到的设备为 null。 */
  syncedAt: number | null;
  status: UsageDeviceStatus;
}

interface CachedPeer {
  name: string;
  platform: string | null;
  syncedAt: number;
  /** 对方读取时的本地 todayKey,作为下一次增量的锚点。 */
  todayKey: string;
  rows: UsageDeviceRows;
}

interface CacheFile {
  version: number;
  peers: Record<string, CachedPeer>;
}

export interface PeerUsageSyncDeps {
  userId(): string | null;
  selfDeviceId(): string | null;
  listDevices(): Promise<{ devices: DeviceLinkDeviceView[] }>;
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
  ): Promise<
    { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }
  >;
  readCache(userId: string): Promise<string | null>;
  writeCache(userId: string, contents: string): Promise<void>;
  now(): number;
}

export interface PeerUsageSnapshot {
  /** 聚合版本:参与聚合的用量行变化时 +1(设备状态 / 目录 / 同步时间不影响)。 */
  version: number;
  selfDeviceId: string | null;
  devices: UsageDeviceSummary[];
  peerRows: ReadonlyMap<string, UsageDeviceRows>;
}

export interface PeerUsageSync {
  /** 读当前已知的设备与缓存行(不发网络请求;首次调用会先读磁盘缓存)。 */
  snapshot(): Promise<PeerUsageSnapshot>;
  /** 节流地触发一次同步;返回本次(或在途)同步的 promise。 */
  sync(): Promise<void>;
  isSyncing(): boolean;
  /** 当前数据版本(同 snapshot().version),同步读取供缓存新鲜度判断。 */
  version(): number;
}

function dayBefore(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, (m ?? 1) - 1, (d ?? 1) - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * 用增量结果替换缓存中 sinceDay(含)之后的行;sinceDay 为 null 时整体替换。
 * 任务元数据不分区间:被控端每次都返回全部任务的当前元数据,整体覆盖缓存;不在其中的
 * 任务(已删除 / 不对远端可见)连同区间外的旧行一起丢弃。
 */
export function mergeIncrementalRows(
  cached: UsageDeviceRows | null,
  sinceDay: string | null,
  incoming: UsageDeviceRows,
): UsageDeviceRows {
  const taskIds = new Set(incoming.tasks.map((task) => task.sessionId));
  const merged =
    !cached || sinceDay === null
      ? incoming
      : {
          spendDays: [
            ...cached.spendDays.filter((row) => row.day < sinceDay),
            ...incoming.spendDays,
          ],
          modelRows: [
            ...cached.modelRows.filter((row) => row.day < sinceDay),
            ...incoming.modelRows,
          ],
          sessionRows: [
            ...cached.sessionRows.filter((row) => row.day < sinceDay),
            ...incoming.sessionRows,
          ],
          tasks: incoming.tasks,
        };
  return {
    ...merged,
    sessionRows: merged.sessionRows.filter((row) => taskIds.has(row.sessionId)),
  };
}

function parseCacheFile(raw: string | null): Record<string, CachedPeer> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (parsed.version !== CACHE_VERSION || !parsed.peers || typeof parsed.peers !== 'object')
      return {};
    const peers: Record<string, CachedPeer> = {};
    for (const [deviceId, value] of Object.entries(parsed.peers)) {
      const peer = value as Partial<CachedPeer> | null;
      if (!peer || typeof peer.name !== 'string' || !isDayKey(peer.todayKey)) continue;
      if (!isUnixMs(peer.syncedAt)) continue;
      const rows = sanitizeUsageDeviceRows(peer.rows);
      if (!rows) continue;
      peers[deviceId] = {
        name: peer.name,
        platform: typeof peer.platform === 'string' ? peer.platform : null,
        syncedAt: peer.syncedAt,
        todayKey: peer.todayKey,
        rows,
      };
    }
    return peers;
  } catch {
    return {};
  }
}

function errorStatus(code: string): UsageDeviceStatus {
  if (
    code === 'CHANNEL_NOT_ALLOWED' ||
    code === 'NO_HANDLER' ||
    code === 'UNSUPPORTED_CAPABILITY'
  ) {
    return 'unsupported';
  }
  if (code === 'DEVICE_OFFLINE' || code === 'PEER_OFFLINE' || code === 'TIMEOUT') return 'offline';
  if (
    code === 'REMOTE_DISABLED' ||
    code === 'CONTROL_TARGET_DISABLED' ||
    code === 'PERMISSION_DENIED' ||
    code === 'ACCESS_REVOKED'
  ) {
    return 'remote-disabled';
  }
  return 'error';
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^\[([A-Z_]+)\]/.exec(message)?.[1] ?? 'REMOTE_UNAVAILABLE';
}

/** 0.1.93 及更早的正式版既没有用量读取通道,也不认后台链路:连它们只会让对方进入受控状态。 */
const LAST_VERSION_WITHOUT_BACKGROUND_READ = '0.1.93';

/**
 * 按设备目录里的版本判断能否后台读取。本地开发构建(0.0.0)无法按版本判断,放行给
 * 建链后的能力确认(remoteBackgroundInvoke)。
 */
export function mayServeBackgroundRead(appVersion: string | null): boolean {
  if (appVersion === '0.0.0') return true;
  return compareAppUpdateVersions(appVersion, LAST_VERSION_WITHOUT_BACKGROUND_READ) === 'newer';
}

export function createPeerUsageSync(deps: PeerUsageSyncDeps): PeerUsageSync {
  let loadedUserId: string | null = null;
  let loadPromise: Promise<void> | null = null;
  let peers: Record<string, CachedPeer> = {};
  /** 最近一次设备目录(含本机);目录读取失败时沿用上次结果。 */
  let directory: DeviceLinkDeviceView[] | null = null;
  const statuses = new Map<string, UsageDeviceStatus>();
  /** 判定为不支持时对方的版本:版本不变就不再建链重试(旧被控端每次建链都会闪一下受控横幅)。 */
  const unsupportedVersions = new Map<string, string | null>();
  let version = 0;
  /**
   * 账号代次:切换账号时 +1。一次同步开始时记下代次,之后对状态 / 缓存 / 目录 / 落盘的
   * 每一次写入都先经 isCurrent 判定 —— 旧账号的在途请求迟到或失败都不能写进新账号的状态。
   */
  let epoch = 0;
  let inflight: Promise<void> | null = null;
  let lastSyncStartedAt = 0;

  /**
   * 聚合版本:只在参与聚合的用量行真的变化时前进(唯一写入点是下面几处对 peers 的修改)。
   * 设备目录、状态、同步时间是展示元数据,由用量历史在每次读取时从快照附上,不影响版本 ——
   * 否则每分钟一次的成功同步都会让全量历史重新聚合。
   */
  const bumpRows = (): void => {
    version += 1;
  };
  const sameRows = (a: UsageDeviceRows | undefined, b: UsageDeviceRows): boolean =>
    a !== undefined && JSON.stringify(a) === JSON.stringify(b);

  const resetForUser = (userId: string | null): void => {
    epoch += 1;
    // 旧账号的在途同步不再代表当前账号:新账号立即发起自己的同步,不等它超时。
    inflight = null;
    loadedUserId = userId;
    loadPromise = null;
    peers = {};
    directory = null;
    statuses.clear();
    unsupportedVersions.clear();
    lastSyncStartedAt = 0;
    bumpRows();
  };

  const ensureLoaded = async (): Promise<string | null> => {
    const userId = deps.userId();
    if (userId !== loadedUserId) resetForUser(userId);
    if (!userId) return null;
    if (!loadPromise) {
      // I4 账号代次同样约束磁盘缓存:读缓存期间账号变了(哪怕还没有调用触发 reset),
      // 旧账号的行不得装进内存。
      const loadEpoch = epoch;
      loadPromise = deps
        .readCache(userId)
        .catch(() => null)
        .then((raw) => {
          if (loadEpoch !== epoch || loadedUserId !== userId || deps.userId() !== userId) return;
          const cached = parseCacheFile(raw);
          peers = { ...cached, ...peers };
          if (Object.keys(cached).length > 0) bumpRows();
        });
    }
    await loadPromise;
    return deps.userId() === userId ? userId : null;
  };

  const persist = async (userId: string, isCurrent: () => boolean): Promise<void> => {
    if (!isCurrent()) return;
    const file: CacheFile = { version: CACHE_VERSION, peers };
    try {
      await deps.writeCache(userId, JSON.stringify(file));
    } catch (err) {
      log.debug('write peer usage cache failed:', err instanceof Error ? err.message : String(err));
    }
  };

  const syncPeer = async (
    device: DeviceLinkDeviceView,
    isCurrent: () => boolean,
  ): Promise<void> => {
    const setStatus = (status: UsageDeviceStatus): void => {
      if (isCurrent()) statuses.set(device.deviceId, status);
    };
    if (!device.online) {
      setStatus('offline');
      return;
    }
    if (!device.remoteControlEnabled || !device.controlEnabled) {
      setStatus('remote-disabled');
      return;
    }
    if (
      !mayServeBackgroundRead(device.appVersion) ||
      (unsupportedVersions.has(device.deviceId) &&
        unsupportedVersions.get(device.deviceId) === device.appVersion)
    ) {
      setStatus('unsupported');
      return;
    }
    const markFailed = (code: string): void => {
      const status = errorStatus(code);
      if (status === 'unsupported' && isCurrent()) {
        unsupportedVersions.set(device.deviceId, device.appVersion);
      }
      setStatus(status);
    };
    const cached = peers[device.deviceId] ?? null;
    const sinceDay = cached ? dayBefore(cached.todayKey) : null;
    setStatus('syncing');
    try {
      const response = await deps.invoke(device.deviceId, USAGE_DEVICE_ROWS_CHANNEL, [
        sinceDay ? { sinceDay } : {},
      ]);
      if (!response.ok) {
        markFailed(errorCodeOf(response.error));
        return;
      }
      const decoded = await decodeUsageDeviceRowsResponse(response.result);
      if (!decoded || decoded.kind === 'oversize') {
        setStatus('error');
        return;
      }
      // 账号在请求期间切换:结果属于旧账号,丢弃。
      if (!isCurrent()) return;
      // 对方回的区间与请求不一致(旧实现忽略参数等)时按全量处理,不能拼出重复行。
      const effectiveSince = decoded.sinceDay === sinceDay ? sinceDay : null;
      const rows = mergeIncrementalRows(cached?.rows ?? null, effectiveSince, decoded.rows);
      const rowsChanged = !sameRows(cached?.rows, rows);
      peers[device.deviceId] = {
        name: device.name,
        platform: device.platform,
        syncedAt: deps.now(),
        todayKey: decoded.todayKey,
        rows,
      };
      if (rowsChanged) bumpRows();
      setStatus('ok');
    } catch (error) {
      markFailed(errorCodeOf(error));
    }
  };

  /** 设备目录读不到:在线状态未知,上次的「ok」不能再代表最新,统一标为读取失败(保留缓存行)。 */
  const markPeersUnreadable = (): void => {
    const selfDeviceId = deps.selfDeviceId();
    const ids = new Set([
      ...(directory ?? [])
        .filter((device) => !device.isSelf && !MOBILE_PLATFORMS.has(device.platform ?? ''))
        .map((device) => device.deviceId),
      ...Object.keys(peers),
    ]);
    for (const deviceId of ids) {
      if (deviceId !== selfDeviceId) statuses.set(deviceId, 'error');
    }
  };

  const runSync = async (): Promise<void> => {
    const userId = await ensureLoaded();
    if (!userId) return;
    const runEpoch = epoch;
    const isCurrent = (): boolean =>
      runEpoch === epoch && loadedUserId === userId && deps.userId() === userId;
    let devices: DeviceLinkDeviceView[];
    try {
      devices = (await deps.listDevices()).devices;
    } catch (err) {
      log.debug(
        'list devices for usage sync failed:',
        err instanceof Error ? err.message : String(err),
      );
      if (isCurrent()) markPeersUnreadable();
      return;
    }
    if (!isCurrent()) return;
    directory = devices;
    // 已从账号移除的设备不再出现在选择器里,缓存一并清掉。
    const known = new Set(devices.map((device) => device.deviceId));
    for (const deviceId of Object.keys(peers)) {
      if (known.has(deviceId)) continue;
      delete peers[deviceId];
      bumpRows();
    }
    const targets = devices.filter(
      (device) => !device.isSelf && !MOBILE_PLATFORMS.has(device.platform ?? ''),
    );
    for (const device of targets) {
      if (
        device.online &&
        device.remoteControlEnabled &&
        device.controlEnabled &&
        mayServeBackgroundRead(device.appVersion)
      ) {
        statuses.set(device.deviceId, 'syncing');
      }
    }
    for (let offset = 0; offset < targets.length; offset += PEER_FANOUT) {
      await Promise.all(
        targets.slice(offset, offset + PEER_FANOUT).map((device) => syncPeer(device, isCurrent)),
      );
    }
    if (!isCurrent()) return;
    await persist(userId, isCurrent);
  };

  const snapshot = async (): Promise<PeerUsageSnapshot> => {
    await ensureLoaded();
    const selfDeviceId = deps.selfDeviceId();
    // 加载期间账号变了:按当前账号重置并返回空快照,不带出旧账号的设备或行。
    if (deps.userId() !== loadedUserId) {
      resetForUser(deps.userId());
      return { version, selfDeviceId, devices: [], peerRows: new Map() };
    }
    const devices: UsageDeviceSummary[] = [];
    const listed = new Set<string>();
    for (const device of directory ?? []) {
      if (MOBILE_PLATFORMS.has(device.platform ?? '')) continue;
      const isSelf = device.isSelf || device.deviceId === selfDeviceId;
      listed.add(device.deviceId);
      devices.push({
        deviceId: device.deviceId,
        name: device.name,
        platform: device.platform,
        isSelf,
        syncedAt: isSelf ? null : (peers[device.deviceId]?.syncedAt ?? null),
        status: isSelf
          ? 'ok'
          : (statuses.get(device.deviceId) ??
            (peers[device.deviceId] ? 'ok' : device.online ? 'syncing' : 'offline')),
      });
    }
    // 目录尚未读到(冷启动 / 未连接)时,缓存里的设备照常参与合并。
    for (const [deviceId, peer] of Object.entries(peers)) {
      if (listed.has(deviceId) || deviceId === selfDeviceId) continue;
      devices.push({
        deviceId,
        name: peer.name,
        platform: peer.platform,
        isSelf: false,
        syncedAt: peer.syncedAt,
        status: statuses.get(deviceId) ?? 'offline',
      });
    }
    const peerRows = new Map<string, UsageDeviceRows>();
    for (const [deviceId, peer] of Object.entries(peers)) {
      if (deviceId !== selfDeviceId) peerRows.set(deviceId, peer.rows);
    }
    return { version, selfDeviceId, devices, peerRows };
  };

  return {
    snapshot,
    sync() {
      const userId = deps.userId();
      // 先按当前账号重置(会丢弃旧账号的在途同步),再判断是否复用在途请求。
      if (userId !== loadedUserId) resetForUser(userId);
      if (inflight) return inflight;
      if (deps.now() - lastSyncStartedAt < SYNC_MIN_INTERVAL_MS) return Promise.resolve();
      lastSyncStartedAt = deps.now();
      const run: Promise<void> = runSync()
        .catch((err) => {
          log.debug('peer usage sync failed:', err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (inflight === run) inflight = null;
        });
      inflight = run;
      return run;
    },
    isSyncing: () => inflight !== null,
    version: () => version,
  };
}

/**
 * 读设备目录与远程读取都先过访问门(生产里是设备互联能力:已登录且不在账号切换中)。
 * 门拒绝时视同目录读取失败 —— 设备标为读取失败、保留缓存,不发请求也不开 peer 链路。
 */
export function withPeerUsageAccessGate(
  assertAllowed: () => void,
  deps: PeerUsageSyncDeps,
): PeerUsageSyncDeps {
  return {
    ...deps,
    listDevices: async () => {
      assertAllowed();
      return deps.listDevices();
    },
    invoke: async (deviceId, channel, args) => {
      assertAllowed();
      return deps.invoke(deviceId, channel, args);
    },
  };
}

let defaultSync: PeerUsageSync | null = null;

export function peerUsageCacheFilePath(userDataDir: string, userId: string): string {
  return path.join(userDataDir, 'cache', `usage-peer-rows.${encodeURIComponent(userId)}.json`);
}

/** 由 maker-ipc/usage.ts 注入生产依赖(device-link、userData 路径);未注入时只看本机。 */
export function configurePeerUsageSync(deps: PeerUsageSyncDeps): void {
  defaultSync = createPeerUsageSync(deps);
}

export function getPeerUsageSync(): PeerUsageSync | null {
  return defaultSync;
}

export async function readPeerUsageCacheFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export async function writePeerUsageCacheFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, contents, 'utf8');
  await fs.rename(tmp, file);
}

export function __resetPeerUsageSyncForTesting(): void {
  defaultSync = null;
}
