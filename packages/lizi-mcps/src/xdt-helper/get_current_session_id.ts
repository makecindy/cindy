import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface GetCurrentSessionIdDeps {
  getSessionContext: () => {
    sessionId?: string;
    agentKind: 'claude-code' | 'codex' | 'pi';
    workingDir: string;
  };
}

const DESCRIPTION =
  `返回当前 MCP 会话所属的 ${BRAND_NAME} session 的 business id,供 skill 把 sessionId 和外部业务对象(issue/jira/pr 等)的 key 做绑定持久化。` +
  `未绑定具体 ${BRAND_NAME} session 的 MCP 调用会返 NO_SESSION_CONTEXT(skill 应静默回退)。`;

export function registerGetCurrentSessionIdTool(
  registry: XdtHelperToolRegistry,
  deps: GetCurrentSessionIdDeps,
): void {
  registry.register({
    name: 'get_current_session_id',
    category: 'cindy',
    description: DESCRIPTION,
    inputShape: {},
    handler: async () => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `当前 MCP 调用没有绑定 ${BRAND_NAME} session。skill 应静默回退到无 session handoff 的普通流程。`,
        );
      }

      return okPayload({
        session_id: ctx.sessionId,
        agent_kind: ctx.agentKind,
        working_dir: ctx.workingDir,
      });
    },
  });
}
