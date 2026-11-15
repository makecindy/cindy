import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export interface GetCurrentSessionIdDeps {
  /** Read live membership; cwd can point at an unrelated execution worktree. */
  getSessionProject?: (sessionId: string) => Promise<{
    projectDir: string | null;
    workspaceKind: 'project' | 'dialogue';
    remoteHostId: string | null;
  }>;
  getSessionContext: () => {
    sessionId?: string;
    agentKind: 'claude-code' | 'codex' | 'pi';
    workingDir: string;
    vendorOptions?: Record<string, unknown>;
  };
}

const DESCRIPTION =
  `返回当前 MCP 会话所属的 ${BRAND_NAME} session 的 business id,供 skill 把 sessionId 和外部业务对象(issue/jira/pr 等)的 key 做绑定持久化。` +
  '同时返回 project_path（项目归属）与 working_dir（执行目录）。新建任务省略 project_path 即继承来源归属，也可显式传入此 project_path，无需遍历项目；null 表示不绑项目。要选其他项目时用 control/list_projects。remote_host_id 非空表示 SSH 项目，不能作为本机新建任务的项目。不要把 working_dir 当作项目归属。' +
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

      let project: Record<string, unknown> = {};
      if (deps.getSessionProject) {
        try {
          const membership = await deps.getSessionProject(ctx.sessionId);
          project = {
            project_path: membership.projectDir,
            workspace_kind: membership.workspaceKind,
            remote_host_id: membership.remoteHostId,
          };
        } catch {
          // Identity handoff remains usable when project storage is unavailable.
          // Omission means unknown, whereas project_path=null means no project.
          project = { project_lookup_error: '项目归属暂不可用；请用 list_projects 选择项目，不要从 working_dir 推测。' };
        }
      }
      return okPayload({
        session_id: ctx.sessionId,
        agent_kind: ctx.agentKind,
        working_dir: ctx.workingDir,
        ...project,
        ...(ctx.vendorOptions?.orcaRemoteLead ? { orca_remote_lead: ctx.vendorOptions.orcaRemoteLead } : {}),
      });
    },
  });
}
