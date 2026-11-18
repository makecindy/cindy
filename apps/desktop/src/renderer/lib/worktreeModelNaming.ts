import { getWorktreeModelNamingEnabled } from '@/hooks/useWorktreeModelNamingPreference';
import { createLogger } from '@/lib/logger';

const log = createLogger('worktreeModelNaming');

/**
 * Name for a new task's worktree. With the personalization option off this is the
 * already generated random name, unchanged. With it on, this computer's auxiliary model
 * names the worktree after the task text; any failure keeps the generated name. Main
 * bounds the wait, validates the result, and creation still resolves collisions.
 */
export async function resolveTaskWorktreeName(taskText: string, generatedName: string): Promise<string> {
  if (!getWorktreeModelNamingEnabled() || !taskText.trim()) return generatedName;
  try {
    const resp = await window.electronAPI.worktreeGenerateName({ taskText });
    const name = typeof resp?.name === 'string' ? resp.name.trim() : '';
    return name || generatedName;
  } catch (err) {
    log.warn('model worktree naming failed; keeping the generated name', err);
    return generatedName;
  }
}
