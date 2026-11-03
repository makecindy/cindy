import { eq } from 'drizzle-orm';
import type { XdtHelperMcpDeps } from '@cindy/mcps';
import { sessions } from '../localDb/schema.js';
import { broadcastWorktreeChanged, recycleSessionWorktreeForStatusChange } from '../localDb/ipc/sessions.js';
import { prepareTaskWorktree } from '../maker-ipc/handoffWorktree.js';
import { resolveFreshSourceBranch, WorktreeManager } from '../worktree/index.js';
import { withLocalProjectContext } from './createProject.js';

type CreateTaskWorktree = NonNullable<XdtHelperMcpDeps['createTaskWorktree']>;
type CreateTaskWorktreeResult = Awaited<ReturnType<CreateTaskWorktree>>;

/** Host callback for `create_task_worktree`. Concurrent calls from one task share one creation. */
export function createTaskWorktreeHost(): CreateTaskWorktree {
  const inFlight = new Map<string, Promise<CreateTaskWorktreeResult>>();
  const worktree = {
    getForSession: WorktreeManager.getForSession,
    listAll: WorktreeManager.listAll,
    detectCwd: WorktreeManager.detectCwd,
    suggestName: WorktreeManager.suggestName,
    listBranches: WorktreeManager.listBranches,
    resolveCommit: WorktreeManager.revParseCommit,
    // The agent that asked is already running: hand it the directory only once the tree is fully there.
    createWorktree: (req: Parameters<typeof WorktreeManager.createWorktree>[0]) => WorktreeManager.createWorktree(req, { awaitFullCheckout: true }),
    resolveFreshSource: resolveFreshSourceBranch,
  };
  return ({ callerSessionId, repoDir }) => {
    const pending = inFlight.get(callerSessionId);
    if (pending) return pending;
    const run = withLocalProjectContext<Omit<Extract<CreateTaskWorktreeResult, { ok: true }>, 'ok'>>(
      callerSessionId,
      async ({ client, assertCurrent }) => {
        const [caller] = await client.drizzle
          .select({ workingDir: sessions.workingDir, status: sessions.status, source: sessions.source })
          .from(sessions)
          .where(eq(sessions.id, callerSessionId))
          .limit(1);
        assertCurrent();
        if (!caller) {
          return { ok: false, errorCode: 'NO_SESSION_CONTEXT', message: 'The calling task is not available in this account.' };
        }
        const result = await prepareTaskWorktree(worktree, {
          sessionId: callerSessionId,
          caller,
          ...(repoDir ? { repoDir } : {}),
        });
        if (!result.ok) return result;
        if (result.created) {
          // The fetch and checkout can take long. If the account changed or the task ended meanwhile, the
          // status-change recycler already ran without seeing this binding: compensate here.
          let accountChanged = false;
          try { assertCurrent(); } catch { accountChanged = true; }
          if (accountChanged) {
            // This account's database no longer has the task, so the creation-failure path may remove it.
            await WorktreeManager.removeWorktreeForSession(callerSessionId).catch(() => undefined);
            assertCurrent();
          }
          const [after] = await client.drizzle
            .select({ status: sessions.status })
            .from(sessions)
            .where(eq(sessions.id, callerSessionId))
            .limit(1);
          assertCurrent();
          if (after?.status !== 'active') {
            await recycleSessionWorktreeForStatusChange(callerSessionId, after?.status ?? 'deleted');
            if (!after) await WorktreeManager.removeWorktreeForSession(callerSessionId).catch(() => undefined);
            return { ok: false, errorCode: 'PRECONDITION_FAILED', message: 'The task ended while its worktree was being created.' };
          }
        }
        // Desktop windows refresh this task's worktree badge; recycling already follows the binding.
        if (result.created) broadcastWorktreeChanged(callerSessionId);
        return {
          ok: true,
          worktreePath: result.meta.path,
          branch: result.meta.branch,
          baseRepo: result.meta.baseRepo,
          sourceBranch: result.meta.sourceBranch,
          created: result.created,
        };
      },
    ).finally(() => inFlight.delete(callerSessionId));
    inFlight.set(callerSessionId, run);
    return run;
  };
}
