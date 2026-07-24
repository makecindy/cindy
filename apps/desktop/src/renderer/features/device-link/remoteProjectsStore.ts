/**
 * remoteProjectsStore —— 控制端「远程项目」内存层(device-link 跨设备远程控制)。
 * ---------------------------------------------------------------------------
 * 设计目标:把被控设备的会话作为**额外项目**融入本地侧边栏,长得跟本机项目一样,
 * 只在标题旁多一个设备 icon。
 *
 * 关键原则(被控端 = 单一真相源,控制端 = 纯镜像):
 *  - **控制端零权威状态**:远端会话只活在这里的内存里,永不写本地 SQLite(被控端
 *    DB 才是数据真相)。断链 / 设备下线时保留最近一次快照并标成 disconnected,
 *    让 All Sessions 稳定;明确撤销 / 关闭控制 / 删除才移除。**不做任何乐观预测 / 本地覆盖**——
 *    视图 = f(bootstrap snapshot + 被控端 push 流):
 *      · snapshot(`setDeviceSessions`):listing tier 订阅后拉一次有界列表 / reconnect 重拉。
 *      · anti-entropy(`mergeDeviceSessions`):周期满窗口列表先更新命中行并保留窗口外会话，
 *        再由 refresh 层有界补查缺席 id 的终态；未满窗口则可直接安全替换。
 *      · 增量(`applyPatch`):收到被控端 `local-db:sessions:patched` push 时就地幂等合并;
 *        status=deleted/archived → 移出分片;落到未知 session → 丢弃(后续 snapshot 带最终态)。
 *      · 新建(`requestRemoteReseed`):`sessions:created` push 无 row 数据 → 触发该设备重拉。
 *  - **复用本地渲染管线**:每条 session 注入 `deviceLinkDeviceId/Name/ConnectionStatus`
 *    后喂给 `groupSessions`。
 *  - **origin 注册表**:`sessionId → deviceId`(`getSessionDeviceId`),供传输层 / SessionView 用。
 *
 * 模块级 vanilla store + useSyncExternalStore;`getMergedRemoteSessions()` 返回缓存引用,
 * 仅在分片真正变化时才换新数组(满足 getSnapshot 引用稳定性,否则无限重渲染)。
 */

import { useSyncExternalStore } from 'react';
import type { DeviceLinkConnectionStatus, Session } from '@/lib/ccAgent.types';

/** 单台被控设备的内存分片。 */
interface DeviceShard {
  deviceId: string;
  deviceName: string;
  connectionStatus: DeviceLinkConnectionStatus;
  /** 已打 device-link origin 标记的远端会话(可直接进 groupSessions)。 */
  sessions: Session[];
}

const shards = new Map<string, DeviceShard>();
const subs = new Set<() => void>();
/**
 * 设备改名通知订阅(deviceId → 新名)。设备名走 REST PATCH(Device.name,不进 sessions 表),
 * 服务端不广播 presence;listing tier 把设备名缓存在自己的 eligible 表,改名时同步通知接入器
 * 对齐缓存名,避免下一轮拉取用旧名回填。这与「会话真相」无关,是设备元数据的即时性补丁。
 */
const renameSubs = new Set<(deviceId: string, name: string) => void>();

/**
 * snapshot epoch(per-device):防「旧 snapshot 覆盖新 snapshot」。listing tier 发起一次
 * 全量拉取前 `nextSnapshotEpoch(deviceId)`,await 回来后只有 `isLatestSnapshotEpoch` 仍成立
 * 才 setDeviceSessions —— 两次重拉乱序 resolve 时,旧的那次结果被丢弃。
 *
 * **单调不复用(ABA 防护)**:每设备 epoch 只增不减、失效时**自增**而非 delete/clear-to-0。
 * 若移除/断连时把 epoch 删掉(归零),下次 bootstrap 又从 1 开始 —— 断连前在途的 epoch=1 响应会与
 * reconnect 后新一轮的 epoch=1 撞值,旧响应通过 isLatestSnapshotEpoch 盖回新 snapshot(ABA)。
 * 故 mark disconnected / remove / clear 都用自增(条目保留,仅随 distinct 设备数增长,可忽略)。
 */
const snapshotEpoch = new Map<string, number>();

/**
 * 重拉实现注入点:listing tier(useDeviceLinkRemoteProjects)挂载时注册一个「(防抖)重拉该
 * 设备会话列表」的实现,卸载时清。`requestRemoteReseed` 供 push 消费侧(makerChatStore 的
 * sessions:created 路由、applyPatch 的 unarchive 兜底)调用,不直接依赖 hook。
 */
let reseedImpl: ((deviceId: string) => void) | null = null;

/** 扁平合并快照(缓存引用,变化时才换新)。 */
let mergedSnapshot: Session[] = [];
/** sessionId → deviceId 注册表(随分片变化重建)。 */
const sessionDeviceIndex = new Map<string, string>();

const EMPTY: Session[] = [];

/** 单台被控设备在「机器切换栏」里的摘要(deviceId + 友好名 + 会话数)。 */
export interface RemoteDeviceSummary {
  deviceId: string;
  deviceName: string;
  sessionCount: number;
  /** true = 当前在线可控;false = 仅保留最近一次会话快照,用于断线时稳定侧边栏。 */
  connected: boolean;
}

/** 设备列表快照(缓存引用,内容不变时不换引用 → 满足 useSyncExternalStore getSnapshot 引用稳定性)。 */
let deviceListSnapshot: RemoteDeviceSummary[] = [];
const EMPTY_DEVICES: RemoteDeviceSummary[] = [];

/** 设备列表结构相等(顺序敏感):用于 deviceListSnapshot 引用稳定性判定。 */
function sameDeviceList(a: RemoteDeviceSummary[], b: RemoteDeviceSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].deviceId !== b[i].deviceId ||
      a[i].deviceName !== b[i].deviceName ||
      a[i].sessionCount !== b[i].sessionCount ||
      a[i].connected !== b[i].connected
    ) {
      return false;
    }
  }
  return true;
}

/** 重算扁平快照 + origin 注册表,然后通知订阅者。所有 mutation 走这里。 */
function recompute(): void {
  sessionDeviceIndex.clear();
  if (shards.size === 0) {
    mergedSnapshot = EMPTY;
  } else {
    const flat: Session[] = [];
    for (const shard of shards.values()) {
      for (const s of shard.sessions) {
        flat.push(s);
        sessionDeviceIndex.set(s.id, shard.deviceId);
      }
    }
    mergedSnapshot = flat;
  }
  // 设备列表快照:按 deviceName(再 deviceId 兜底)稳定排序,避免 Map 插入序在设备增删时
  // 抖动导致切换栏 chip 乱跳;内容不变时保持旧引用(防 useRemoteDevices 无谓重渲染)。
  if (shards.size === 0) {
    if (deviceListSnapshot.length !== 0) deviceListSnapshot = EMPTY_DEVICES;
  } else {
    const nextDevices: RemoteDeviceSummary[] = [...shards.values()]
      .map((shard) => ({
        deviceId: shard.deviceId,
        deviceName: shard.deviceName,
        sessionCount: shard.sessions.length,
        connected: shard.connectionStatus === 'connected',
      }))
      .sort(
        (a, b) => a.deviceName.localeCompare(b.deviceName) || a.deviceId.localeCompare(b.deviceId),
      );
    if (!sameDeviceList(deviceListSnapshot, nextDevices)) deviceListSnapshot = nextDevices;
  }
  subs.forEach((fn) => fn());
}

/** 给一条远端会话打上 device-link origin 标记(供 groupSessions + 传输层识别)。 */
function stamp(
  session: Session,
  deviceId: string,
  deviceName: string,
  connectionStatus: DeviceLinkConnectionStatus,
): Session {
  return {
    ...session,
    deviceLinkDeviceId: deviceId,
    deviceLinkDeviceName: deviceName,
    deviceLinkConnectionStatus: connectionStatus,
  };
}

const actions = {
  /**
   * 写入 / 覆盖某台设备的整份会话列表(bootstrap 订阅后拉一次 / reconnect 重拉 / reseed)。
   * rawSessions 是被控端 local-db:sessions:list 原样返回的 Session[],本函数负责打标记。
   * 逐字节不变时跳过(避免无谓重渲染);epoch 乱序保护在调用方(listing tier)用
   * nextSnapshotEpoch/isLatestSnapshotEpoch 完成,本函数无条件替换。
   */
  setDeviceSessions(deviceId: string, deviceName: string, rawSessions: readonly Session[]): void {
    const connectionStatus: DeviceLinkConnectionStatus = 'connected';
    const stamped = rawSessions.map((s) => stamp(s, deviceId, deviceName, connectionStatus));
    const existing = shards.get(deviceId);
    if (
      existing &&
      existing.connectionStatus === connectionStatus &&
      JSON.stringify(existing.sessions) === JSON.stringify(stamped)
    ) {
      // 内容不变但设备名可能变了(改名走 renameDevice,不经这里);保持引用不动。
      return;
    }
    shards.set(deviceId, { deviceId, deviceName, connectionStatus, sessions: stamped });
    recompute();
  },

  /**
   * 合并一份有界会话快照。周期 anti-entropy 只拿最近 LIST_LIMIT 条 + 旧置顶，响应缺席
   * 不能证明窗口外会话已归档/删除；因此命中行用权威值替换，未命中行先保留，再由 refresh
   * 层有界补查终态。首次无分片时等价于 setDeviceSessions。
   */
  mergeDeviceSessions(deviceId: string, deviceName: string, rawSessions: readonly Session[]): void {
    const existing = shards.get(deviceId);
    if (!existing) {
      actions.setDeviceSessions(deviceId, deviceName, rawSessions);
      return;
    }
    const incomingIds = new Set(rawSessions.map((session) => session.id));
    actions.setDeviceSessions(deviceId, deviceName, [
      ...rawSessions,
      ...existing.sessions.filter((session) => !incomingIds.has(session.id)),
    ]);
  },

  /**
   * 应用一条被控端 `local-db:sessions:patched` 增量(push 驱动镜像核心)。幂等:
   *  - status ∈ {deleted, archived} → 从分片移除该会话(active 视图不含)。
   *  - 其它字段(title/pinnedAt/model/effort/...)→ 就地合并。
   *  - 落到未知 session:若 status=active(unarchive 应重新出现)→ 触发 reseed 拉回;否则丢弃
   *    (后续 snapshot 自带最终态;对不在 active 视图的会话的改动控制端不关心)。
   */
  applyPatch(deviceId: string, sessionId: string, patch: Record<string, unknown>): void {
    const shard = shards.get(deviceId);
    if (!shard) return;
    const idx = shard.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) {
      if (patch.status === 'active') requestRemoteReseed(deviceId);
      return;
    }
    const status = patch.status;
    if (status === 'deleted' || status === 'archived') {
      shard.sessions = shard.sessions.filter((s) => s.id !== sessionId);
      recompute();
      return;
    }
    const wasPinned = shard.sessions[idx]?.pinnedAt != null;
    const unpinned =
      Object.prototype.hasOwnProperty.call(patch, 'pinnedAt') && patch.pinnedAt == null;
    shard.sessions = shard.sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            ...(patch as Partial<Session>),
            deviceLinkDeviceId: shard.deviceId,
            deviceLinkDeviceName: shard.deviceName,
            deviceLinkConnectionStatus: shard.connectionStatus,
          }
        : s,
    );
    recompute();
    if (wasPinned && unpinned) requestRemoteReseed(deviceId);
  },

  /**
   * 设备改名:即时把新名落到该设备分片 + 通知接入器对齐缓存名。设备未并入侧边栏时仅通知。
   * 由设置页 rename 成功后调用(设备名是 Device 元数据,非会话真相)。
   */
  renameDevice(deviceId: string, name: string): void {
    const shard = shards.get(deviceId);
    if (shard && shard.deviceName !== name) {
      shard.deviceName = name;
      shard.sessions = shard.sessions.map((s) => ({
        ...s,
        deviceLinkDeviceName: name,
        deviceLinkConnectionStatus: shard.connectionStatus,
      }));
      recompute();
    }
    renameSubs.forEach((fn) => fn(deviceId, name));
  },

  /**
   * 标记某台设备暂不可达,但保留最近一次会话快照。用于 presence offline / relay
   * connecting 等瞬态断线,避免 All Sessions 因网络抖动反复增删远程会话。
   */
  markDeviceDisconnected(deviceId: string): void {
    snapshotEpoch.set(deviceId, (snapshotEpoch.get(deviceId) ?? 0) + 1);
    const shard = shards.get(deviceId);
    if (!shard || shard.connectionStatus === 'disconnected') return;
    shard.connectionStatus = 'disconnected';
    shard.sessions = shard.sessions.map((s) => ({
      ...s,
      deviceLinkConnectionStatus: 'disconnected',
    }));
    recompute();
  },

  /** 标记全部已缓存远程设备暂不可达,但不清空侧边栏会话快照。 */
  markAllDisconnected(): void {
    for (const [k, v] of snapshotEpoch) snapshotEpoch.set(k, v + 1);
    let changed = false;
    for (const shard of shards.values()) {
      if (!snapshotEpoch.has(shard.deviceId)) snapshotEpoch.set(shard.deviceId, 1);
      if (shard.connectionStatus === 'disconnected') continue;
      changed = true;
      shard.connectionStatus = 'disconnected';
      shard.sessions = shard.sessions.map((s) => ({
        ...s,
        deviceLinkConnectionStatus: 'disconnected',
      }));
    }
    if (changed) recompute();
  },

  /** 移除某台设备的所有远端会话(访问撤销 / 关被控 / 本机禁用控制 / 删除)。 */
  removeDevice(deviceId: string): void {
    // **自增**该设备 epoch(不 delete,见 snapshotEpoch 注释的 ABA):在途 refreshRemoteDeviceSessions
    // 的 epoch 立即失效,且下次 bootstrap 拿到更高 epoch,不会与断连前在途的 epoch 撞值。即使尚未建
    // shard(首拉未完成就被移除)也要 bump,否则在途首拉 await 回来仍能通过 isLatestSnapshotEpoch 加回。
    snapshotEpoch.set(deviceId, (snapshotEpoch.get(deviceId) ?? 0) + 1);
    if (!shards.delete(deviceId)) return;
    recompute();
  },

  /** 清空所有远端项目(登出 / device-link stopped / 卸载)。 */
  clear(): void {
    // 所有设备 epoch 无条件**自增**(不 clear-to-0,见 snapshotEpoch 注释的 ABA):清空时在途
    // 首拉立即失效;下一轮 bootstrap 拿到更高 epoch,不会与清空前的 epoch 撞值把陈旧 snapshot 盖回。
    for (const [k, v] of snapshotEpoch) snapshotEpoch.set(k, v + 1);
    if (shards.size === 0) return;
    shards.clear();
    recompute();
  },

  /** 侧边栏合并点用:当前所有远端会话的扁平列表(引用稳定)。 */
  getMergedRemoteSessions(): Session[] {
    return mergedSnapshot;
  },

  /** refresh anti-entropy 用:取某设备当前缓存分片，调用方只读。 */
  getDeviceSessions(deviceId: string): readonly Session[] {
    return shards.get(deviceId)?.sessions ?? EMPTY;
  },

  /**
   * origin 判定:给定 sessionId 返回其所属被控设备 deviceId;本地会话返回 undefined。
   * 传输层 / SessionView / 消息分页据此决定走本机 IPC 还是 deviceLink 隧道。
   */
  getSessionDeviceId(sessionId: string): string | undefined {
    return sessionDeviceIndex.get(sessionId);
  },

  /** 取设备友好名(tooltip / 日志用)。 */
  getDeviceName(deviceId: string): string | undefined {
    return shards.get(deviceId)?.deviceName;
  },

  /** 当前是否保留着该设备的远程会话快照(connected 或 disconnected 都算)。 */
  hasDevice(deviceId: string): boolean {
    return shards.has(deviceId);
  },

  /** 当前在线可控的被控设备 id 列表。断线缓存仍显示,但不算 host online。 */
  getDeviceIds(): string[] {
    return [...shards.values()]
      .filter((shard) => shard.connectionStatus === 'connected')
      .map((shard) => shard.deviceId);
  },

  /** 机器切换栏用:当前已同步或保留断线缓存的被控设备摘要列表(引用稳定 + 稳定排序)。 */
  getDeviceList(): RemoteDeviceSummary[] {
    return deviceListSnapshot;
  },

  /** snapshot 乱序保护:发起一次全量拉取前取新 epoch。 */
  nextSnapshotEpoch(deviceId: string): number {
    const n = (snapshotEpoch.get(deviceId) ?? 0) + 1;
    snapshotEpoch.set(deviceId, n);
    return n;
  },

  /** snapshot 乱序保护:await 回来后判断本次拉取是否仍是最新一次(否则丢弃结果)。 */
  isLatestSnapshotEpoch(deviceId: string, epoch: number): boolean {
    return snapshotEpoch.get(deviceId) === epoch;
  },
};

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 订阅设备改名通知(接入器据此对齐缓存名)。 */
function subscribeRename(fn: (deviceId: string, name: string) => void): () => void {
  renameSubs.add(fn);
  return () => {
    renameSubs.delete(fn);
  };
}

/** listing tier 挂载时注册「重拉某设备」的实现;卸载时传 null 清。 */
export function setRemoteReseedImpl(fn: ((deviceId: string) => void) | null): void {
  reseedImpl = fn;
}

/**
 * 请求重拉某被控设备的会话列表(reconcile)。由 push 消费侧调用:
 *  - `sessions:created`(无 row 数据)→ 重拉该设备;
 *  - applyPatch 收到未知 session 的 status=active(unarchive)→ 重拉补回。
 * 实现(含防抖)由 listing tier 注入;未挂载时 no-op。
 */
export function requestRemoteReseed(deviceId: string): void {
  reseedImpl?.(deviceId);
}

/** 组件内订阅:返回扁平远端会话快照(喂给 sidebar 合并点)。 */
export function useRemoteProjectSessions(): Session[] {
  return useSyncExternalStore(subscribe, actions.getMergedRemoteSessions);
}

/** 组件内订阅:返回当前已连接的被控设备摘要列表(机器切换栏 chips)。 */
export function useRemoteDevices(): RemoteDeviceSummary[] {
  return useSyncExternalStore(subscribe, actions.getDeviceList);
}

/** 非组件上下文(presence 订阅器 / 传输层)读写入口。 */
export const remoteProjectsStore = { ...actions, subscribe, subscribeRename };

/** 便捷导出:传输层只关心 origin 判定。 */
export function getSessionDeviceId(sessionId: string): string | undefined {
  return actions.getSessionDeviceId(sessionId);
}
