/**
 * device-link-settings-store —— 跨设备远程控制的 main 端持久化设置。
 *
 * 文件: <userData>/device-link-settings.json
 *
 * 字段:
 *  - remoteControlEnabled: 「允许同账号设备控制本机」全局开关,默认 false(授权语义:
 *    开关打开即授权,同账号设备无需逐次批准;详见 device-link 设计稿)
 *  - revokedControllers: 逐设备访问黑名单(被撤销访问权限的控制端 deviceId 列表)。
 *    全局开着时,名单内的设备单独被挡;持久化,被控端重启 / 离线后仍生效(恢复才解除)。
 *  - disabledControlDeviceIds: 本机不再主动控制的目标设备 deviceId 列表。它只影响本机
 *    控制其它设备的镜像 / 入口,不改变对方的被控授权。
 *  - lastKnownDeviceNames: 本机最后一次看见的有效设备名缓存。relay 离线后 Redis presence
 *    消失,DB 里只有用户手动重命名 name;未重命名设备会回落 unknown/no,这里用于本地补齐展示名。
 *
 * 模式对齐 maker-host/collaboration-settings-store.ts:同步 IO + tmp+rename 原子写 + 内存缓存。
 *
 * 多实例语义:多个实例共享同一 userData 时本文件也是共享的(device-link 单持有者
 * 仲裁场景,见 ./ownership.ts)。缓存按文件 mtime 失效——任何实例写入后,其它实例
 * 下一次 read 会检测到 mtime 变化并从盘上重载,保证被动实例改的授权(允许被控开关 /
 * 撤销控制端)能被持有 relay 连接的实例看到;持有者对变化的响应轮询在 index.ts。
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger';

const log = createLogger('device-link-settings');

export interface DeviceLinkSettings {
  remoteControlEnabled: boolean;
  /**
   * 「保持电脑唤醒」:开启后 main 用 powerSaveBlocker('prevent-app-suspension')
   * 阻止系统休眠(后台 agent 持续运行),但允许显示器熄屏 / 锁屏。默认 false。
   * 本机本地偏好,与被控授权无关。
   */
  keepAwake: boolean;
  /** 被撤销访问权限的控制端 deviceId 列表(逐设备黑名单)。 */
  revokedControllers: string[];
  /** 本机主动关闭控制的目标设备 deviceId 列表(控制端本地偏好)。 */
  disabledControlDeviceIds: string[];
  /** deviceId → last known non-placeholder display name, local-only cache. */
  lastKnownDeviceNames: Record<string, string>;
}

const DEFAULTS: DeviceLinkSettings = {
  remoteControlEnabled: false,
  keepAwake: false,
  revokedControllers: [],
  disabledControlDeviceIds: [],
  lastKnownDeviceNames: {},
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'device-link-settings.json');
}

function normalize(raw: unknown): DeviceLinkSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    remoteControlEnabled: r.remoteControlEnabled === true,
    keepAwake: r.keepAwake === true,
    revokedControllers: Array.isArray(r.revokedControllers)
      ? r.revokedControllers.filter((x): x is string => typeof x === 'string')
      : [],
    disabledControlDeviceIds: normalizeStringList(r.disabledControlDeviceIds),
    lastKnownDeviceNames: normalizeDeviceNameMap(r.lastKnownDeviceNames),
  };
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeDeviceNameMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [deviceId, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name !== 'string') continue;
    const normalizedName = normalizeCachedDeviceName(name);
    if (!deviceId.trim() || !normalizedName) continue;
    out[deviceId] = normalizedName;
  }
  return out;
}

let cached: DeviceLinkSettings | null = null;
/** 缓存对应的文件 mtimeMs;文件不存在时为 null。mtime 变化 → 缓存失效重载(跨实例写入可见)。 */
let cachedMtimeMs: number | null = null;

function statMtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null; // 文件不存在
  }
}

export function readDeviceLinkSettings(): DeviceLinkSettings {
  const file = settingsFilePath();
  const mtimeMs = statMtimeMs(file);
  if (cached && mtimeMs === cachedMtimeMs) return cached;
  try {
    if (mtimeMs !== null) {
      cached = normalize(JSON.parse(fs.readFileSync(file, 'utf-8')));
      cachedMtimeMs = mtimeMs;
      return cached;
    }
  } catch (err) {
    log.warn('device-link-settings.json read failed → falling back to defaults', {
      error: err instanceof Error ? err.message : String(err),
      path: file,
    });
    try { fs.unlinkSync(file); } catch { /* no-op */ }
  }
  cached = { ...DEFAULTS };
  cachedMtimeMs = null;
  return cached;
}

// ── 跨进程写互斥(共享 userData 多实例)────────────────────────────────────────
//
// 写入是整文件替换(read-modify-write):没有互斥时,两个实例读到同一基线后
// 先后 rename,后者会把前者的改动整文件覆盖掉,丢失静默发生。这里用 O_EXCL
// 锁文件做真正的跨进程互斥:锁内完成 read-merge-write-rename(临界区全同步,
// 进程内不可分割)。锁等待是异步 setTimeout(不阻塞主进程 event loop),同进程
// 写者经 writeChain 先排队;持有者崩溃留下的陈旧锁按 mtime 阈值回收。

/**
 * 锁文件 mtime 超过该阈值视为持有者崩溃遗留,直接回收。临界区(一次小 JSON 的
 * read + write + rename)正常是 µs 级,取 10s 意味着只有持有者在单次 fs op 上
 * 停顿超过 10s(机器已处于病态)才可能被误判 —— 阈值刻意远大于任何可信的
 * AV 扫描 / 磁盘抖动 / GC 停顿,以保证"慢但活着的持有者"不会被回收破坏互斥。
 * 代价是崩溃遗留的锁最长挡写 10s:写操作是低频用户动作,可接受。
 */
const LOCK_STALE_MS = 10_000;
/**
 * 锁等待上限。必须 > LOCK_STALE_MS:活着的持有者会在期限内释放,死的会被陈旧
 * 回收 —— 两种情况在本上限内都能拿到锁。仍拿不到(fs 持续报错等病态情况)则
 * **失败抛错**,绝不做无锁写:无锁的整文件写会与真正的持有者互踩,静默丢授权
 * 比显式失败更糟。等待是异步 setTimeout,不阻塞主进程 event loop。
 */
const LOCK_WAIT_MS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** 获取写锁;成功返回释放函数,超时返回 null(调用方失败抛错,不做无锁写) */
async function acquireWriteLock(file: string): Promise<(() => void) | null> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    // 期限判定必须在环顶:open / stat 双双持续抛错(fs mock 不全、EPERM 等病态
    // 情况)时,任何 continue 路径都不能绕过它,否则退化成无限热自旋。
    if (Date.now() >= deadline) return null;
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* no-op:已被陈旧回收也无妨 */
        }
      };
    } catch {
      /* 已被占用或 fs 异常:走下方陈旧检查 + 等待 */
    }
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // 持有者崩溃遗留:回收后立刻重试(多个等待者并发 unlink 也安全,'wx' 保证只有一个建成)
        try {
          fs.unlinkSync(lock);
        } catch {
          /* no-op */
        }
        continue;
      }
    } catch {
      /* 锁刚被释放(下轮直接抢)或 stat 异常(不可热自旋):都小睡后重试 */
    }
    await sleep(25);
  }
}

/** 进程内写序列化:异步 acquire 之间可能交错,同进程写者先排队再抢跨进程锁 */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * 锁内单次写:取盘上最新基线 → 在最新值上跑 updater → 整文件写回。
 * updater 必须在这里(拿到锁 / 每轮重试后)执行,不能由调用方在锁外预计算整值:
 * 数组 / map 类 key 的预计算值基于旧读,锁只能序列化写入顺序,救不回"第二个
 * 写者用旧数组整体覆盖第一个写者刚加进去的元素"。返回本次实际写入的值。
 */
function writeMergedOnce<K extends keyof DeviceLinkSettings>(
  file: string,
  key: K,
  updater: (current: DeviceLinkSettings[K]) => DeviceLinkSettings[K],
  tag: string,
): DeviceLinkSettings[K] {
  // 强制丢缓存取盘上最新基线(mtime 粒度粗时缓存可能骗过 read)
  cached = null;
  cachedMtimeMs = null;
  const current = readDeviceLinkSettings();
  const nextValue = updater(current[key]);
  const next = { ...current, [key]: nextValue };
  const tmp = `${file}.${process.pid}.${tag}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  // 不把 next 记入缓存:rename 与下一次 stat 之间理论上仍可能被替换(锁外读者),
  // 直接失效缓存,下一次 read 从盘上重载。
  cached = null;
  cachedMtimeMs = null;
  return nextValue;
}

/**
 * 以 updater 形式更新某个 key:updater 在写锁内基于盘上最新值执行。
 * 数组 / map 类 key(revokedControllers / disabledControlDeviceIds /
 * lastKnownDeviceNames)的增删改**必须**走本函数,不要在锁外算好整值再
 * writeDeviceLinkSetting(见 writeMergedOnce 注释)。返回最终写入的值。
 */
export function updateDeviceLinkSetting<K extends keyof DeviceLinkSettings>(
  key: K,
  updater: (current: DeviceLinkSettings[K]) => DeviceLinkSettings[K],
): Promise<DeviceLinkSettings[K]> {
  // 同进程写者先排队(异步 acquire 之间会交错),队内再抢跨进程锁
  const task = writeChain.then(async () => {
    const file = settingsFilePath();
    const unlock = await acquireWriteLock(file);
    if (!unlock) {
      // 等待上限内活持有者必已释放、死持有者必已可陈旧回收,走到这里只剩 fs
      // 持续报错等病态情况。显式失败(调用方 IPC 会把错误如实带给 UI),不做
      // 无锁写:无锁整文件写会与真正持有者互踩,静默丢授权比显式失败更糟。
      log.error('device-link settings write lock unavailable, refusing unlocked write', { key });
      throw new Error(`device-link settings write lock unavailable (key=${String(key)})`);
    }
    let written: DeviceLinkSettings[K];
    try {
      // 临界区保持全同步(无 await):进程内不可分割,跨进程由锁保护
      written = writeMergedOnce(file, key, updater, 'locked');
    } finally {
      unlock();
    }
    log.info('device-link setting written', { key, value: written });
    return written;
  });
  writeChain = task.catch(() => undefined); // 队列不因单次失败断链
  return task;
}

/** 整值覆盖写(布尔开关等标量 key 用;数组 / map 增删改请用 updateDeviceLinkSetting) */
export function writeDeviceLinkSetting<K extends keyof DeviceLinkSettings>(
  key: K,
  value: DeviceLinkSettings[K],
): Promise<void> {
  return updateDeviceLinkSetting(key, () => value).then(() => undefined);
}

export function readLastKnownDeviceNames(): Record<string, string> {
  const names = { ...readDeviceLinkSettings().lastKnownDeviceNames };
  for (const [deviceId, pending] of pendingLastKnownDeviceNameByDevice) {
    if (pending.name === null) delete names[deviceId];
    else names[deviceId] = pending.name;
  }
  return names;
}

export function writeLastKnownDeviceNames(names: Record<string, string>): Promise<void> {
  return writeDeviceLinkSetting('lastKnownDeviceNames', { ...names });
}

/** 同一设备的名称判重与写入必须同序，避免旧删除覆盖紧随其后的同名恢复。 */
const lastKnownDeviceNameMutationByDevice = new Map<string, Promise<unknown>>();
/**
 * presence 已生效、但设置文件写入仍在队列/跨实例锁中等待时的同步覆盖层。
 * relay 重连 seed 必须先看到这里的最新意图，不能用旧磁盘快照覆盖当前提示。
 */
const pendingLastKnownDeviceNameByDevice = new Map<
  string,
  { name: string | null }
>();

function enqueueLastKnownDeviceNameMutation<T>(
  deviceId: string,
  pendingName: string | null,
  mutation: () => Promise<T>,
): Promise<T> {
  const pending = { name: pendingName };
  pendingLastKnownDeviceNameByDevice.set(deviceId, pending);
  const previous = lastKnownDeviceNameMutationByDevice.get(deviceId) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(mutation);
  lastKnownDeviceNameMutationByDevice.set(deviceId, task);
  const cleanup = (): void => {
    if (lastKnownDeviceNameMutationByDevice.get(deviceId) === task) {
      lastKnownDeviceNameMutationByDevice.delete(deviceId);
    }
    if (pendingLastKnownDeviceNameByDevice.get(deviceId) === pending) {
      pendingLastKnownDeviceNameByDevice.delete(deviceId);
    }
  };
  void task.then(cleanup, cleanup);
  return task;
}

export async function setDeviceControlEnabled(
  deviceId: string,
  enabled: boolean,
): Promise<string[]> {
  const normalizedDeviceId = deviceId.trim();
  const current = readDeviceLinkSettings().disabledControlDeviceIds;
  if (!normalizedDeviceId) return current;
  // 无变化直接返回(免写盘);有变化走锁内 updater,增删基于盘上最新数组
  const wouldChange = enabled
    ? current.includes(normalizedDeviceId)
    : !current.includes(normalizedDeviceId);
  if (!wouldChange) return current;
  return updateDeviceLinkSetting('disabledControlDeviceIds', (latest) => {
    const exists = latest.includes(normalizedDeviceId);
    if (enabled && exists) return latest.filter((id) => id !== normalizedDeviceId);
    if (!enabled && !exists) return [...latest, normalizedDeviceId];
    return latest;
  });
}

export async function rememberLastKnownDeviceName(deviceId: string, name: string): Promise<boolean> {
  const normalizedName = normalizeCachedDeviceName(name);
  if (!deviceId.trim() || !normalizedName) return false;
  return enqueueLastKnownDeviceNameMutation(deviceId, normalizedName, async () => {
    const settings = readDeviceLinkSettings();
    if (settings.lastKnownDeviceNames[deviceId] === normalizedName) return false;
    try {
      // 锁内基于盘上最新 map 合并单条,避免用旧 map 整体覆盖并发写入的其它条目
      await updateDeviceLinkSetting('lastKnownDeviceNames', (latest) =>
        latest[deviceId] === normalizedName ? latest : { ...latest, [deviceId]: normalizedName },
      );
    } catch (err) {
      log.warn('remember last-known device name failed, continuing without cache update', {
        deviceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return true;
  });
}

export async function forgetLastKnownDeviceName(deviceId: string): Promise<boolean> {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) return false;
  return enqueueLastKnownDeviceNameMutation(normalizedDeviceId, null, async () => {
    let removed = false;
    try {
      await updateDeviceLinkSetting('lastKnownDeviceNames', (latest) => {
        if (!(normalizedDeviceId in latest)) return latest;
        const next = { ...latest };
        delete next[normalizedDeviceId];
        removed = true;
        return next;
      });
    } catch (err) {
      log.warn('forget last-known device name failed, continuing with in-memory fallback', {
        deviceId: normalizedDeviceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    return removed;
  });
}

export function normalizeCachedDeviceName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || isPlaceholderDeviceName(trimmed)) return null;
  return trimmed;
}

export function isPlaceholderDeviceName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'unknown' || normalized === 'no';
}

export const __testing = { normalize };
