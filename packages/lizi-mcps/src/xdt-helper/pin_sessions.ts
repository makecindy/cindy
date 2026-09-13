/**
 * xdt-helper/pin_sessions.ts —— 批量置顶 / 取消置顶 session(control 类)。
 *
 * 对应 GUI 会话菜单的「置顶」「取消置顶」。host 侧走 sessions:update 业务体
 * (updateSessionInDb)写 pinnedAt,并广播 sessions:patched。置顶只是侧栏排序偏好,
 * 可逆、不删数据;已归档 / 已删除的会话不能置顶(GUI 不提供入口)。
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

export type SetSessionsPinnedResult = SessionOpResult<{ changed: SessionOpItem[] }>;

export interface PinSessionsDeps {
  getSessionContext(): LiziMcpSessionContext;
  setSessionsPinned(params: {
    sessionIds: string[];
    pinned: boolean;
  }): Promise<SetSessionsPinnedResult>;
}

const PIN_DESCRIPTION =
  `批量置顶 ${BRAND_NAME} 历史对话/session(侧栏置顶区)。可逆,要取消用 unpin_sessions。` +
  '已归档 / 已删除的会话不能置顶。建议先用 history/list_sessions 找到目标 session_id。' +
  '失败码: NOT_FOUND(某些 id 不存在,整批不写) / PRECONDITION_FAILED(已归档或已删除,整批不写) / ' +
  'INVALID_ARGS / NO_SESSION_CONTEXT / HOST_NOT_READY / INTERNAL。';

const UNPIN_DESCRIPTION =
  `批量取消置顶 ${BRAND_NAME} 历史对话/session。是 pin_sessions 的逆操作。` +
  '失败码: NOT_FOUND / PRECONDITION_FAILED / INVALID_ARGS / NO_SESSION_CONTEXT / HOST_NOT_READY / INTERNAL。';

function registerPinnedTool(
  registry: XdtHelperToolRegistry,
  deps: PinSessionsDeps,
  config: { name: 'pin_sessions' | 'unpin_sessions'; description: string; pinned: boolean },
): void {
  registry.register({
    name: config.name,
    category: 'control',
    description: config.description,
    inputShape: {
      session_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(SESSION_OPS_MAX_BATCH)
        .describe(
          `要${config.pinned ? '置顶' : '取消置顶'}的 session id 列表。一次最多 ${SESSION_OPS_MAX_BATCH} 个。`,
        ),
    },
    handler: async ({ session_ids }) => {
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
      const result = await deps.setSessionsPinned({ sessionIds: ids, pinned: config.pinned });
      if (!result.ok) return hostErrorPayload(result, BRAND_NAME);
      return okPayload({
        pinned: config.pinned,
        count: result.changed.length,
        changed: result.changed.map(sessionOpItemToPayload),
      });
    },
  });
}

export function registerPinSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: PinSessionsDeps,
): void {
  registerPinnedTool(registry, deps, {
    name: 'pin_sessions',
    description: PIN_DESCRIPTION,
    pinned: true,
  });
}

export function registerUnpinSessionsTool(
  registry: XdtHelperToolRegistry,
  deps: PinSessionsDeps,
): void {
  registerPinnedTool(registry, deps, {
    name: 'unpin_sessions',
    description: UNPIN_DESCRIPTION,
    pinned: false,
  });
}
