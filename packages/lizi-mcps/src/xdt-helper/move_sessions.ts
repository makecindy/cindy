/**
 * xdt-helper/move_sessions.ts —— 批量把 session 移动到某个项目 / 移回对话(control 类)。
 *
 * 对应 GUI 会话菜单的「移动到项目」「移动到对话」。host 侧走 sessions:update 的业务体
 * (updateSessionInDb):路由锁、cc 转录目录搬迁、Pi/Codex runtime 关闭、recent-workdir
 * 维护与 sessions:patched 广播全部复用,侧栏即时收敛。
 *
 * 守卫(与 GUI 同口径,由 host 逐条校验,任一不过整批不写):
 *  - 远程(SSH / device-link)会话不支持;
 *  - 运行中(含 Orca lead 下任一 worker 运行中)不允许;
 *  - 被 IM 接管中不允许;
 *  - 已归档 / 已删除、空草稿、review 会话不允许。
 * 工具层额外不允许移动当前正在运行的这个 session 自己。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import {
  SESSION_OPS_MAX_BATCH,
  dedupeSessionIds,
  hostErrorPayload,
  sessionOpItemToPayload,
  type SessionOpItem,
  type SessionOpResult,
} from './_session_ops.js';

export type SessionMoveTarget =
  | { kind: 'project'; workingDir: string }
  | { kind: 'dialogue' };

/**
 * host 回调:全部守卫通过后逐个应用。`moved` 为已成功移动的会话;中途失败时 host 返回
 * INTERNAL 并把已完成部分放进 partial(工具层原样透传给模型,便于如实汇报)。
 */
export type MoveSessionsResult = SessionOpResult<{ moved: SessionOpItem[] }>;

export interface MoveSessionsDeps {
  getSessionContext(): LiziMcpSessionContext;
  moveSessions(params: {
    sessionIds: string[];
    target: SessionMoveTarget;
  }): Promise<MoveSessionsResult>;
}

const DESCRIPTION =
  `批量把 ${BRAND_NAME} 历史对话/session 移动到某个项目目录(target_kind=project + working_dir),` +
  '或移回不属于任何项目的「对话」(target_kind=dialogue)。等价于侧栏菜单的「移动到项目 / 移动到对话」,' +
  '主进程会同步搬迁 agent 转录目录并即时刷新侧栏。' +
  '限制:远程会话、运行中(含协同 worker 运行中)、被 IM 接管中、已归档、空草稿、review 会话都不能移动;' +
  '不能移动当前正在运行的 session 自己。建议先用 history/list_sessions 找到目标 session_id。' +
  '失败码: NOT_FOUND(某些 id 不存在,整批不写) / PRECONDITION_FAILED(某个会话被上述守卫拦下,整批不写) / ' +
  'INVALID_ARGS / NO_SESSION_CONTEXT / HOST_NOT_READY / INTERNAL(逐个应用途中失败,data.moved 为已完成部分)。';

export function registerMoveSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: MoveSessionsDeps,
): void {
  registry.register({
    name: 'move_sessions',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      session_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(SESSION_OPS_MAX_BATCH)
        .describe(`要移动的 session id 列表。一次最多 ${SESSION_OPS_MAX_BATCH} 个。`),
      target_kind: z
        .enum(['project', 'dialogue'])
        .describe('project = 移动到 working_dir 指定的项目;dialogue = 移回对话(不属于任何项目)。'),
      working_dir: z
        .string()
        .min(1)
        .optional()
        .describe('target_kind=project 时必填:目标项目目录的绝对路径,须已存在。'),
    },
    handler: async ({ session_ids, target_kind, working_dir }) => {
      const { ids, duplicate } = dedupeSessionIds(session_ids);
      if (duplicate) {
        return errorPayload('INVALID_ARGS', `同一次调用里 session_id 重复: ${duplicate}。`);
      }
      if (target_kind === 'project' && !working_dir) {
        return errorPayload('INVALID_ARGS', 'target_kind=project 时必须提供 working_dir。');
      }
      if (target_kind === 'dialogue' && working_dir) {
        return errorPayload('INVALID_ARGS', 'target_kind=dialogue 时不要传 working_dir。');
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
          '不能移动当前正在运行的 session 自己。请把它从 session_ids 里去掉,或让用户在侧栏菜单里操作。',
        );
      }

      const target: SessionMoveTarget =
        target_kind === 'project'
          ? { kind: 'project', workingDir: working_dir as string }
          : { kind: 'dialogue' };
      const result = await deps.moveSessions({ sessionIds: ids, target });
      if (!result.ok) {
        return hostErrorPayload(result, BRAND_NAME, {
          moved: (result as { moved?: SessionOpItem[] }).moved?.map(sessionOpItemToPayload) ?? [],
        });
      }
      return okPayload({
        target_kind,
        working_dir: target_kind === 'project' ? working_dir : null,
        count: result.moved.length,
        moved: result.moved.map(sessionOpItemToPayload),
      });
    },
  });
}
