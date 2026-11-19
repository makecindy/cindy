/**
 * xdt-helper/task_inbox.ts —— 收件箱写操作(control 类):稍后处理与完成。
 *
 * 与侧栏收件箱同一套规则(docs/product-rules/task-inbox.md):
 *  - snooze_sessions 写任务所在电脑的 snoozedUntil(无限期为保留值),null 取回;
 *    复用 patch-meta 的校验、保存与广播,远程走同一窄写入通道。
 *  - complete_sessions 对应侧栏「完成」:绑着启用中自动化的任务只把这轮标为已读,
 *    其余归档(未提交改动与侧栏默认、archive_sessions 一样保存为可恢复快照);
 *    运行中、被 IM 接管时不动并逐项说明。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { INDEFINITE_SNOOZE_UNTIL, isAcceptedSnoozeUntil } from '@cindy/maker-shared/live-task-priority';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../types.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { stringArrayParam } from './_array-param.js';
import { parseQualifiedSessionId } from './send_to_session.js';

const MAX_BATCH_SIZE = 50;

export interface SessionSnoozeChangeItem {
  sessionId: string;
  title: string | null;
  snoozedUntil: string | null;
  snoozedAt: string | null;
}

/** Sequential writes, stop on the first failure, no rollback or replay. */
export type SetSessionsSnoozeResult =
  | { ok: true; changed: SessionSnoozeChangeItem[] }
  | {
      ok: false;
      errorCode: string;
      message: string;
      changed: SessionSnoozeChangeItem[];
      failedSessionId: string;
      remainingSessionIds: string[];
    };

export type CompleteSessionOutcome = 'archived' | 'marked_read' | 'already_archived' | 'blocked';
export type CompleteSessionBlockReason =
  | 'NOT_FOUND'
  | 'DELETED'
  | 'RUNNING'
  | 'IM_ATTACHED'
  | 'PRECONDITION_FAILED'
  | 'FAILED';

export interface CompleteSessionItem {
  sessionId: string;
  title: string | null;
  outcome: CompleteSessionOutcome;
  reason?: CompleteSessionBlockReason;
  message?: string;
}

export interface TaskInboxDeps {
  getSessionContext(): LiziMcpSessionContext;
  /** deviceId absent = this computer. */
  setSessionsSnooze(params: {
    deviceId?: string;
    sessionIds: string[];
    snoozedUntil: string | null;
  }): Promise<SetSessionsSnoozeResult>;
  /** This computer only; each item is decided and applied independently. */
  completeSessions?(params: { sessionIds: string[] }): Promise<ControlResult<{ items: CompleteSessionItem[] }, 'HOST_NOT_READY'>>;
}

type Batch =
  | { ok: false; errorCode: string; message: string }
  | { ok: true; deviceId?: string; sessionIds: string[] };

/** Same id rules as archive_sessions: local or one remote computer per call, no duplicates. */
function resolveBatch(rawIds: string[]): Batch {
  const invalid = (message: string): Batch => ({ ok: false, errorCode: 'INVALID_ARGS', message });
  const targets = rawIds.map((id) => {
    const target = parseQualifiedSessionId(id);
    return target?.deviceId === 'local' ? { deviceId: null, sessionId: target.sessionId } : target;
  });
  for (const [index, id] of rawIds.entries()) {
    const target = targets[index];
    if (id.includes('::') && (!target || target.sessionId.includes('::'))) {
      return invalid('设备任务 ID 必须为 deviceId::sessionId，local:: 后不能再带设备前缀。');
    }
  }
  const deviceId = targets[0]?.deviceId ?? null;
  if (targets.some((target) => (target?.deviceId ?? null) !== deviceId)) {
    return invalid('一次只能操作同一台电脑的任务，请按电脑分批调用；本次没有写入。');
  }
  const sessionIds = rawIds.map((id, index) => targets[index]?.sessionId ?? id);
  const duplicate = sessionIds.find((id, index) => sessionIds.indexOf(id) !== index);
  if (duplicate) return invalid(`同一次调用里 session_id 重复: ${duplicate}。`);
  return deviceId ? { ok: true, deviceId, sessionIds } : { ok: true, sessionIds };
}

function requireSessionContext(deps: TaskInboxDeps) {
  const ctx = deps.getSessionContext();
  return ctx.sessionId || ctx.hostCaller ? ctx : null;
}

const IDS_DESCRIPTION =
  `同一台电脑的 session id 列表，一次最多 ${MAX_BATCH_SIZE} 个；本机可直接用 id 或 local::id，跨电脑用 deviceId::sessionId（来自 list_sessions）。`;

const SNOOZE_DESCRIPTION = [
  '把任务放进收件箱的「稍后处理」，或取回(until=null)。与侧栏「稍后处理」写同一字段，侧栏、手机和其它电脑即时同步。',
  `until 为到期时间(ISO 8601，必须在未来一年内)，或 "indefinite" / ${INDEFINITE_SNOOZE_UNTIL} 表示无限期；到期或任务收到新输入后自动回到原分区。`,
  '只影响收件箱分区，不暂停执行、不改自动化。跨电脑沿用同账号远程控制授权，一次只接受一台电脑。',
  '按顺序逐项写入，首次失败即停止，不回滚已完成项；错误 data 返回 changed、failed_session_id、remaining_session_ids。',
  'REMOTE_RESULT_UNKNOWN 表示失败项可能已生效，先用 list_sessions 查看再决定是否重试。REMOTE_UNSUPPORTED 表示目标电脑版本过旧。',
  '失败码: NOT_FOUND / INVALID_ARGS / NO_SESSION_CONTEXT / HOST_NOT_READY / REMOTE_*。',
].join('');

const COMPLETE_DESCRIPTION = [
  '对应侧栏收件箱的「完成」：任务绑着启用中的自动化时只把这轮结果标为已读（清除未读、待处理提醒与未读运行，任务回到进行中，不回收工作区）；',
  '其余任务归档（未提交改动保存为快照，可用 unarchive_sessions 恢复任务后找回）。仅限本机任务；跨电脑任务返回 REMOTE_UNSUPPORTED，可改用 archive_sessions。',
  '逐项独立处理并返回 items[].outcome：archived / marked_read / already_archived / blocked。',
  'blocked 时 reason 为 RUNNING(正在执行，先停止) / IM_ATTACHED(被 IM 接管，先收回) / NOT_FOUND / DELETED / PRECONDITION_FAILED / FAILED。',
  '不能完成当前调用所在的任务。',
].join('');

export function registerTaskInboxTools(registry: XdtHelperToolRegistry, deps: TaskInboxDeps): void {
  registry.register({
    name: 'snooze_sessions',
    category: 'control',
    description: SNOOZE_DESCRIPTION,
    inputShape: {
      session_ids: stringArrayParam(z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE)).describe(IDS_DESCRIPTION),
      until: z.string().min(1).max(64).nullable().describe('到期时间(ISO 8601)、"indefinite"，或 null 取回。'),
    },
    handler: async ({ session_ids, until }) => {
      const snoozedUntil = until === 'indefinite' ? INDEFINITE_SNOOZE_UNTIL : until;
      if (snoozedUntil !== null && !isAcceptedSnoozeUntil(snoozedUntil, Date.now())) {
        return errorPayload('INVALID_ARGS', 'until 必须是未来一年内的 ISO 8601 时间、"indefinite" 或 null。');
      }
      const batch = resolveBatch(session_ids);
      if (!batch.ok) return errorPayload(batch.errorCode, batch.message);
      if (!requireSessionContext(deps)) {
        return errorPayload('NO_SESSION_CONTEXT', `本次 MCP 调用没有绑定 ${BRAND_NAME} session,无法写库。`);
      }
      const result = await deps.setSessionsSnooze({
        ...(batch.deviceId ? { deviceId: batch.deviceId } : {}),
        sessionIds: batch.sessionIds,
        snoozedUntil,
      });
      const qualify = (id: string) => (batch.deviceId ? `${batch.deviceId}::${id}` : id);
      const changed = result.changed.map((item) => ({
        session_id: qualify(item.sessionId),
        title: item.title,
        snoozed_until: item.snoozedUntil,
        snoozed_at: item.snoozedAt,
      }));
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message, {
          partial: changed.length > 0 || result.errorCode === 'REMOTE_RESULT_UNKNOWN',
          changed,
          failed_session_id: qualify(result.failedSessionId),
          remaining_session_ids: result.remainingSessionIds.map(qualify),
        });
      }
      return okPayload({ count: changed.length, changed });
    },
  });

  if (!deps.completeSessions) return;
  const completeSessions = deps.completeSessions;
  registry.register({
    name: 'complete_sessions',
    category: 'control',
    description: COMPLETE_DESCRIPTION,
    inputShape: {
      session_ids: stringArrayParam(z.array(z.string().min(1)).min(1).max(MAX_BATCH_SIZE)).describe(IDS_DESCRIPTION),
    },
    handler: async ({ session_ids }) => {
      const batch = resolveBatch(session_ids);
      if (!batch.ok) return errorPayload(batch.errorCode, batch.message);
      if (batch.deviceId) {
        return errorPayload('REMOTE_UNSUPPORTED', '暂不支持完成其它电脑上的任务（无法确认 IM 接管状态）；可改用 archive_sessions。本次没有写入。');
      }
      const ctx = requireSessionContext(deps);
      if (!ctx) {
        return errorPayload('NO_SESSION_CONTEXT', `本次 MCP 调用没有绑定 ${BRAND_NAME} session,无法写库。`);
      }
      if (ctx.sessionId && batch.sessionIds.includes(ctx.sessionId)) {
        return errorPayload('INVALID_ARGS', '不能完成当前正在运行的任务，请把它从 session_ids 里去掉。');
      }
      const result = await completeSessions({ sessionIds: batch.sessionIds });
      if (!result.ok) {
        return errorPayload(result.errorCode, `${BRAND_NAME} 主进程会话服务尚未就绪。请稍等几秒后重试。`);
      }
      const items = result.items.map((item) => ({
        session_id: item.sessionId,
        title: item.title,
        outcome: item.outcome,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.message ? { message: item.message } : {}),
      }));
      return okPayload({
        count: items.filter((item) => item.outcome !== 'blocked').length,
        items,
      });
    },
  });
}
