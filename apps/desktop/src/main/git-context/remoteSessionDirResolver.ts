/**
 * Resolve the git context for an SSH-backed session.
 *
 * SSH session paths belong to the remote host, so the local HEAD reader is
 * deliberately not used here. Probe the newest telemetry candidate first,
 * then the remote worktree and session working directory through the existing
 * SSH connection, returning the same small projection consumed by the renderer.
 */

import type { GitHeadInfo } from './headReader.js';
import type { SessionGitDirResult } from './sessionDirResolver.js';

export interface RemoteGitHost {
  getStatus(): string;
  exec(
    command: string,
    options: {
      timeoutMs: number;
      label: string;
      maxOutputBytes: number;
    },
  ): Promise<{ stdout: string }>;
}

/**
 * Rehydrate and connect an SSH host before a remote Git probe.
 *
 * Git context is a best-effort header query: a missing host, expired
 * credentials, or a transient network failure should keep the task usable and
 * return the same empty projection as any other unavailable remote path.
 */
export async function resolveReadyRemoteGitHost(
  remoteHostId: string,
  deps: {
    ensureReady: (hostId: string) => Promise<void>;
    getHost: (hostId: string) => RemoteGitHost | null | undefined;
  },
): Promise<RemoteGitHost | null> {
  try {
    await deps.ensureReady(remoteHostId);
  } catch {
    return null;
  }
  const host = deps.getHost(remoteHostId);
  return host?.getStatus() === 'ready' ? host : null;
}

export interface StoredSessionGitTarget {
  workingDir: string | null;
  worktreePath: string | null;
  remoteHostId: string | null;
}

/**
 * Derive the probe target from main-owned session state.
 *
 * Direct renderer IPC must match the SSH host recorded for the session; a
 * device-link caller is allowed to send stale projection data, but it never
 * gets to override the controlled device's paths or nested SSH host.
 */
export function resolveAuthoritativeSessionGitTarget(input: {
  stored: StoredSessionGitTarget;
  requestedRemoteHostId: string | null;
  isDeviceLink: boolean;
  liveLocalWorktreePath: string | null;
}): StoredSessionGitTarget | null {
  const storedRemoteHostId = input.stored.remoteHostId ?? null;
  if (!input.isDeviceLink && input.requestedRemoteHostId !== storedRemoteHostId) return null;

  return {
    workingDir: input.stored.workingDir ?? null,
    remoteHostId: storedRemoteHostId,
    worktreePath: storedRemoteHostId
      ? input.stored.worktreePath ?? null
      : input.liveLocalWorktreePath,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Read a branch or detached HEAD from a remote working directory.
 * The explicit prefix avoids confusing a hexadecimal branch name with a SHA.
 */
export async function probeRemoteGitDir(
  host: RemoteGitHost,
  workdir: string,
): Promise<GitHeadInfo | null> {
  if (!workdir.trim() || host.getStatus() !== 'ready') return null;

  const quoted = shellQuote(workdir);
  const command =
    `if branch=$(git -C ${quoted} symbolic-ref --short HEAD 2>/dev/null); then ` +
    `printf 'branch:%s\\n' "$branch"; ` +
    `elif sha=$(git -C ${quoted} rev-parse --short=8 HEAD 2>/dev/null); then ` +
    `printf 'detached:%s\\n' "$sha"; fi`;

  try {
    const result = await host.exec(command, {
      timeoutMs: 5_000,
      label: 'git context probe',
      maxOutputBytes: 1_024,
    });
    const line = result.stdout.trim().split('\n', 1)[0] ?? '';
    if (line.startsWith('branch:')) {
      const branch = line.slice('branch:'.length).trim();
      return branch ? { kind: 'branch', branch, shortSha: null } : null;
    }
    if (line.startsWith('detached:')) {
      const shortSha = line.slice('detached:'.length).trim();
      return shortSha ? { kind: 'detached', branch: null, shortSha } : null;
    }
    return null;
  } catch {
    // A disconnected host, a missing directory, and a non-git directory all
    // mean the same thing to the badge: no branch context is available yet.
    return null;
  }
}

export async function resolveRemoteSessionGitDir(input: {
  telemetryPath?: string | null;
  fallbackWorktreePath: string | null;
  fallbackWorkingDir: string | null;
  host: RemoteGitHost;
}): Promise<SessionGitDirResult> {
  const candidates = [
    { workdir: input.telemetryPath, source: 'remote' as const },
    { workdir: input.fallbackWorktreePath, source: 'remote' as const },
    // session.workingDir is a shared-checkout snapshot, even when the probe
    // itself runs on the SSH host; keep it low-trust so PR refs can win.
    { workdir: input.fallbackWorkingDir, source: 'workingDir' as const },
  ].filter(
    (candidate): candidate is { workdir: string; source: 'remote' | 'workingDir' } =>
      typeof candidate.workdir === 'string' && candidate.workdir.trim().length > 0,
  );

  for (const { workdir, source } of candidates) {
    const head = await probeRemoteGitDir(input.host, workdir);
    if (head) return { workdir, head, source };
  }

  return { workdir: null, head: null, source: null };
}
