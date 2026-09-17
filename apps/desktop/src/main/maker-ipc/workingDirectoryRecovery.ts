import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  workdirDiagnosticContext, workdirDiagnosticErrorCode, workdirDiagnosticId,
  type WorkdirDiagnosticLogger,
} from '../workdirDiagnostics';

export function isUnavailableFilesystemError(error: unknown): boolean {
  return ['EIO', 'ENOTCONN', 'ENODEV', 'ESTALE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'WORKDIR_PROBE_TIMEOUT']
    .includes((error as NodeJS.ErrnoException | null)?.code ?? '');
}

/** Ordinary local directories only; managed Git worktrees keep their own restore path. */
export function createWorkingDirectoryRecovery(io: {
  stat(dir: string): Promise<{ isDirectory(): boolean; dev?: number }>;
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  realpath?(dir: string): Promise<string>;
} = fsp, allocateFallback?: (sessionId: string) => Promise<string>, log?: WorkdirDiagnosticLogger) {
  const pending = new Map<string, { workingDir: string; note: string | null; device?: number; fallback?: string }>();
  function entryFor(sessionId: string, dir: string) {
    const entry = pending.get(sessionId);
    if (entry && entry.workingDir !== path.resolve(dir) && entry.fallback !== path.resolve(dir)) {
      pending.delete(sessionId);
      return undefined;
    }
    return entry;
  }
  async function mountUnavailable(dir: string, entry: { device?: number }, report: (details: Record<string, unknown>) => void) {
    const canonical = path.resolve(dir);
    if (process.platform === 'darwin' && canonical.startsWith('/Volumes/')) {
      const volume = canonical.split('/').slice(0, 3).join('/');
      try {
        const [mounted, parent] = await Promise.all([io.stat(volume), io.stat('/Volumes')]);
        // A bare mount-point directory is on the parent filesystem. Exclude
        // aliases such as /Volumes/Macintosh HD -> / before classifying it.
        if (mounted.dev !== undefined && mounted.dev === parent.dev &&
          await io.realpath?.(volume).catch(() => null) === volume) {
          report({ reason: 'bare-mount-point', probedDirectoryRef: workdirDiagnosticId(volume) });
          return true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || isUnavailableFilesystemError(error)) {
          report({ reason: 'mount-probe-failed', code: workdirDiagnosticErrorCode(error), probedDirectoryRef: workdirDiagnosticId(volume) });
          return true;
        }
        throw error;
      }
    }
    let ancestor = path.resolve(dir);
    while (true) {
      try {
        const current = await io.stat(ancestor);
        const changed = entry.device !== undefined && current.dev !== undefined && current.dev !== entry.device;
        if (changed) report({
          reason: 'device-changed', expectedDevice: entry.device, actualDevice: current.dev,
          probedDirectoryRef: workdirDiagnosticId(ancestor),
        });
        return changed;
      } catch (error) {
        if (isUnavailableFilesystemError(error)) {
          report({ reason: 'ancestor-probe-failed', code: workdirDiagnosticErrorCode(error), probedDirectoryRef: workdirDiagnosticId(ancestor) });
          return true;
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        report({ reason: 'root-missing', code: 'ENOENT', probedDirectoryRef: workdirDiagnosticId(ancestor) });
        return true;
      }
      ancestor = parent;
    }
  }
  return {
    async observe(sessionId: string, workingDir: string): Promise<void> {
      const existing = entryFor(sessionId, workingDir);
      if (existing?.device !== undefined || existing?.fallback) return;
      const entry = existing ?? { workingDir: path.resolve(workingDir), note: null };
      pending.set(sessionId, entry);
      const stat = await io.stat(workingDir);
      // Do not revive a record cleared while observing the filesystem.
      if (pending.get(sessionId) !== entry) return;
      pending.set(sessionId, { workingDir: path.resolve(workingDir), note: existing?.note ?? null, device: stat.dev });
    },
    resolve(sessionId: string, workingDir: string): string {
      return entryFor(sessionId, workingDir)?.fallback ?? workingDir;
    },
    isFallback(sessionId: string, workingDir: string): boolean {
      return !!entryFor(sessionId, workingDir)?.fallback;
    },
    async recover(sessionId: string, workingDir: string, similarPath?: string | null | (() => Promise<string | null>), candidates: { id: string; workingDir: string }[] = []): Promise<boolean> {
      entryFor(sessionId, workingDir);
      const sessions = new Map(candidates.map((session) => [session.id, session.workingDir]));
      sessions.set(sessionId, workingDir);
      const entries = [...sessions].map(([id, dir]) => {
        const previous = pending.get(id);
        // Preserve unrelated recovery notes until physical identity is known.
        const entry = previous ?? { workingDir: path.resolve(dir), note: null };
        pending.set(id, entry);
        return { id, dir, entry };
      });
      const own = entryFor(sessionId, workingDir);
      const startedAt = Date.now();
      const context = workdirDiagnosticContext(sessionId, workingDir);
      let stage = 'mount-check';
      const reportFailure = (error: unknown) => log?.warn('workdir recovery attempt failed', {
        ...context, stage, code: workdirDiagnosticErrorCode(error),
        usingFallback: !!own?.fallback, elapsedMs: Date.now() - startedAt,
      });
      const useFallback = async (): Promise<boolean> => {
        stage = 'fallback-allocation';
        if (!own || !allocateFallback || pending.get(sessionId) !== own) {
          log?.warn('workdir recovery fallback skipped', {
            ...context, reason: !allocateFallback ? 'allocator-missing' : 'stale-recovery',
          });
          return false;
        }
        const fallback = path.resolve(await allocateFallback(sessionId));
        if (pending.get(sessionId) !== own) return false;
        pending.set(sessionId, { ...own, fallback, note: [
          '[Working directory recovery]',
          `The filesystem for ${JSON.stringify(workingDir)} is unavailable or has changed. Cindy is using ${JSON.stringify(fallback)} as a temporary conversation workspace.`,
          'The original directory and files have not been restored or copied. Do not create a substitute directory at the original mount location. Files written here stay here when the disk reconnects; do not move them or switch back without discussing it with the user.',
          'Continue responding. If the task needs the original files, investigate the disconnected disk or network share, or ask the user in this conversation. No folder-selection interface is required.',
        ].join('\n') });
        log?.info('workdir recovery completed', {
          ...context, action: 'fallback-selected', fallbackRef: workdirDiagnosticId(fallback),
          sameDirectory: path.resolve(workingDir) === fallback, elapsedMs: Date.now() - startedAt,
        });
        return true;
      };
      try {
        if (own?.fallback) {
          stage = 'fallback-stat';
          try {
            const valid = (await io.stat(own.fallback)).isDirectory();
            if (!valid) log?.warn('workdir recovery rejected', { ...context, stage, reason: 'not-directory' });
            return valid;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              reportFailure(error);
              return false;
            }
          }
          stage = 'fallback-mkdir';
          await io.mkdir(own.fallback, { recursive: true });
          if (pending.get(sessionId) !== own) return false;
          pending.set(sessionId, { ...own, note: [
            own.note ?? '[Working directory recovery]',
            `The temporary conversation directory ${JSON.stringify(own.fallback)} was also missing and has been recreated. Its previous files have not been recovered. The original workspace remains ${JSON.stringify(own.workingDir)}; do not create a substitute at that location.`,
          ].join('\n') });
          log?.info('workdir recovery completed', {
            ...context, action: 'fallback-recreated', code: 'ENOENT',
            fallbackRef: workdirDiagnosticId(own.fallback), elapsedMs: Date.now() - startedAt,
          });
          return true;
        }
        if (own && allocateFallback && await mountUnavailable(workingDir, own, (details) => {
          log?.warn('workdir recovery unavailable', { ...context, ...details });
        })) {
          return await useFallback();
        }
        // A stale probe must not mistake a file, permission error, or a directory
        // restored by someone else for a missing directory.
        stage = 'original-stat';
        try {
          const stat = await io.stat(workingDir);
          const valid = stat.isDirectory();
          if (!valid) log?.warn('workdir recovery rejected', { ...context, stage, reason: 'not-directory' });
          return valid;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        stage = 'similar-path';
        const similar = typeof similarPath === 'function' ? await similarPath() : similarPath;
        stage = 'original-mkdir';
        await io.mkdir(workingDir, { recursive: true });
        log?.info('workdir recovery directory created', {
          ...context, action: 'directory-recreated', code: 'ENOENT',
          similarPathFound: !!similar, elapsedMs: Date.now() - startedAt,
        });
        stage = 'alias-resolution';
        const canonical = await io.realpath?.(workingDir).catch(() => null);
        // Cleanup may have removed this entry while filesystem IO was pending.
        // Do not repopulate it after a clear, archive, delete, or owner change.
        const note = [
          '[Working directory recovery]',
          `The working directory was missing. Cindy recreated the directory at ${JSON.stringify(workingDir)} so this conversation can continue.`,
          'Only the directory was recreated; its previous files have not been recovered. Do not assume the original project contents are available.',
          ...(similar ? [
            `A similarly named filesystem entry exists at ${JSON.stringify(similar)} (possibly differing only in whitespace or case). Inspect this candidate before reading or creating project files in the recreated directory. It may contain the original project; verify its identity or ask the user before treating it as their workspace.`,
          ] : []),
          'Continue responding to the user. If their task needs the missing files, investigate the location or recovery options, or ask the user through the conversation. Do not require a folder-selection interface just to continue chatting.',
        ].join('\n');
        await Promise.all(entries.map(async ({ id, dir, entry }) => {
          const matches = path.resolve(dir) === path.resolve(workingDir) ||
            (canonical != null && await io.realpath?.(dir).catch(() => null) === canonical);
          if (matches && pending.get(id) === entry) {
            pending.set(id, { ...entry, workingDir: path.resolve(dir), note });
          }
        }));
        return true;
      } catch (error) {
        reportFailure(error);
        // The share may disappear after stat, including during mkdir. Reuse the
        // same fallback transition; never retry a timed-out write on the share.
        if (!own?.fallback && isUnavailableFilesystemError(error)) {
          return useFallback().catch((fallbackError) => {
            reportFailure(fallbackError);
            return false;
          });
        }
        return false;
      }
    },
    peek(sessionId: string, workingDir?: string): string | null {
      const entry = workingDir === undefined ? pending.get(sessionId) : entryFor(sessionId, workingDir);
      return entry?.note ?? null;
    },
    consume(sessionId: string, expectedNote: string): void {
      const entry = pending.get(sessionId);
      if (entry?.note === expectedNote) pending.set(sessionId, { ...entry, note: null });
    },
    discard(sessionId: string): void {
      pending.delete(sessionId);
    },
    clear(): void {
      pending.clear();
    },
  };
}
