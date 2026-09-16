import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Host-owned authorization for a local filesystem path that resolved outside
 * the current session workingDir. Cindy Desktop registers this once; other
 * hosts may leave it unset, in which case the path stays fail-closed.
 */
export type SessionPathAuthorizationRequest = {
  sessionId?: string;
  sessionInstanceId?: string;
  workingDir: string;
  remoteHostId?: string;
  path: string;
  toolName: string;
  operation: 'read' | 'write';
};

export type SessionPathAuthorization =
  | { allowed: true; isCurrent?: () => boolean }
  | { allowed: false; reason: string };

export type SessionPathAuthorizer = (
  request: SessionPathAuthorizationRequest,
) => Promise<SessionPathAuthorization>;

let authorizer: SessionPathAuthorizer | undefined;

export function setSessionPathAuthorizer(next?: SessionPathAuthorizer): void {
  authorizer = next;
}

export function getSessionPathAuthorizer(): SessionPathAuthorizer | undefined {
  return authorizer;
}

export function resolveAbsoluteSessionPath(root: string, inputPath: string): string {
  const rootAbs = path.resolve(root);
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(rootAbs, inputPath);
}

/**
 * Identity shown on the Host grant card and used for later I/O. Follows
 * existing ancestors so a workdir symlink cannot hide an outside target.
 */
export async function resolveCanonicalSessionPath(root: string, inputPath: string): Promise<string> {
  const lexical = resolveAbsoluteSessionPath(root, inputPath);
  const tail: string[] = [];
  let cursor = lexical;
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return lexical;
      const parent = path.dirname(cursor);
      if (parent === cursor) return lexical;
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export type SessionPathAncestorIdentity = {
  path: string;
  dev: bigint;
  ino: bigint;
};

/**
 * Identity of every existing path component from `target` up to the root.
 * Used to pin a granted outside path so a later parent-dir rename+symlink
 * cannot open a file the confirm card never showed.
 *
 * Missing leafs are skipped so a write target can be granted before it
 * exists. Fail-closed when any existing ancestor is a symlink, or the
 * filesystem reports a zero device/inode (those equalities are meaningless).
 */
export async function captureSessionPathAncestors(
  target: string,
): Promise<SessionPathAncestorIdentity[] | null> {
  const identities: SessionPathAncestorIdentity[] = [];
  let cursor = path.resolve(target);
  const { root } = path.parse(cursor);
  for (;;) {
    try {
      const listed = await fs.lstat(cursor, { bigint: true });
      if (listed.isSymbolicLink() || listed.dev === 0n || listed.ino === 0n) return null;
      identities.push({ path: cursor, dev: listed.dev, ino: listed.ino });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return identities.length > 0 ? identities : null;
}

export function sameSessionPathAncestors(
  expected: readonly SessionPathAncestorIdentity[],
  actual: readonly SessionPathAncestorIdentity[],
): boolean {
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return expected.every((left, index) => {
    const right = actual[index];
    return Boolean(
      right
      && left.path === right.path
      && left.dev === right.dev
      && left.ino === right.ino,
    );
  });
}

/**
 * Re-resolve the granted path and reject any symlink in the remaining
 * ancestor chain. Missing leaf/parent is allowed so write targets can be
 * bound before they exist; a swapped parent still fails as a symlink or a
 * different canonical identity.
 */
export async function authorizedSessionPathStillBound(
  workingDir: string,
  authorized: string,
): Promise<boolean> {
  if (await resolveCanonicalSessionPath(workingDir, authorized) !== authorized) return false;
  let cursor = path.resolve(authorized);
  const { root } = path.parse(cursor);
  for (;;) {
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (cursor === root) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) return true;
    cursor = parent;
  }
}

export async function authorizeSessionPathOutsideWorkdir(
  request: SessionPathAuthorizationRequest,
): Promise<SessionPathAuthorization> {
  if (request.remoteHostId) {
    return {
      allowed: false,
      reason: '远程会话不能授权控制端本机路径。请改用当前任务工作目录内的路径，或在本机会话中重试。',
    };
  }
  const fn = authorizer;
  if (!fn) {
    return {
      allowed: false,
      reason: `路径 "${request.path}" 不在本任务的工作目录内。请改用工作目录内的相对路径。`,
    };
  }
  return fn(request);
}
