import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { errorPayload, okPayload } from './_payload.js';

export type SetCurrentSessionTitleResult = ControlResult<
  {
    sessionId: string;
    title: string;
  },
  'NOT_FOUND'
>;

export interface SetCurrentSessionTitleDeps {
  getSessionContext: () => {
    sessionId?: string;
    agentKind: 'claude-code' | 'codex';
    workingDir: string;
  };
  setCurrentSessionTitle(params: {
    sessionId: string;
    title: string;
  }): Promise<SetCurrentSessionTitleResult>;
}

const DESCRIPTION =
  `更改当前 ${BRAND_NAME} 对话/session 的标题。只作用于当前 MCP 调用绑定的 session,不能改其它会话。` +
  '适合用户要求“把这个对话改名/标题改成 X”时使用。';

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ');
}

export function registerSetCurrentSessionTitleTool(
  registry: XdtHelperToolRegistry,
  deps: SetCurrentSessionTitleDeps,
): void {
  registry.register({
    name: 'set_current_session_title',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      title: z
        .string()
        .min(1)
        .max(120)
        .describe('新的当前对话标题。建议简短清晰,例如 "PR #263 首页用量面板缓存与展示"。'),
    },
    handler: async ({ title }) => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `当前 MCP 调用没有绑定 ${BRAND_NAME} session,无法修改当前对话标题。`,
        );
      }

      const cleanTitle = normalizeTitle(title);
      if (!cleanTitle) {
        return errorPayload('INVALID_ARGS', 'title 不能是空白字符串。请传入一个非空标题。');
      }

      const result = await deps.setCurrentSessionTitle({
        sessionId: ctx.sessionId,
        title: cleanTitle,
      });

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
        session_id: result.sessionId,
        title: result.title,
      });
    },
  });
}
