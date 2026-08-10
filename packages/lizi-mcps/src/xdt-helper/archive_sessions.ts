/**
 * xdt-helper/archive_sessions.ts —— 批量归档 / 取消归档历史 session(control 类)。
 *
 * 归档 = 把 sessions.status 置为 'archived'(从 sidebar 的 active 桶移出,可随时取消);
 * 取消归档 = 置回 'active'。两者都不删数据,可逆。
 *
 * host 侧走 patchSessionMetaInDb(已校验 status 白名单 + 广播 sessions:patched),
 * 因此改动会即时反映到 sidebar / agent-island,无需用户刷新或重启。
 *
 * 工具层护栏:
 *  - 写库需要绑定当前 session 上下文(NO_SESSION_CONTEXT);
 *  - 不允许归档"当前正在运行的这个 session"(会把脚下的地毯抽走),需先切到别的会话;
 *  - 批量大小 1..MAX_BATCH;同批 id 去重。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

const MAX_BATCH_SIZE = 50;

export type SessionStatus = 'active' | 'archived';

export interface SessionStatusChangeItem {
  sessionId: string;
  title: string | null;
  workingDir: string | null;
  status: SessionStatus;
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

export interface ArchiveSessionsDeps {
  getSessionContext(): LiziMcpSessionContext;
  setSessionsStatus(params: {
    sessionIds: string[];
    status: SessionStatus;
  }): Promise<SetSessionsStatusResult>;
}

const ARCHIVE_DESCRIPTION =
  `批量归档 ${BRAND_NAME} 历史对话/session(把 status 置为 archived,从侧栏 active 列表移出)。` +
  '归档可逆、不删数据,要恢复用 unarchive_sessions；已删除的 session 不能归档或恢复。' +
  '适合"清理已完成/过期会话"。' +
  '建议先用 history/list_sessions 找到目标 session_id。' +
  '失败码: NOT_FOUND(某些 id 不存在,整批不写) / PRECONDITION_FAILED(目标已删除) / NO_SESSION_CONTEXT / HOST_NOT_READY / INVALID_ARGS。';

const UNARCHIVE_DESCRIPTION =
  `批量取消归档 ${BRAND_NAME} 历史对话/session(把 status 置回 active,恢复到侧栏 active 列表)。` +
  '是 archive_sessions 的逆操作；已删除的 session 不能通过此工具复活。' +
  '失败码: NOT_FOUND / PRECONDITION_FAILED(目标已删除) / NO_SESSION_CONTEXT / HOST_NOT_READY / INVALID_ARGS。';

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
      session_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_BATCH_SIZE)
        .describe(config.idsDescription),
    },
    handler: async ({ session_ids }) => {
      const { ids, duplicate } = dedupe(session_ids);
      if (duplicate) {
        return errorPayload('INVALID_ARGS', `同一次调用里 session_id 重复: ${duplicate}。`);
      }

      const ctx = deps.getSessionContext();
      if (!ctx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `本次 MCP 调用没有绑定 ${BRAND_NAME} session,无法写库。`,
        );
      }

      // 归档不允许把"当前正在运行的这个 session"自己归档掉(取消归档时它已是 active,无需拦)。
      if (config.targetStatus === 'archived' && ids.includes(ctx.sessionId)) {
        return errorPayload(
          'INVALID_ARGS',
          '不能归档当前正在运行的 session。请把它从 session_ids 里去掉(或先切换到别的会话再归档它)。',
        );
      }

      const result = await deps.setSessionsStatus({ sessionIds: ids, status: config.targetStatus });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload(
            'HOST_NOT_READY',
            `${BRAND_NAME} 主进程会话服务尚未就绪。请告知用户稍等几秒后重试。`,
          );
        }
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
    idsDescription: `要归档的 session id 列表。一次最多 ${MAX_BATCH_SIZE} 个,建议来自 list_sessions 返回的 id。`,
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
    idsDescription: `要取消归档的 session id 列表。一次最多 ${MAX_BATCH_SIZE} 个。`,
  });
}
