/**
 * xdt-helper/archive_sessions.ts —— 批量归档 / 取消归档 / 稍后处理任务(control 类)。
 *
 * 归档 = 把 sessions.status 置为 'archived'(从 sidebar 的 active 桶移出,可随时取消);
 * 取消归档 = 置回 'active'。两者都不删数据,可逆。
 * 稍后处理(snooze_sessions) = 写 snoozedUntil,与收件箱「稍后处理 / 取回」同一字段与入口。
 *
 * 本机走 setSessionsStatusInDb；远程复用 patchSessionMetaInDb(状态校验 + 广播),
 * 因此改动会即时反映到 sidebar / agent-island,无需用户刷新或重启。
 *
 * 工具层护栏:
 *  - 写库需要绑定当前 session 上下文(NO_SESSION_CONTEXT);
 *  - 不允许归档"当前正在运行的这个 session"(会把脚下的地毯抽走),需先切到别的会话;
 *  - 批量大小 1..MAX_BATCH;同批 id 去重。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { INDEFINITE_SNOOZE_UNTIL } from '@cindy/maker-shared/live-task-priority';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { stringArrayParam } from './_array-param.js';
import { parseQualifiedSessionId } from './send_to_session.js';

const MAX_BATCH_SIZE = 50;
/** Same limit as the host's snooze validation. */
const MAX_SNOOZE_MS = 366 * 86_400_000;

export type SessionStatus = 'active' | 'archived';

export interface SessionStatusChangeItem {
  sessionId: string;
  title: string | null;
  workingDir: string | null;
  status: SessionStatus | 'deleted';
}

/**
 * host 回调结果。NOT_FOUND 表示批次里至少有一个 id 不存在；
 * PRECONDITION_FAILED 表示目标已经删除，通用状态工具不能将其复活。
 * 两种情况 host 都不做任何写入（全有且可变更才写，避免半应用）。
 */
export type SetSessionsStatusResult = ControlResult<
  { changed: SessionStatusChangeItem[] },
  'NOT_FOUND' | 'PRECONDITION_FAILED'
>;

export type RemoteSessionsStatusResult =
  | { ok: true; changed: SessionStatusChangeItem[] }
  | {
      ok: false;
      errorCode: string;
      message: string;
      changed: SessionStatusChangeItem[];
      failedSessionId: string;
      remainingSessionIds: string[];
    };

export interface SessionSnoozeChangeItem {
  sessionId: string;
  title: string | null;
  workingDir: string | null;
  snoozedUntil: string | null;
}

/** Local and remote batches report the same way: stop at the first failure, keep what was written. */
export type SetSessionsSnoozeResult =
  | { ok: true; changed: SessionSnoozeChangeItem[] }
  | {
      ok: false;
      errorCode: string;
      message: string;
      changed: SessionSnoozeChangeItem[];
      failedSessionId?: string;
      remainingSessionIds?: string[];
    };

export interface SnoozeSessionsDeps {
  getSessionContext(): LiziMcpSessionContext;
  /** `snoozedUntil` null wakes the task now; the indefinite value keeps it until woken. */
  setSessionsSnooze(params: { sessionIds: string[]; snoozedUntil: string | null }): Promise<SetSessionsSnoozeResult>;
  setRemoteSessionsSnooze?(params: {
    deviceId: string;
    sessionIds: string[];
    snoozedUntil: string | null;
  }): Promise<SetSessionsSnoozeResult>;
}

export interface ArchiveSessionsDeps {
  getSessionContext(): LiziMcpSessionContext;
  setSessionsStatus(params: {
    sessionIds: string[];
    status: SessionStatus;
  }): Promise<SetSessionsStatusResult>;
  /** One remote device per batch; sequential, stop on failure, no rollback/replay. */
  setRemoteSessionsStatus?(params: {
    deviceId: string;
    sessionIds: string[];
    status: SessionStatus;
  }): Promise<RemoteSessionsStatusResult>;
}

const BATCH_DESCRIPTION =
  '默认本机（也支持 local::sessionId）；跨电脑传 deviceId::sessionId（来自 list_sessions），沿用同账号远程控制授权与任务权限档。' +
  '一次只接受一台电脑的任务，混合本机/远程或多台远程电脑在写入前报 INVALID_ARGS。' +
  '本机批次原子写入；远程按顺序逐项写入，首次失败即停止，不回滚已完成项，错误 data 返回 changed、failed_session_id、remaining_session_ids。' +
  'REMOTE_RESULT_UNKNOWN 表示失败项可能已生效，先查询状态再决定是否重试，不自动重发。' +
  '远程失败码还包括 REMOTE_UNSUPPORTED / REMOTE_DEVICE_OFFLINE / REMOTE_DISABLED / REMOTE_ACCESS_REVOKED / REMOTE_UNAVAILABLE。';

const ARCHIVE_DESCRIPTION =
  `批量归档 ${BRAND_NAME} 历史对话/session(把 status 置为 archived,从侧栏 active 列表移出)。` +
  '归档可逆、不删数据,要恢复用 unarchive_sessions；已删除的 session 不能归档或恢复。' +
  '适合"清理已完成/过期会话"。' +
  '建议先用 history/list_sessions 找到目标 session_id。' +
  BATCH_DESCRIPTION +
  '失败码: NOT_FOUND / PRECONDITION_FAILED(目标已删除或生命周期受限) / NO_SESSION_CONTEXT / HOST_NOT_READY / INVALID_ARGS。';

const UNARCHIVE_DESCRIPTION =
  `批量取消归档 ${BRAND_NAME} 历史对话/session(把 status 置回 active,恢复到侧栏 active 列表)。` +
  '是 archive_sessions 的逆操作；已删除的 session 不能通过此工具复活。' +
  '恢复只改归档状态，不发送旧消息、不恢复暂停自动化、不启动执行；恢复成功后可另用 send_to_session 发送新消息。' +
  BATCH_DESCRIPTION +
  '失败码: NOT_FOUND / PRECONDITION_FAILED(目标已删除或生命周期受限) / NO_SESSION_CONTEXT / HOST_NOT_READY / INVALID_ARGS。';

function dedupe(ids: string[]): { ids: string[]; duplicate: string | null } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) return { ids: out, duplicate: id };
    seen.add(id);
    out.push(id);
  }
  return { ids: out, duplicate: null };
}

function toPayloadItem(item: SessionStatusChangeItem): Record<string, unknown> {
  return {
    session_id: item.sessionId,
    title: item.title,
    working_dir: item.workingDir,
    status: item.status,
  };
}

function hostNotReady() {
  return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程会话服务尚未就绪。请告知用户稍等几秒后重试。`);
}

/** One computer per batch: local ids lose a `local::` prefix, remote ids keep their device. */
function resolveBatch(
  sessionIds: string[],
  ctx: LiziMcpSessionContext,
  opts: { rejectCurrent: boolean },
): { deviceId: string | null; ids: string[] } | { error: ReturnType<typeof errorPayload> } {
  if (sessionIds.some((id) => {
    const target = parseQualifiedSessionId(id);
    return target?.deviceId === 'local' && target.sessionId.includes('::');
  })) {
    return { error: errorPayload('INVALID_ARGS', 'local:: 后必须是本机任务 ID，不能嵌套设备前缀。') };
  }
  const { ids, duplicate } = dedupe(sessionIds.map((id) => {
    const target = parseQualifiedSessionId(id);
    return target?.deviceId === 'local' ? target.sessionId : id;
  }));
  if (duplicate) {
    return { error: errorPayload('INVALID_ARGS', `同一次调用里 session_id 重复: ${duplicate}。`) };
  }
  if (!ctx.sessionId && !ctx.hostCaller) {
    return { error: errorPayload('NO_SESSION_CONTEXT', `本次 MCP 调用没有绑定 ${BRAND_NAME} session,无法写库。`) };
  }
  // 归档不允许把"当前正在运行的这个 session"自己归档掉(取消归档时它已是 active,无需拦)。
  if (opts.rejectCurrent && ctx.sessionId && ids.includes(ctx.sessionId)) {
    return {
      error: errorPayload(
        'INVALID_ARGS',
        '不能归档当前正在运行的 session。请把它从 session_ids 里去掉(或先切换到别的会话再归档它)。',
      ),
    };
  }
  const targets = ids.map(parseQualifiedSessionId);
  if (ids.some((id, i) => id.includes('::') && !targets[i])) {
    return { error: errorPayload('INVALID_ARGS', '设备任务 ID 必须为 deviceId::sessionId。') };
  }
  const remote = targets.find((target) => target !== null);
  if (!remote) return { deviceId: null, ids };
  if (targets.some((target) => !target || target.deviceId !== remote.deviceId)) {
    return { error: errorPayload('INVALID_ARGS', '一次只能操作同一台电脑的任务，请按电脑分批调用；本次没有写入。') };
  }
  return { deviceId: remote.deviceId, ids: targets.map((target) => target!.sessionId) };
}

function registerSessionStatusTool(
  registry: XdtHelperToolRegistry,
  deps: ArchiveSessionsDeps,
  config: {
    name: 'archive_sessions' | 'unarchive_sessions';
    description: string;
    targetStatus: SessionStatus;
    idsDescription: string;
  },
): void {
  registry.register({
    name: config.name,
    category: 'control',
    description: config.description,
    inputShape: {
      session_ids: stringArrayParam(z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE))
        .describe(config.idsDescription),
    },
    handler: async ({ session_ids }) => {
      const batch = resolveBatch(session_ids, deps.getSessionContext(), {
        rejectCurrent: config.targetStatus === 'archived',
      });
      if ('error' in batch) return batch.error;
      const { deviceId, ids } = batch;
      if (deviceId) {
        if (!deps.setRemoteSessionsStatus) {
          return errorPayload('REMOTE_UNSUPPORTED', '当前宿主不支持跨电脑归档/取消归档；本次没有写入。');
        }
        const result = await deps.setRemoteSessionsStatus({
          deviceId,
          sessionIds: ids,
          status: config.targetStatus,
        });
        const qualify = (id: string) => `${deviceId}::${id}`;
        const changed = result.changed.map((item) => toPayloadItem({ ...item, sessionId: qualify(item.sessionId) }));
        if (!result.ok) {
          return errorPayload(result.errorCode, result.message, {
            partial: changed.length > 0 || result.errorCode === 'REMOTE_RESULT_UNKNOWN',
            changed,
            failed_session_id: qualify(result.failedSessionId),
            remaining_session_ids: result.remainingSessionIds.map(qualify),
          });
        }
        return okPayload({ status: config.targetStatus, count: changed.length, changed });
      }

      const result = await deps.setSessionsStatus({ sessionIds: ids, status: config.targetStatus });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') return hostNotReady();
        return errorPayload(result.errorCode, result.message);
      }

      return okPayload({
        status: config.targetStatus,
        count: result.changed.length,
        changed: result.changed.map(toPayloadItem),
      });
    },
  });
}

export function registerArchiveSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: ArchiveSessionsDeps,
): void {
  registerSessionStatusTool(registry, deps, {
    name: 'archive_sessions',
    description: ARCHIVE_DESCRIPTION,
    targetStatus: 'archived',
    idsDescription: `同一台电脑的 session id 列表；远程用 deviceId::sessionId。一次最多 ${MAX_BATCH_SIZE} 个,建议来自 list_sessions 返回的 id。`,
  });
}

export function registerUnarchiveSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: ArchiveSessionsDeps,
): void {
  registerSessionStatusTool(registry, deps, {
    name: 'unarchive_sessions',
    description: UNARCHIVE_DESCRIPTION,
    targetStatus: 'active',
    idsDescription: `同一台电脑的 session id 列表；远程用 deviceId::sessionId。一次最多 ${MAX_BATCH_SIZE} 个。`,
  });
}

const SNOOZE_DESCRIPTION =
  `批量「稍后处理」或取回 ${BRAND_NAME} 任务，与用户在收件箱里的「稍后处理 / 取回」同一操作：` +
  'until 传带时区的 ISO 8601 时间（未来一年内，到点回到收件箱对应分区）、indefinite（无限期，手动取回前一直收起）或 cancel（立即取回）。' +
  '稍后处理不归档、不停止 Agent、不暂停自动化；任务有新消息会提前回来；归档和取消归档会清除延期；置顶任务始终留在置顶。' +
  `本机批次先确认全部存在且未删除再逐个写入，中途失败即停止并返回已完成项。` +
  '跨电脑传 deviceId::sessionId（来自 list_sessions），一次只接受一台电脑的任务，按顺序写入，首次失败即停止，不回滚已完成项。' +
  'REMOTE_RESULT_UNKNOWN 表示失败项可能已生效，先查询状态再决定是否重试。' +
  '失败码: NOT_FOUND / PRECONDITION_FAILED(目标已删除) / NO_SESSION_CONTEXT / HOST_NOT_READY / INVALID_ARGS / REMOTE_*。';

/** Normalize to the host's stored form so the receipt can be compared exactly. */
function parseSnoozeUntil(until: string, now = Date.now()): string | null | { error: string } {
  const value = until.trim();
  if (value === 'cancel') return null;
  if (value === 'indefinite') return INDEFINITE_SNOOZE_UNTIL;
  // A bare date or a time without offset would be read in the host's zone; require it explicitly.
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    return { error: 'until 需要带时区的 ISO 8601 时间（如 2026-11-23T09:00:00+08:00），或 indefinite / cancel。' };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= now || ms > now + MAX_SNOOZE_MS) {
    return { error: 'until 必须是未来一年内的时间。' };
  }
  return new Date(ms).toISOString();
}

function toSnoozePayloadItem(item: SessionSnoozeChangeItem): Record<string, unknown> {
  return {
    session_id: item.sessionId,
    title: item.title,
    working_dir: item.workingDir,
    snoozed_until: item.snoozedUntil === INDEFINITE_SNOOZE_UNTIL ? 'indefinite' : item.snoozedUntil,
  };
}

export function registerSnoozeSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: SnoozeSessionsDeps,
): void {
  registry.register({
    name: 'snooze_sessions',
    category: 'control',
    description: SNOOZE_DESCRIPTION,
    inputShape: {
      session_ids: stringArrayParam(z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE))
        .describe(`同一台电脑的 session id 列表；远程用 deviceId::sessionId。一次最多 ${MAX_BATCH_SIZE} 个。`),
      until: z.string().min(1)
        .describe('带时区的 ISO 8601 唤回时间（未来一年内）、indefinite（无限期）或 cancel（立即取回）。'),
    },
    handler: async ({ session_ids, until }) => {
      const snoozedUntil = parseSnoozeUntil(until);
      if (snoozedUntil !== null && typeof snoozedUntil === 'object') {
        return errorPayload('INVALID_ARGS', snoozedUntil.error);
      }
      const batch = resolveBatch(session_ids, deps.getSessionContext(), { rejectCurrent: false });
      if ('error' in batch) return batch.error;
      const { deviceId, ids } = batch;
      if (deviceId && !deps.setRemoteSessionsSnooze) {
        return errorPayload('REMOTE_UNSUPPORTED', '当前宿主不支持跨电脑稍后处理；本次没有写入。');
      }
      const result = deviceId
        ? await deps.setRemoteSessionsSnooze!({ deviceId, sessionIds: ids, snoozedUntil })
        : await deps.setSessionsSnooze({ sessionIds: ids, snoozedUntil });
      const qualify = (id: string) => (deviceId ? `${deviceId}::${id}` : id);
      const changed = result.changed.map((item) => toSnoozePayloadItem({ ...item, sessionId: qualify(item.sessionId) }));
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY' && changed.length === 0 && !deviceId) return hostNotReady();
        return errorPayload(result.errorCode, result.message, {
          partial: changed.length > 0 || result.errorCode === 'REMOTE_RESULT_UNKNOWN',
          changed,
          ...(result.failedSessionId && { failed_session_id: qualify(result.failedSessionId) }),
          ...(result.remainingSessionIds && { remaining_session_ids: result.remainingSessionIds.map(qualify) }),
        });
      }
      return okPayload({
        snoozed_until: snoozedUntil === INDEFINITE_SNOOZE_UNTIL ? 'indefinite' : snoozedUntil,
        count: changed.length,
        changed,
      });
    },
  });
}

export interface PinSessionsDeps {
  getSessionContext(): LiziMcpSessionContext;
  setSessionsPinned(params: { deviceId: string | null; sessionIds: string[]; pinned: boolean }): Promise<
    | { ok: true; changed: { sessionId: string }[] }
    | { ok: false; errorCode: string; message: string; changed: { sessionId: string }[]; failedSessionId: string; remainingSessionIds: string[] }
  >;
}

export function registerPinSessionsTools(registry: XdtHelperToolRegistry, deps: PinSessionsDeps): void {
  for (const pinned of [true, false]) {
    registry.register({
      name: pinned ? 'pin_sessions' : 'unpin_sessions',
      category: 'control',
      description: (pinned ? '置顶任务，保留已置顶任务的顺序。' : '取消任务置顶并清除置顶卡片摘要。') +
        '每批 1–50 个本机任务或同一台远程电脑的 deviceId::sessionId。可操作当前任务。首次失败即停，返回已完成、失败及未执行的 ID。可用 list_sessions 或 get_task_digest 查询 pinned。',
      inputShape: { session_ids: stringArrayParam(z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE)) },
      handler: async ({ session_ids }) => {
        const batch = resolveBatch(session_ids, deps.getSessionContext(), { rejectCurrent: false });
        if ('error' in batch) return batch.error;
        const { deviceId, ids } = batch;
        const qualify = (id: string) => deviceId ? `${deviceId}::${id}` : id;
        const result = await deps.setSessionsPinned({ sessionIds: ids, deviceId, pinned });
        const changed = result.changed.map(({ sessionId }) => ({ session_id: qualify(sessionId), pinned }));
        if (result.ok) return okPayload({ count: changed.length, changed });
        return errorPayload(result.errorCode, result.message, {
          partial: changed.length > 0 || result.errorCode === 'REMOTE_RESULT_UNKNOWN',
          changed, failed_session_id: qualify(result.failedSessionId), remaining_session_ids: result.remainingSessionIds.map(qualify),
        });
      },
    });
  }
}
