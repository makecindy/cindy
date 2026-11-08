import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type CreateTaskWorktreeCallback = (params: {
  callerSessionId: string;
  /** Repository to branch from when the task's working directory is not the repository itself. */
  repoDir?: string;
}) => Promise<
  ControlResult<
    {
      worktreePath: string;
      branch: string;
      baseRepo: string;
      sourceBranch: string;
      /** False when the task already had a managed worktree; it is returned unchanged. */
      created: boolean;
    },
    string
  >
>;

const DESCRIPTION =
  `Create a ${BRAND_NAME}-managed git worktree for the current task and bind it to this task, ` +
  'without restarting or moving the task. It is created at <repo>/.cindy-worktrees/<name> on a new ' +
  'cindy/<name> branch from the freshly fetched remote default branch (the current branch when ' +
  `offline), shows as the task's worktree in ${BRAND_NAME}, and is removed when the task is archived ` +
  "or deleted. The task's working directory does not change: run commands and edit files inside the " +
  'returned worktree_path. If the task already has a worktree, that one is returned with created=false. ' +
  'Pass repo_dir when the task working directory is not itself the repository. Local tasks only.';

export function registerCreateTaskWorktreeTool(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    createTaskWorktree: CreateTaskWorktreeCallback;
  },
): void {
  registry.register({
    name: 'create_task_worktree',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      repo_dir: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .optional()
        .describe('Absolute path of the Git repository to branch from. Defaults to the task working directory.'),
    },
    handler: async ({ repo_dir }) => {
      const context = deps.getSessionContext();
      if (!context.sessionId)
        return errorPayload('NO_SESSION_CONTEXT', `No ${BRAND_NAME} task is bound to this call.`);
      if (context.remoteHostId)
        return errorPayload('UNSUPPORTED_CAPABILITY', 'Task worktrees can only be created for local tasks.');
      // The worktree belongs to the task; a subagent must not bind one on the parent's behalf.
      if (context.mcpCallerKind === 'descendant')
        return errorPayload('ROOT_REQUIRED', 'Ask the parent agent to create the task worktree.');
      const result = await deps.createTaskWorktree({
        callerSessionId: context.sessionId,
        ...(repo_dir ? { repoDir: repo_dir } : {}),
      });
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({
        worktree_path: result.worktreePath,
        branch: result.branch,
        base_repo: result.baseRepo,
        source_branch: result.sourceBranch,
        created: result.created,
      });
    },
  });
}
