import fsp from 'node:fs/promises';
import path from 'node:path';

/** Ordinary local directories only; managed Git worktrees keep their own restore path. */
export function createWorkingDirectoryRecovery(io: {
  stat(dir: string): Promise<{ isDirectory(): boolean }>;
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
} = fsp) {
  const pending = new Map<string, { workingDir: string; note: string | null }>();
  return {
    async recover(sessionId: string, workingDir: string, similarPath?: string | null, affectedSessionIds: string[] = []): Promise<boolean> {
      const normalizedDir = path.resolve(workingDir);
      const entries = [...new Set([sessionId, ...affectedSessionIds])].map((id) => {
        const previous = pending.get(id);
        const entry = previous?.workingDir === normalizedDir ? previous : { workingDir: normalizedDir, note: null };
        pending.set(id, entry);
        return { id, entry };
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
        for (const { id, entry } of entries) {
          if (pending.get(id) === entry) entry.note = note;
        }
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
