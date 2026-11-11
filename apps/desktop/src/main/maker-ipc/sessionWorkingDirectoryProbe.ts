import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';

export interface SessionWorkingDirectoryStat {
  isDirectory(): boolean;
  dev?: number;
}

export interface SessionWorkingDirectoryProbeDeps {
  stat(workingDir: string): Promise<SessionWorkingDirectoryStat>;
  readBoundWorkingDir(): Promise<string | null | readonly (string | null)[]>;
}

export type SessionWorkingDirectoryProbeResult =
  | { kind: 'stat'; stat: SessionWorkingDirectoryStat }
  | { kind: 'bound-timeout' };

function matchesBoundWorkingDir(
  boundWorkingDir: string | null | readonly (string | null)[],
  workingDir: string,
): boolean {
  const candidates = Array.isArray(boundWorkingDir) ? boundWorkingDir : [boundWorkingDir];
  const normalizedWorkingDir = normalizeWorkingDirForStorage(workingDir);
  return candidates.some((candidate) => normalizeWorkingDirForStorage(candidate) === normalizedWorkingDir);
}

/**
 * Probe a session cwd once. A timeout is usable evidence that the filesystem
 * did not answer, but it is not evidence that a directory is missing. Existing
 * sessions may continue with their already-bound cwd while the next operation
 * reports the real filesystem error.
 */
export async function probeSessionWorkingDirectory(
  workingDir: string,
  deps: SessionWorkingDirectoryProbeDeps,
): Promise<SessionWorkingDirectoryProbeResult> {
  try {
    return { kind: 'stat', stat: await deps.stat(workingDir) };
  } catch (error) {
    if (workdirErrorCode(error) !== 'WORKDIR_PROBE_TIMEOUT') throw error;

    const boundWorkingDir = await deps.readBoundWorkingDir().catch(() => null);
    if (matchesBoundWorkingDir(boundWorkingDir, workingDir)) {
      return { kind: 'bound-timeout' };
    }
    throw error;
  }
}

export function workdirErrorCode(error: unknown): string | undefined {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' ? code : undefined;
}
