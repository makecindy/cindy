import type { AgentEvent } from '@cindy/maker-core';
import { isTerminalAgentErrorEvent } from '@cindy/maker-core';
import { isTurnContinuationBoundaryEvent } from '@cindy/maker-shared/turn-continuation';
import type { CindyMakeCompletionMeta } from '../../shared/cindyMakeSession.js';

/** The slice of a live maker Session the tracker needs; kept narrow for tests. */
export interface CindyMakeCompletionSession {
  onEvent(listener: (event: AgentEvent) => void): () => void;
  isTurnRunning(): boolean;
}

export interface CindyMakeCompletionTrackerDeps {
  getSession: (sessionId: string) => CindyMakeCompletionSession | undefined;
  /** Commit the task worktree and return code-verified facts; failures degrade to an empty object. */
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

export const CINDY_MAKE_COMMIT_AUTHOR = 'Cindy Make';
export const CINDY_MAKE_COMMIT_EMAIL = 'cindy-make@localhost';

const LINE_BREAK = /\r?\n/;

/**
 * Commit everything the agent changed in the task worktree and return the facts
 * the completion card shows. The identity is fixed so the commit never depends
 * on the user's global Git configuration. Each Git answer is optional so one
 * failing command does not hide the others.
 */
export async function commitCindyMakeChanges(
  git: (args: string[]) => Promise<string>,
  message: string,
): Promise<Omit<CindyMakeCompletionMeta, 'reportedAt'>> {
  const facts: Omit<CindyMakeCompletionMeta, 'reportedAt'> = {};
  try {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch && branch !== 'HEAD') facts.branch = branch;
  } catch {
    // Reported without a branch.
  }
  try {
    const status = await git(['status', '--porcelain', '--untracked-files=all']);
    facts.changedFiles = status.split(LINE_BREAK).filter((line) => line.trim().length > 0).length;
    if (facts.changedFiles > 0) {
      await git(['add', '--all']);
      await git([
        '-c',
        `user.name=${CINDY_MAKE_COMMIT_AUTHOR}`,
        '-c',
        `user.email=${CINDY_MAKE_COMMIT_EMAIL}`,
        'commit',
        '--quiet',
        '--no-verify',
        '--message',
        message,
      ]);
    }
  } catch {
    // Reported without a count; HEAD below still tells which commit the task is on.
  }
  try {
    const commit = (await git(['rev-parse', 'HEAD'])).trim();
    if (/^[0-9a-f]{7,64}$/i.test(commit)) facts.commit = commit;
  } catch {
    // Reported without a commit.
  }
  return facts;
}
