import { parseSharedTaskPeer, type InvokeResultPayload } from '@cindy/device-link';
import type { XdtHelperMcpDeps } from '@cindy/mcps';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';
import { stripDeepLinkPathPrefix } from '../../shared/deepLinkSchemes.js';
import { visibleMessageText } from '../localDb/conversationSearch.pure.js';
import { classifyRemoteHistoryError } from './remoteChatHistory.js';
import type { SharedTaskCallerAccess } from './sharedTaskTools.js';
import { historyContentText, taskDigestErrorSummary } from './taskDigest.js';

type ProgressReader = NonNullable<NonNullable<XdtHelperMcpDeps['history']>['readSharedTaskProgress']>;
type ProgressEvent = Extract<Awaited<ReturnType<ProgressReader>>, { ok: true }>['events'][number];
type Invoke = (peer: string, channel: string, args: unknown[], options: { preSend: () => void }) => Promise<InvokeResultPayload>;
const PAGE_SIZE = 20;
const TEXT_LIMIT = 2_000;
const failure = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function sharedTaskTarget(link: string) {
  const path = stripDeepLinkPathPrefix(link, 'session/');
  if (!path) return null;
  const [encodedId, query] = path.split('?');
  if (!encodedId || !query) return null;
  const peer = new URLSearchParams(query).get('device');
  if (!peer || parseSharedTaskPeer(peer)?.role !== 'host') return null;
  try {
    const sessionId = decodeURIComponent(encodedId);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId) ? { sessionId, peer } : null;
  } catch { return null; }
}

function progressEvent(row: Record<string, unknown>): ProgressEvent[] {
  const role = row.role;
  let text = '';
  const content = record(row.content);
  if (role === 'user' || role === 'assistant') {
    text = historyContentText(row.content);
    if (!text.trim() || (role === 'user' && (record(row.agentMeta)?.autoResume === true || isSyntheticTriggerText(text)))) return [];
  } else if (role === 'tool_use') {
    text = typeof content?.toolName === 'string' ? content.toolName : '';
  } else if (role === 'error') {
    text = taskDigestErrorSummary(content?.message) ?? '';
  } else if (role === 'ask_user' || role === 'plan_review') {
    text = visibleMessageText(role, row.content);
  } else if (role !== 'tool_result') {
    return [];
  }
  const truncated = text.length > TEXT_LIMIT;
  if (truncated) {
    const half = Math.floor((TEXT_LIMIT - 1) / 2);
    text = `${text.slice(0, half)}…${text.slice(-half)}`;
  }
  const date = typeof row.createdAt === 'number' || typeof row.createdAt === 'string' ? new Date(row.createdAt) : null;
  return [{
    role,
    ...(text ? { text } : {}),
    ...(truncated || record(row.agentMeta)?.remoteContentTruncated === true ? { truncated: true } : {}),
    ...(date && Number.isFinite(date.valueOf()) ? { createdAt: date.toISOString() } : {}),
  }];
}

/** Uses the same three task-scoped reads as the guest UI. The owner validates membership on every result. */
export function createSharedTaskProgressReader(deps: SharedTaskCallerAccess & { invoke: Invoke }): ProgressReader {
  return async ({ task_link, before }, context) => {
    const target = sharedTaskTarget(task_link);
    if (!target) return failure('INVALID_ARGS', '请在已加入的共享任务中选择「复制任务链接」，并传入完整链接。');
    if (!context?.sessionId || !context.sessionInstanceId) return failure('PERMISSION_DENIED', '缺少当前任务身份。');
    const { peer, sessionId } = target;
    try {
      const initial = deps.caller(context);
      if (!initial.current || !initial.accountScoped) return failure('PERMISSION_DENIED', '当前输入无权读取此账号收到的共享任务。');
      const group = await deps.captureGroupAccess(context);
      const assertCurrent = () => {
        const caller = deps.caller(context);
        if (!caller.current || !caller.accountScoped || caller.key !== initial.key) {
          throw Object.assign(new Error('当前任务或账号已切换。'), { code: 'ACCESS_REVOKED' });
        }
        group?.assertCurrent();
      };
      const read = async (channel: string, args: unknown[]) => {
        assertCurrent();
        const reply = await deps.invoke(peer, channel, args, { preSend: assertCurrent });
        assertCurrent();
        if (!reply.ok) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
        return reply.result;
      };
      await group?.refresh();
      const session = record(await read('local-db:sessions:get', [sessionId]));
      if (session?.id !== sessionId || session.status === 'deleted' ||
          (!CINDY_MAKE_ENABLED && typeof session.source === 'string' && isCindyMakeSource(session.source))) {
        return failure('NOT_FOUND', '该共享任务当前不可访问。');
      }
      const [inTurn, rows] = await Promise.all([
        read('maker:session-in-turn', [sessionId]),
        read('local-db:messages:list', [sessionId, { limit: PAGE_SIZE + 1, ...(before ? { before } : {}) }]),
      ]);
      assertCurrent();
      if (typeof inTurn !== 'boolean' || !Array.isArray(rows) ||
          !rows.every(row => record(row)?.sessionId === sessionId && typeof row.id === 'string')) {
        return failure('INVALID_RESPONSE', '未取得有效的共享任务进度。');
      }
      // messages:list is newest first. Advance on raw rows even if the page contains only hidden events.
      const page: Record<string, unknown>[] = rows.slice(0, PAGE_SIZE);
      const more = rows.length > PAGE_SIZE || page.some(row => record(row.agentMeta)?.remoteRowsTrimmed === true);
      const lastId = page.at(-1)?.id;
      const nextBefore = more && typeof lastId === 'string' ? lastId : null;
      if (before && (page.some(row => row.id === before) || nextBefore === before)) {
        return failure('INVALID_CURSOR', '这页记录已变动，请重新查询最新进度。');
      }
      return { ok: true, title: typeof session.title === 'string' ? session.title : '', inTurn,
        observedAt: new Date().toISOString(), events: page.reverse().flatMap(progressEvent), nextBefore };
    } catch (error) {
      const code = record(error)?.code;
      const message = error instanceof Error ? error.message : '共享任务连接不可用。';
      const classified = classifyRemoteHistoryError(typeof code === 'string' ? code : 'INTERNAL', message);
      if (classified.errorCode === 'REMOTE_ACCESS_REVOKED') return failure(classified.errorCode, '当前账号或任务的共享访问已失效。');
      if (classified.errorCode === 'REMOTE_DEVICE_OFFLINE') return failure(classified.errorCode, '共享任务所在的电脑已离线，暂时无法查询进度。');
      return failure(classified.errorCode, classified.message);
    }
  };
}
