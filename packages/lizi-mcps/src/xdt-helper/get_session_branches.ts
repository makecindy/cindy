/**
 * xdt-helper/get_session_branches.ts —— 查看一个 session 所在的分叉家族(control 类,只读)。
 *
 * 对应 GUI 会话头菜单的「会话分支」。家族 = 顺着 parentSessionId 找到根,再收集根下
 * 全部派生会话;每项带 parent_session_id / forked_at_message_id,足够还原分支树。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { hostErrorPayload, sessionOpItemToPayload, type SessionOpItem } from './_session_ops.js';

export interface SessionBranchItem extends SessionOpItem {
  parentSessionId: string | null;
  forkedAtMessageId: string | null;
  createdAt: number;
}

export type GetSessionBranchesResult = ControlResult<
  { rootSessionId: string; family: SessionBranchItem[] },
  'NOT_FOUND' | 'HOST_NOT_READY' | 'INTERNAL'
>;

export interface GetSessionBranchesDeps {
  getSessionContext(): LiziMcpSessionContext;
  getSessionBranches(params: { sessionId: string }): Promise<GetSessionBranchesResult>;
}

const DESCRIPTION =
  `查看一个 ${BRAND_NAME} 会话所在的分叉家族(等价于会话菜单的「会话分支」):返回根会话与` +
  '全部派生会话,每项带 parent_session_id 与 forked_at_message_id,可据此还原分支树。' +
  '只读。家族里只有它自己时 family 只有一项。' +
  '失败码: NOT_FOUND / HOST_NOT_READY / INTERNAL。';

export function registerGetSessionBranchesTool(
  registry: XdtHelperToolRegistry,
  deps: GetSessionBranchesDeps,
): void {
  registry.register({
    name: 'get_session_branches',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      session_id: z.string().min(1).describe('家族里任意一个 session 的 id。'),
    },
    handler: async ({ session_id }) => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `本次 MCP 调用没有绑定 ${BRAND_NAME} session,无法访问会话数据。`,
        );
      }
      const result = await deps.getSessionBranches({ sessionId: session_id });
      if (!result.ok) return hostErrorPayload(result, BRAND_NAME);
      return okPayload({
        session_id,
        root_session_id: result.rootSessionId,
        count: result.family.length,
        family: result.family.map((item) => ({
          ...sessionOpItemToPayload(item),
          parent_session_id: item.parentSessionId,
          forked_at_message_id: item.forkedAtMessageId,
          created_at: new Date(item.createdAt).toISOString(),
        })),
      });
    },
  });
}
