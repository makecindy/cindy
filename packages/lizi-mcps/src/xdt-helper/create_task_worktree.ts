import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type CreateTaskWorktreeCallback = (params: {
  callerSessionId: string;
  /** Repository to branch from when the task's working directory is not the repository itself. */
  repoDir?: string;
  /** Explicit base branch or remote ref to branch the worktree from. */
  baseRef?: string;
}) => Promise<
  ControlResult<
    {
      worktreePath: string;
      branch: string;
      baseRepo: string;
      sourceBranch: string;
      /** False when the task already had a managed worktree; it is returned unchanged. */
      created: boolean;
      /** Set when the remote default branch could not be refreshed, so the base may be out of date. */
      staleBaseReason?: string;
    },
    string
  >
>;

const DESCRIPTION =
  `Create a ${BRAND_NAME}-managed git worktree for the current task and bind it to this task, ` +
  'without restarting or moving the task. It is created at <repo>/.cindy-worktrees/<name> on a new ' +
  'cindy/<name> branch from the freshly fetched remote default branch (when that fetch fails it uses ' +
  "the newest local copy and returns base_fetched=false with a warning), shows as the task's worktree " +
  `in ${BRAND_NAME}, and is removed when the task is archived ` +
  "or deleted. The task's working directory does not change: run commands and edit files inside the " +
  'returned worktree_path. If the task already has a worktree, that one is returned with created=false. ' +
  'Pass repo_dir when the task working directory is not itself the repository. Pass base_ref to branch ' +
  'from a specific branch or remote ref (e.g. "release/2.x" or "origin/release/2.x") instead of the ' +
  'remote default branch; it is resolved against the repository as it currently exists locally, and a ' +
  'ref that does not resolve fails instead of falling back to the default branch. Local tasks only.';

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
      base_ref: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .optional()
        .describe(
          'Branch or remote ref to branch the worktree from, e.g. "release/2.x" or "origin/release/2.x". ' +
            'Defaults to the freshly fetched remote default branch. A ref that does not resolve fails ' +
            'instead of falling back to the default branch.',
        ),
    },
    handler: async ({ repo_dir, base_ref }) => {
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
        ...(base_ref ? { baseRef: base_ref } : {}),
      });
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({
        worktree_path: result.worktreePath,
        branch: result.branch,
        base_repo: result.baseRepo,
        source_branch: result.sourceBranch,
        created: result.created,
        ...(result.staleBaseReason
          ? {
              base_fetched: false,
              warning:
                `Could not refresh the remote default branch (${result.staleBaseReason}). This worktree ` +
                `starts from ${result.sourceBranch} as it exists locally and may be behind the remote. ` +
                'Tell the user, and fetch and merge the remote default branch once the network is available.',
            }
          : {}),
      });
    },
  });
}
