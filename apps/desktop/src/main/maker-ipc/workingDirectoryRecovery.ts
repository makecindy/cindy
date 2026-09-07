import fsp from 'node:fs/promises';

/** Ordinary local directories only; managed Git worktrees keep their own restore path. */
export function createWorkingDirectoryRecovery(io: {
  stat(dir: string): Promise<{ isDirectory(): boolean }>;
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
} = fsp) {
  const pending = new Map<string, string>();
  return {
    async recover(sessionId: string, workingDir: string): Promise<boolean> {
      try {
        // A stale probe must not mistake a file, permission error, or a directory
        // restored by someone else for a missing directory.
        const stat = await io.stat(workingDir);
        return stat.isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
      try {
        await io.mkdir(workingDir, { recursive: true });
        pending.set(sessionId, [
          '[Working directory recovery]',
          `The working directory was missing. Cindy recreated the directory at ${JSON.stringify(workingDir)} so this conversation can continue.`,
          'Only the directory was recreated; its previous files have not been recovered. Do not assume the original project contents are available.',
          'Continue responding to the user. If their task needs the missing files, investigate the location or recovery options, or ask the user through the conversation. Do not require a folder-selection interface just to continue chatting.',
        ].join('\n'));
        return true;
      } catch {
        return false;
      }
    },
    peek(sessionId: string): string | null {
      return pending.get(sessionId) ?? null;
    },
    consume(sessionId: string, expectedNote: string): void {
      if (pending.get(sessionId) === expectedNote) pending.delete(sessionId);
    },
  };
}
