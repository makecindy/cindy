import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { contentRef, taskCommitRef, taskContentRef, type ContentGit } from './sourceContent.js';
import { commitLocalFiles } from './localHistory.js';
import { makeTaskBranch, makeSourceCheckoutPath, isCindyMakeWorktreePath } from './sourcePaths.js';
import type { AgentEvent } from '@cindy/maker-core';
import { isTerminalAgentErrorEvent } from '@cindy/maker-core';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import { isSuccessfulAssistantReplyDoneData } from '../cindy-brain/assistantReplyHook.js';
import type { CindyMakeCompletionMeta } from '../../shared/cindyMakeSession.js';

/** The slice of a live maker Session the tracker needs; kept narrow for tests. */
export interface CindyMakeCompletionSession {
  onEvent(listener: (event: AgentEvent) => void): () => void;
  isTurnRunning(): boolean;
}

export interface CindyMakeCompletionTrackerDeps {
  getSession: (sessionId: string) => CindyMakeCompletionSession | undefined;
  /** Commit completed task files locally and return verified facts; failures degrade to an empty object. */
  collectFacts: (sessionId: string) => Promise<Omit<CindyMakeCompletionMeta, 'reportedAt'>>;
  persist: (sessionId: string, meta: CindyMakeCompletionMeta) => Promise<void>;
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  now?: () => number;
}

export interface CindyMakeCompletionTracker {
  /**
   * Called from the `report_complete` tool. The completion card is persisted
   * only after the current product turn ends, so it always lands below the
   * model's final reply instead of at the tool-call position. Idempotent per turn.
   */
  report: (sessionId: string) => Promise<void>;
  /** Whether a completion is waiting for the current turn of this session to end. */
  isPending: (sessionId: string) => boolean;
}

function isProductTurnEnd(event: AgentEvent): boolean {
  if (event.type === 'done') return !isTurnContinuationBoundaryEvent(event);
  return isTerminalAgentErrorEvent(event);
}

export function createCindyMakeCompletionTracker(
  deps: CindyMakeCompletionTrackerDeps,
): CindyMakeCompletionTracker {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, () => void>();

  const finish = async (sessionId: string): Promise<void> => {
    pending.get(sessionId)?.();
    pending.delete(sessionId);
    let facts: Omit<CindyMakeCompletionMeta, 'reportedAt'> = {};
    try {
      facts = await deps.collectFacts(sessionId);
    } catch (error) {
      deps.logger.warn('cindy_make completion facts unavailable', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await deps.persist(sessionId, { ...facts, reportedAt: now() });
  };

  return {
    isPending: (sessionId) => pending.has(sessionId),
    report: async (sessionId) => {
      if (pending.has(sessionId)) return;
      const session = deps.getSession(sessionId);
      // No live turn to wait for: the record cannot be ordered after a reply
      // that will never come, so persist right away rather than never.
      if (!session || !session.isTurnRunning()) {
        await finish(sessionId);
        return;
      }
      const off = session.onEvent((event) => {
        if (!isProductTurnEnd(event) || !pending.has(sessionId)) return;
        if (event.type !== 'done' || !isSuccessfulAssistantReplyDoneData(event.data)) {
          pending.get(sessionId)?.();
          pending.delete(sessionId);
          return;
        }
        void finish(sessionId).catch((error) => {
          deps.logger.warn('cindy_make completion persist failed', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
      pending.set(sessionId, off);
    },
  };
}

/** Finalize this managed task locally; personal/main branches are untouched. */
export async function collectCindyMakeChanges(
  git: ContentGit,
  userData: string,
  worktree: string,
): Promise<Omit<CindyMakeCompletionMeta, 'reportedAt'>> {
  const runId = path.basename(worktree);
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree)).trim();
  const samePath = (a: string, b: string) =>
    process.platform === 'win32'
      ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
      : path.resolve(a) === path.resolve(b);
  if (
    !isCindyMakeWorktreePath(userData, worktree) ||
    branch !== makeTaskBranch(runId) ||
    !samePath(await realpath(worktree), worktree) ||
    !samePath(
      (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree)).trim(),
      await realpath(path.join(makeSourceCheckoutPath(userData), '.git')),
    )
  )
    throw new Error('Unexpected Cindy Make worktree');
  const { commit, tree } = await commitLocalFiles(
    git,
    worktree,
    'Cindy Make: complete personal change',
  );
  await git(['update-ref', taskContentRef(runId, 'complete'), tree], worktree);
  await git(['update-ref', taskCommitRef(runId), commit], worktree);
  const base = await contentRef(git, worktree, taskContentRef(runId, 'base'));
  const changes = base
    ? await git(['diff', '--name-only', '-z', '--no-renames', base, tree, '--'], worktree)
    : await git(['status', '--porcelain', '-z', '--untracked-files=all'], worktree);
  return {
    branch,
    commit,
    tree,
    ...(base ? { baseTree: base } : {}),
    changedFiles: changes.split('\u0000').filter(Boolean).length,
  };
}
