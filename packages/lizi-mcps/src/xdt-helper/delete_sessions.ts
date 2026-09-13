/**
 * xdt-helper/delete_sessions.ts —— 批量删除 session(control 类,dry-run 两段式)。
 *
 * 对应 GUI 会话菜单的「删除」。GUI 删除前弹确认框并提示「有未提交改动的 worktree」;
 * 工具侧的对应物是 dry_run 预览(含 dirty_worktree 标记)+ confirmation_token,真正删除
 * 必须回传同一批 id 对应的 token。host 侧走 sessions:update 业务体写 status=deleted:
 * 软删除,与 GUI 同一条路径(worktree 回收、运行时清理、sessions:patched 广播)。
 *
 * 守卫(host 逐条校验,任一不过整批不写):远程会话、运行中(含协同 worker 运行中)、
 * 被 IM 接管中不允许;已删除的直接 PRECONDITION_FAILED。工具层不允许删除当前 session 自己。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { decodeConfirmationToken, encodeConfirmationToken } from './_confirmation_token.js';
import { errorPayload, okPayload } from './_payload.js';
import {
  SESSION_OPS_MAX_BATCH,
  dedupeSessionIds,
  hostErrorPayload,
  sessionOpItemToPayload,
  type SessionOpItem,
  type SessionOpResult,
} from './_session_ops.js';

export interface DeleteSessionPreviewItem extends SessionOpItem {
  /** 该会话绑定的托管 worktree 有未提交改动(删除会回收 worktree)。 */
  dirtyWorktree: boolean;
}

/**
 * dryRun=true:只做守卫校验并返回预览;dryRun=false:守卫通过后逐个软删除。
 * 中途失败返回 INTERNAL,items 为已完成部分。
 */
export type DeleteSessionsResult = SessionOpResult<{ items: DeleteSessionPreviewItem[] }>;

export interface DeleteSessionsDeps {
  getSessionContext(): LiziMcpSessionContext;
  deleteSessions(params: { sessionIds: string[]; dryRun: boolean }): Promise<DeleteSessionsResult>;
}

interface DeleteConfirmationPayload {
  v: 1;
  sessionIds: string[];
}

function isDeleteConfirmationPayload(payload: unknown): payload is DeleteConfirmationPayload {
  const p = payload as Partial<DeleteConfirmationPayload> | null;
  return (
    !!p &&
    p.v === 1 &&
    Array.isArray(p.sessionIds) &&
    p.sessionIds.every((id) => typeof id === 'string')
  );
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

const DESCRIPTION =
  `批量删除 ${BRAND_NAME} 历史对话/session(软删除:从侧栏移除并回收托管 worktree;` +
  '不同于归档,删除不提供恢复入口)。等价于侧栏菜单的「删除」。' +
  '必须先 dry_run=true 预览待删列表(含 dirty_worktree 标记:有未提交改动的 worktree 会一并回收),' +
  '把结果核对给用户并取得同意后,再以 dry_run=false + 同一批 id 对应的 confirmation_token 真正删除。' +
  '限制:远程会话、运行中(含协同 worker 运行中)、被 IM 接管中不能删除;不能删除当前 session 自己。' +
  '想只是整理侧栏请优先用 archive_sessions。' +
  '失败码: NOT_FOUND(某些 id 不存在,整批不写) / PRECONDITION_FAILED(被守卫拦下或已删除,整批不写) / ' +
  'INVALID_ARGS(含 token 不匹配) / NO_SESSION_CONTEXT / HOST_NOT_READY / INTERNAL(途中失败,data.items 为已删部分)。';

function toPreviewPayload(item: DeleteSessionPreviewItem): Record<string, unknown> {
  return { ...sessionOpItemToPayload(item), dirty_worktree: item.dirtyWorktree };
}

export function registerDeleteSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: DeleteSessionsDeps,
): void {
  registry.register({
    name: 'delete_sessions',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      session_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(SESSION_OPS_MAX_BATCH)
        .describe(`要删除的 session id 列表。一次最多 ${SESSION_OPS_MAX_BATCH} 个。`),
      dry_run: z
        .boolean()
        .default(true)
        .describe('true(默认)只预览并返回 confirmation_token;false 真正删除,必须同时传 token。'),
      confirmation_token: z
        .string()
        .optional()
        .describe('dry_run=false 时必填:上一次 dry_run 对同一批 session_ids 返回的 token。'),
    },
    handler: async ({ session_ids, dry_run, confirmation_token }) => {
      const { ids, duplicate } = dedupeSessionIds(session_ids);
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
      if (ids.includes(ctx.sessionId)) {
        return errorPayload(
          'INVALID_ARGS',
          '不能删除当前正在运行的 session 自己。请把它从 session_ids 里去掉。',
        );
      }
      if (!dry_run) {
        const payload = confirmation_token
          ? decodeConfirmationToken(confirmation_token, isDeleteConfirmationPayload)
          : null;
        if (!payload || !sameIds(payload.sessionIds, ids)) {
          return errorPayload(
            'INVALID_ARGS',
            'dry_run=false 需要携带同一批 session_ids 对应的 confirmation_token。请先 dry_run=true 预览并向用户确认。',
          );
        }
      }

      const result = await deps.deleteSessions({ sessionIds: ids, dryRun: dry_run });
      if (!result.ok) {
        return hostErrorPayload(result, BRAND_NAME, {
          items:
            (result as { items?: DeleteSessionPreviewItem[] }).items?.map(toPreviewPayload) ?? [],
        });
      }
      if (dry_run) {
        return okPayload({
          dry_run: true,
          count: result.items.length,
          items: result.items.map(toPreviewPayload),
          dirty_worktree_count: result.items.filter((item) => item.dirtyWorktree).length,
          confirmation_token: encodeConfirmationToken({ v: 1, sessionIds: ids }),
          next_step:
            '把待删列表核对给用户,取得同意后再以 dry_run=false + 此 confirmation_token 调用。',
        });
      }
      return okPayload({
        dry_run: false,
        count: result.items.length,
        deleted: result.items.map(toPreviewPayload),
      });
    },
  });
}
