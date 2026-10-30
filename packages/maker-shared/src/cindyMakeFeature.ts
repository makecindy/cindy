/**
 * Product gate for Cindy Make.
 *
 * Cindy Make remains on disk so existing source checkouts, history and personal
 * builds are not removed, but the product surface is currently unavailable to
 * users. Keep this value shared by desktop and mobile so a build cannot expose
 * one client while hiding the other.
 */
export const CINDY_MAKE_ENABLED = false;

export function isCindyMakeSource(source: string | null | undefined): boolean {
  return source === 'cindy-make' || source === 'cindy-make-merge';
}

export type SourceConfirmedSharedTask<Task> = Task & { source: string | null };

type SharedTaskSessionSource = { id: string; source?: string | null };

export async function filterCindyMakeSharedTasks<Task extends { sessionId: string }>(
  tasks: readonly Task[],
  options: {
    knownSession(task: Task): SharedTaskSessionSource | null | undefined;
    readSession(task: Task): Promise<SharedTaskSessionSource | null | undefined>;
    isCurrent(): boolean;
    onHiddenTask?(task: Task): Promise<void>;
    onHiddenTaskError?(task: Task, error: unknown): void;
  },
): Promise<SourceConfirmedSharedTask<Task>[]> {
  const hide = async (task: Task) => {
    try {
      if (options.isCurrent()) await options.onHiddenTask?.(task);
    } catch (error) {
      if (options.isCurrent()) {
        try {
          options.onHiddenTaskError?.(task, error);
        } catch {
          return null;
        }
      }
    }
    return null;
  };
  const confirmed = await Promise.all(tasks.map(async (task): Promise<{ task: Task; source: string | null } | null> => {
    if (!options.isCurrent()) return null;
    const known = options.knownSession(task);
    if (CINDY_MAKE_ENABLED) return { task, source: known?.source ?? null };
    if (known?.id === task.sessionId && known.source !== undefined) {
      return isCindyMakeSource(known.source) ? hide(task) : { task, source: known.source };
    }
    let session: SharedTaskSessionSource | null | undefined;
    try {
      session = await options.readSession(task);
    } catch {
      return null;
    }
    if (!options.isCurrent() || session?.id !== task.sessionId) return null;
    const latest = options.knownSession(task);
    const source = latest?.id === task.sessionId && latest.source !== undefined
      ? latest.source : session.source ?? null;
    return isCindyMakeSource(source) ? hide(task) : { task, source };
  }));
  return options.isCurrent() ? confirmed.flatMap(result => result ? [{ ...result.task, source: result.source }] : []) : [];
}
