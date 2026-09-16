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

export const SESSION_PATH_IDENTITY_UNPINNABLE_REASON =
  '路径在确认时无法钉住已授权身份。请确认文件仍是普通路径后重试。';
export const SESSION_PATH_IDENTITY_CHANGED_REASON =
  '路径在确认期间发生了变化，这次越界路径授权已失效。请确认目标仍是当时看到的文件后重试。';

/**
 * Grant-time ancestors must still be present after the confirm card returns.
 * A write target may appear as a new leaf; any other identity change is a swap.
 */
export function grantedSessionPathAncestorsStillMatch(
  granted: readonly SessionPathAncestorIdentity[],
  current: readonly SessionPathAncestorIdentity[],
  target: string,
): boolean {
  const resolved = path.resolve(target);
  if (granted.length === 0 || current.length === 0) return false;
  if (granted[0]?.path === resolved) {
    return sameSessionPathAncestors(granted, current);
  }
  if (current[0]?.path === resolved && current.length === granted.length + 1) {
    return sameSessionPathAncestors(granted, current.slice(1));
  }
  return sameSessionPathAncestors(granted, current);
}

/**
 * Write targets may create missing parents after the grant card. Those new
 * components are allowed only when every granted ancestor is still the same
 * path and inode; a parent rename or regular-dir swap must not inherit allow.
 */
export function grantedSessionPathAncestorsStillPresent(
  granted: readonly SessionPathAncestorIdentity[],
  current: readonly SessionPathAncestorIdentity[],
): boolean {
  if (granted.length === 0 || current.length === 0) return false;
  const byPath = new Map(current.map((item) => [item.path, item]));
  return granted.every((item) => {
    const now = byPath.get(item.path);
    return Boolean(now && now.dev === item.dev && now.ino === item.ino);
  });
}

/**
 * Pin the path identity before the Host confirm card, then require the same
 * ancestors after the wait. A regular file/dir swap during the prompt must
 * not inherit the allow.
 */
export async function authorizeSessionPathWithPinnedAncestors(
  request: SessionPathAuthorizationRequest,
): Promise<
  | { allowed: true; isCurrent?: () => boolean; authorizedAncestors: SessionPathAncestorIdentity[] }
  | { allowed: false; reason: string }
> {
  const granted = await captureSessionPathAncestors(request.path);
  if (!granted) {
    return { allowed: false, reason: SESSION_PATH_IDENTITY_UNPINNABLE_REASON };
  }
  const auth = await authorizeSessionPathOutsideWorkdir(request);
  if (!auth.allowed) return auth;
  if (auth.isCurrent?.() === false) {
    return {
      allowed: false,
      reason: '任务权限已变化，这次越界路径授权已失效。请用当前任务权限重试。',
    };
  }
  const current = await captureSessionPathAncestors(request.path);
  if (!current || !grantedSessionPathAncestorsStillMatch(granted, current, request.path)) {
    return { allowed: false, reason: SESSION_PATH_IDENTITY_CHANGED_REASON };
  }
  return {
    allowed: true,
    authorizedAncestors: current,
    ...(auth.isCurrent ? { isCurrent: auth.isCurrent } : {}),
  };
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
