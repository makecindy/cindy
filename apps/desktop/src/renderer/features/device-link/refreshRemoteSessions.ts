/**
 * refreshRemoteDeviceSessions —— 立即(可 await)重拉某被控设备的会话列表(bootstrap / reconcile)。
 *
 * 这是「读被控端真相」的一次性按需拉取。默认用于 listing tier 首拉、reconnect、
 * sessions:created reseed、fork / orca worker / 远程新建会话；周期 anti-entropy 也复用本函数，
 * 但使用 merge 模式，避免有界列表删除窗口外会话。
 *
 * 用 per-device epoch 防乱序:两次重拉乱序 resolve 时,旧的那次结果被丢弃(只接受最新一次),
 * 避免旧 snapshot 覆盖新 snapshot(reconcile 规则)。
 *
 * 瞬态重试(2026-06 真机实测修复):被控端刚上线那一刻,它宣布「在线/可被控」可能**早于**
 * 自身 localDb 迁移完成 —— 此时控制端 listing tier 首拉 `local-db:sessions:list` 会撞
 * 「DbClient not ready」,旧实现静默放弃、永不重试 → 控制端一直显示「设备在、但没有会话」。
 * 现在对一组**瞬态**错误(DbClient 未就绪 / 本机链路未连 / 目标暂离线 / invoke 超时)做有限退避
 * 重试,覆盖被控端启动窗口;对**永久**错误(被控开关关 / channel 不允许)立即放弃,不空转。
 */

import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';
import { DEVICE_LINK_RECONCILIATION_PROBE_MARKER } from '@cindy/maker-shared/device-link-contract';
import { remoteProjectsStore } from './remoteProjectsStore';
import { removeRemoteSessionActivityEntry } from './remoteSessionActivityStore';

const log = createLogger('device-link-refresh');

/** 与 listing tier 的拉取上限一致(useDeviceLinkRemoteProjects 的 LIST_LIMIT)。 */
const LIST_LIMIT = 200;

/** 满窗口时每轮最多补查多少个缺席缓存 id，避免退化成无界 N+1。 */
const MISSING_STATUS_PROBE_LIMIT = 8;

/** 默认重试次数(含首次):退避 250→500→1000→2000→3000ms,总窗口 ~6.75s,覆盖被控端冷启动迁移。 */
const DEFAULT_MAX_ATTEMPTS = 6;

/** 永久错误标记:命中即立即放弃(被控开关关 / channel 不在白名单)—— 重试也不会变。 */
const PERMANENT_MARKERS = ['REMOTE_DISABLED', 'CHANNEL_NOT_ALLOWED'] as const;

/**
 * 「访问已被撤销」标记(被控端逐设备黑名单)。bootstrap 期间被撤销(subscribe 已成功、list 被拒)时,
 * 这是个**语义性终态**,不能像普通永久错误那样静默 give-up —— 调用方需据此 handleRevoked(移除设备 +
 * 标记已撤销),否则会继续预取能力并清掉撤销标记,等于无视被控端的明确拒绝。renderer 实际看到的是 main
 * IPC 层映射后的 `[DEVICE_LINK_ACCESS_REVOKED]`(原始 DeviceLinkError('ACCESS_REVOKED') 经映射而来)。
 */
const ACCESS_REVOKED_MARKER = 'DEVICE_LINK_ACCESS_REVOKED';
/**
 * 瞬态错误标记:被控端刚上线 DB 未就绪 / 本机链路未连 / 目标暂离线 / invoke 超时 —— 值得退避重试。
 * ⚠️ 超时码用 DEVICE_LINK_TIMEOUT:invoke 超时的原始 DeviceLinkError('INVOKE_TIMEOUT') 在 main IPC
 * 层被映射成 `[DEVICE_LINK_TIMEOUT]` 才到 renderer,这里匹配的是 renderer 实际看到的已映射码。
 */
const TRANSIENT_MARKERS = [
  'DbClient not ready',
  'NOT_CONNECTED',
  'DEVICE_OFFLINE',
  'DEVICE_LINK_TIMEOUT',
] as const;

/**
 * 该远程错误是否「瞬态、值得重试」。永久错误优先(命中即不重试);否则仅当命中已知瞬态标记
 * 才重试,未知错误一律不重试(避免对真正的失败空转)。纯函数,便于单测。
 */
export function isTransientRemoteError(message: string): boolean {
  if (PERMANENT_MARKERS.some((m) => message.includes(m))) return false;
  return TRANSIENT_MARKERS.some((m) => message.includes(m));
}

/** 退避:250ms 起指数增长,封顶 3000ms。 */
function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 3000);
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RefreshOptions {
  /** 注入式 sleep(测试用,默认真实 setTimeout)。 */
  sleep?: (ms: number) => Promise<void>;
  /** 最大尝试次数(含首次),默认 DEFAULT_MAX_ATTEMPTS。 */
  maxAttempts?: number;
  /** sessions:list 始终有界，默认 merge；仅已知完整的调用方才可显式 replace。 */
  snapshotMode?: 'replace' | 'merge';
  /** 周期 tick 可弱合并到任意在途 refresh；事件型 refresh 默认强语义补跑。 */
  coalescingMode?: 'strong' | 'weak';
}

/**
 * 重拉结果:
 *  - `ok`:成功落地最新快照;
 *  - `revoked`:被控端在 bootstrap 期间撤销了访问权限 → 调用方应 handleRevoked;
 *  - `superseded`:断连 / 清理等外部状态变化使本次快照失效 → 不是请求失败,等待后续重连;
 *  - `gave-up`:瞬态重试耗尽 / 永久非撤销错误 → 调用方照常收尾(push / reconnect 会兜底补上)。
 */
export type RefreshResult = 'ok' | 'revoked' | 'superseded' | 'gave-up';

interface RefreshTask {
  promise: Promise<RefreshResult>;
  rerun: boolean;
  name?: string;
  opts: RefreshOptions;
}

const refreshTasks = new Map<string, RefreshTask>();

/**
 * 满窗口缺席行的轮询队列(per-device)。不能用 snapshot epoch 推导数组下标：前一轮
 * 确认终态并移除候选后，数组会收缩，重算下标会跳过紧邻项。队列在每轮开始时与当前
 * missing ids 对账，保留旧轮询顺序、移除已不缺席项，并把新缺席项追加到队尾。
 */
const missingStatusProbeQueues = new Map<string, string[]>();

function reconcileMissingStatusProbeQueue(
  deviceId: string,
  missingSessionIds: readonly string[],
): string[] {
  if (missingSessionIds.length === 0) {
    missingStatusProbeQueues.delete(deviceId);
    return [];
  }
  const missingIds = new Set(missingSessionIds);
  const previous = missingStatusProbeQueues.get(deviceId) ?? [];
  const queuedIds = new Set<string>();
  const queue: string[] = [];
  for (const sessionId of previous) {
    if (!missingIds.has(sessionId) || queuedIds.has(sessionId)) continue;
    queuedIds.add(sessionId);
    queue.push(sessionId);
  }
  for (const sessionId of missingSessionIds) {
    if (queuedIds.has(sessionId)) continue;
    queuedIds.add(sessionId);
    queue.push(sessionId);
  }
  missingStatusProbeQueues.set(deviceId, queue);
  return queue;
}

export async function refreshRemoteDeviceSessions(
  deviceId: string,
  name?: string,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const existing = refreshTasks.get(deviceId);
  if (existing) {
    const requestedSnapshotMode = opts.snapshotMode ?? 'merge';
    // periodic tick 是弱语义：已有任意 refresh 在途时直接复用，不能每个 interval tick
    // 都 bump epoch 让慢请求自取消。bootstrap/reseed 等事件型 refresh 仍走强语义补跑。
    if (opts.coalescingMode === 'weak') return existing.promise;

    existing.rerun = true;
    existing.name = name ?? existing.name;
    existing.opts = {
      ...existing.opts,
      ...opts,
      // 显式 replace 是更强的 snapshot 覆盖要求，不能被后续 merge 降级；默认的事件型
      // refresh 则保持安全的有界 merge，并通过上面的强 coalescing 语义确保补跑。
      snapshotMode:
        (existing.opts.snapshotMode ?? 'merge') === 'replace' || requestedSnapshotMode === 'replace'
          ? 'replace'
          : 'merge',
    };
    // 先让当前 in-flight snapshot 失效,否则它可能在排队的补跑开始前覆盖 push 带来的新状态。
    remoteProjectsStore.nextSnapshotEpoch(deviceId);
    return existing.promise;
  }

  const task: RefreshTask = {
    promise: Promise.resolve('gave-up'),
    rerun: false,
    name,
    opts,
  };
  task.promise = drainRefreshTask(deviceId, task).finally(() => {
    if (refreshTasks.get(deviceId) === task) refreshTasks.delete(deviceId);
  });
  refreshTasks.set(deviceId, task);
  return task.promise;
}

async function drainRefreshTask(deviceId: string, task: RefreshTask): Promise<RefreshResult> {
  let result: RefreshResult = 'gave-up';
  do {
    task.rerun = false;
    result = await runRefreshRemoteDeviceSessions(deviceId, task.name, task.opts);
    // revoked 是被控端明确拒绝,不再补跑排队请求。
    if (result === 'revoked') return result;
  } while (task.rerun);
  return result;
}

async function probeMissingSessionStatuses(
  deviceId: string,
  epoch: number,
  missingSessionIds: readonly string[],
): Promise<void> {
  const queue = reconcileMissingStatusProbeQueue(deviceId, missingSessionIds);
  if (queue.length === 0) return;
  const count = Math.min(MISSING_STATUS_PROBE_LIMIT, queue.length);
  const candidates = queue.slice(0, count);
  const results = await Promise.all(
    candidates.map(async (sessionId) => {
      try {
        const value = await window.electronAPI.deviceLink.invoke(
          deviceId,
          'local-db:sessions:get',
          [sessionId, DEVICE_LINK_RECONCILIATION_PROBE_MARKER],
        );
        return { sessionId, value };
      } catch (error) {
        return { sessionId, errorCode: extractIpcError(error)?.code };
      }
    }),
  );
  // 更强的 refresh / remove / disconnect 已使本轮失效时，不应用迟到的补查结果。
  if (!remoteProjectsStore.isLatestSnapshotEpoch(deviceId, epoch)) return;
  const terminalIds = new Set<string>();
  for (const result of results) {
    if (result.errorCode === 'NOT_FOUND') {
      terminalIds.add(result.sessionId);
      remoteProjectsStore.applyPatch(deviceId, result.sessionId, { status: 'deleted' });
      removeRemoteSessionActivityEntry(result.sessionId);
      continue;
    }
    if (!result.value || typeof result.value !== 'object') continue;
    const session = result.value as Partial<Session>;
    if (session.id !== result.sessionId) continue;
    if (session.status === 'archived' || session.status === 'deleted') {
      terminalIds.add(result.sessionId);
      remoteProjectsStore.applyPatch(deviceId, result.sessionId, {
        status: session.status,
        updatedAt: session.updatedAt,
      });
      removeRemoteSessionActivityEntry(result.sessionId);
      continue;
    }
    // sessions:get 返回窗口外 active 行时同样是权威快照，回填 title / pinnedAt / model 等
    // 元数据；否则丢失 patched push 后会永久保留旧字段。
    remoteProjectsStore.applyPatch(deviceId, result.sessionId, { ...session });
  }
  const nextQueue = [
    ...queue.slice(count),
    ...candidates.filter((sessionId) => !terminalIds.has(sessionId)),
  ];
  if (nextQueue.length === 0) {
    missingStatusProbeQueues.delete(deviceId);
  } else {
    missingStatusProbeQueues.set(deviceId, nextQueue);
  }
}

async function runRefreshRemoteDeviceSessions(
  deviceId: string,
  name?: string,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const sleep = opts.sleep ?? realSleep;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const deviceName = name ?? remoteProjectsStore.getDeviceName(deviceId) ?? deviceId;
  const epoch = remoteProjectsStore.nextSnapshotEpoch(deviceId);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 被一次更新的重拉取代(期间又发起了新的 refresh)→ 停手,交给那一次(也避免无谓重试)。
    if (!remoteProjectsStore.isLatestSnapshotEpoch(deviceId, epoch)) return 'superseded';
    try {
      const list = await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:list', [
        LIST_LIMIT,
        'active',
        { includePinned: true },
      ]);
      // 乱序保护:本次拉取已不是最新一次 → 丢弃,别覆盖更新的结果。
      if (!remoteProjectsStore.isLatestSnapshotEpoch(deviceId, epoch)) return 'superseded';
      if (Array.isArray(list)) {
        if ((opts.snapshotMode ?? 'merge') === 'merge') {
          const sessions = list as Session[];
          const incomingIds = new Set(sessions.map((session) => session.id));
          const missingSessionIds = remoteProjectsStore
            .getDeviceSessions(deviceId)
            .filter((session) => !incomingIds.has(session.id))
            .map((session) => session.id);
          // 未满 LIST_LIMIT 证明 active 集合完整，可安全 replace 并清掉缺席的归档/删除行。
          // 满窗口时先 merge，再用既有只读 sessions:get 有界轮询窗口外缓存 id 的终态。
          if (sessions.length < LIST_LIMIT) {
            missingStatusProbeQueues.delete(deviceId);
            remoteProjectsStore.setDeviceSessions(deviceId, deviceName, sessions);
            for (const sessionId of missingSessionIds) {
              removeRemoteSessionActivityEntry(sessionId);
            }
          } else {
            remoteProjectsStore.mergeDeviceSessions(deviceId, deviceName, sessions);
            await probeMissingSessionStatuses(deviceId, epoch, missingSessionIds);
          }
        } else {
          remoteProjectsStore.setDeviceSessions(deviceId, deviceName, list as Session[]);
        }
      }
      return 'ok'; // 成功
    } catch (err) {
      if (!remoteProjectsStore.isLatestSnapshotEpoch(deviceId, epoch)) return 'superseded';
      const message = err instanceof Error ? err.message : String(err);
      // 访问被撤销:语义性终态,不重试、也不静默 give-up —— 让调用方 handleRevoked(见 ACCESS_REVOKED_MARKER)。
      if (message.includes(ACCESS_REVOKED_MARKER)) {
        log.debug(`refreshRemoteDeviceSessions access revoked for ${deviceId.slice(0, 8)}`);
        return 'revoked';
      }
      const canRetry = attempt < maxAttempts - 1 && isTransientRemoteError(message);
      if (!canRetry) {
        // 永久错误 / 重试耗尽:放弃(push / 下一次 reconnect 仍会兜底补上,只是慢一拍)。
        log.debug(`refreshRemoteDeviceSessions gave up for ${deviceId.slice(0, 8)}`, err);
        return 'gave-up';
      }
      log.debug(
        `refreshRemoteDeviceSessions transient for ${deviceId.slice(0, 8)} (attempt ${attempt + 1}/${maxAttempts}), retrying`,
        message,
      );
      await sleep(backoffMs(attempt));
    }
  }
  return 'gave-up';
}
