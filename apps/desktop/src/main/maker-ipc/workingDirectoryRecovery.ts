import fsp from 'node:fs/promises';
import path from 'node:path';

/** Ordinary local directories only; managed Git worktrees keep their own restore path. */
export function createWorkingDirectoryRecovery(io: {
  stat(dir: string): Promise<{ isDirectory(): boolean }>;
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  realpath?(dir: string): Promise<string>;
} = fsp) {
  const pending = new Map<string, { workingDir: string; note: string | null }>();
  return {
    async recover(sessionId: string, workingDir: string, similarPath?: string | null, candidates: { id: string; workingDir: string }[] = []): Promise<boolean> {
      const sessions = new Map(candidates.map((session) => [session.id, session.workingDir]));
      sessions.set(sessionId, workingDir);
      const entries = [...sessions].map(([id, dir]) => {
        const previous = pending.get(id);
        // Preserve unrelated recovery notes until physical identity is known.
        const entry = previous ?? { workingDir: path.resolve(dir), note: null };
        pending.set(id, entry);
        return { id, dir, entry };
      });
      try {
        // A stale probe must not mistake a file, permission error, or a directory
        // restored by someone else for a missing directory.
        try {
          const stat = await io.stat(workingDir);
          return stat.isDirectory();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        }
        await io.mkdir(workingDir, { recursive: true });
        const canonical = await io.realpath?.(workingDir).catch(() => null);
        // Cleanup may have removed this entry while filesystem IO was pending.
        // Do not repopulate it after a clear, archive, delete, or owner change.
        const note = [
          '[Working directory recovery]',
          `The working directory was missing. Cindy recreated the directory at ${JSON.stringify(workingDir)} so this conversation can continue.`,
          'Only the directory was recreated; its previous files have not been recovered. Do not assume the original project contents are available.',
          ...(similarPath ? [
            `A similarly named filesystem entry exists at ${JSON.stringify(similarPath)} (possibly differing only in whitespace or case). Inspect this candidate before reading or creating project files in the recreated directory. It may contain the original project; verify its identity or ask the user before treating it as their workspace.`,
          ] : []),
          'Continue responding to the user. If their task needs the missing files, investigate the location or recovery options, or ask the user through the conversation. Do not require a folder-selection interface just to continue chatting.',
        ].join('\n');
        await Promise.all(entries.map(async ({ id, dir, entry }) => {
          const matches = path.resolve(dir) === path.resolve(workingDir) ||
            (canonical != null && await io.realpath?.(dir).catch(() => null) === canonical);
          if (matches && pending.get(id) === entry) {
            pending.set(id, { workingDir: path.resolve(dir), note });
          }
        }));
        return true;
      } catch {
        return false;
      }
    },
    peek(sessionId: string, workingDir?: string): string | null {
      const entry = pending.get(sessionId);
      if (entry && workingDir !== undefined && entry.workingDir !== path.resolve(workingDir)) {
        pending.delete(sessionId);
        return null;
      }
      return entry?.note ?? null;
    },
    consume(sessionId: string, expectedNote: string): void {
      if (pending.get(sessionId)?.note === expectedNote) pending.delete(sessionId);
    },
    discard(sessionId: string): void {
      pending.delete(sessionId);
    },
    clear(): void {
      pending.clear();
    },
  };
}
