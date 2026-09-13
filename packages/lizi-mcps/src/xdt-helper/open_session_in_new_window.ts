/**
 * xdt-helper/open_session_in_new_window.ts —— 在新的应用窗口里打开一个 session(control 类)。
 *
 * 对应 GUI 会话菜单的「在新窗口打开」。纯本机 UI 动作,复用 main/secondary-windows 的
 * 窗口生命周期;远程(device-link)会话在本地库里不存在,返回 NOT_FOUND。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { hostErrorPayload } from './_session_ops.js';

export type OpenSessionInNewWindowResult = ControlResult<
  { sessionId: string; title: string | null },
  'NOT_FOUND' | 'PRECONDITION_FAILED' | 'HOST_NOT_READY' | 'INTERNAL'
>;

export interface OpenSessionInNewWindowDeps {
  getSessionContext(): LiziMcpSessionContext;
  openSessionInNewWindow(params: { sessionId: string }): Promise<OpenSessionInNewWindowResult>;
}

const DESCRIPTION =
  `把一个 ${BRAND_NAME} 会话在一个完整的新应用窗口里打开(等价于侧栏菜单的「在新窗口打开」),` +
  '便于用户同时盯多个会话。只作用于本机桌面端窗口。' +
  '失败码: NOT_FOUND / PRECONDITION_FAILED(已删除) / HOST_NOT_READY / INTERNAL。';

export function registerOpenSessionInNewWindowTool(
  registry: XdtHelperToolRegistry,
  deps: OpenSessionInNewWindowDeps,
): void {
  registry.register({
    name: 'open_session_in_new_window',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      session_id: z.string().min(1).describe('要在新窗口打开的 session id。'),
    },
    handler: async ({ session_id }) => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `本次 MCP 调用没有绑定 ${BRAND_NAME} session。`,
        );
      }
      const result = await deps.openSessionInNewWindow({ sessionId: session_id });
      if (!result.ok) return hostErrorPayload(result, BRAND_NAME);
      return okPayload({ session_id: result.sessionId, title: result.title });
    },
  });
}
