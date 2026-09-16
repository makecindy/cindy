/**
 * xdt-helper/_session_ops.ts —— 会话操作类 control 工具共用的类型与小函数。
 *
 * move / pin / delete / export / fork / open-in-new-window / branches 这组工具对应
 * GUI 会话菜单里的同名操作,host 侧一律复用主进程既有的业务路径(sessions:update /
 * session-share / fork),这里只放工具层共享的批次护栏与 payload 映射。
 */

import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { errorPayload, type ToolPayloadResult } from './_payload.js';

export const SESSION_OPS_MAX_BATCH = 50;

/** host 回传的会话摘要行(与 archive_sessions 的 changed 项同款字段)。 */
export interface SessionOpItem {
  sessionId: string;
  title: string | null;
  workingDir: string | null;
  workspaceKind: 'project' | 'dialogue';
  status: string;
}

export type SessionOpErrorCode =
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'INVALID_ARGS'
  | 'HOST_NOT_READY'
  | 'INTERNAL';

export type SessionOpResult<T extends object> = ControlResult<T, SessionOpErrorCode>;

export function dedupeSessionIds(ids: string[]): { ids: string[]; duplicate: string | null } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) return { ids: out, duplicate: id };
    seen.add(id);
    out.push(id);
  }
  return { ids: out, duplicate: null };
}

export function sessionOpItemToPayload(item: SessionOpItem): Record<string, unknown> {
  return {
    session_id: item.sessionId,
    title: item.title,
    working_dir: item.workingDir,
    workspace_kind: item.workspaceKind,
    status: item.status,
  };
}

/** host 失败码 → 工具 errorPayload;HOST_NOT_READY 统一换成可转述的提示。 */
export function hostErrorPayload(
  result: { errorCode: string; message: string },
  brandName: string,
  data: Record<string, unknown> = {},
): ToolPayloadResult {
  if (result.errorCode === 'HOST_NOT_READY') {
    return errorPayload(
      'HOST_NOT_READY',
      `${brandName} 主进程会话服务尚未就绪。请告知用户稍等几秒后重试。`,
      data,
    );
  }
  return errorPayload(result.errorCode, result.message, data);
}
