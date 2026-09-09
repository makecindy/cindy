import path from 'node:path';

/**
 * Keep the caller's lexical root and output path in the same namespace when
 * deriving the relative parent.  `realpath(root)` may change `/var` into
 * `/private/var` or replace a session-root symlink, while the already checked
 * output path deliberately retains the caller-visible spelling.
 */
export function relativeOutputParentPath(rootDir: string, parentDir: string): string | null {
  const lexicalRoot = path.resolve(rootDir);
  const lexicalParent = path.resolve(parentDir);
  const relative = path.relative(lexicalRoot, lexicalParent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

export interface DocsOutputParentIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

export interface DocsOutputRootIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

export interface DocsOutputWriteRequest {
  expectedRoot: DocsOutputRootIdentity;
  /** Existing parent identity, or null when the utility must create it safely. */
  expectedParent: DocsOutputParentIdentity | null;
  parentRelativePath: string;
  targetName: string;
  data: Uint8Array;
  overwrite: boolean;
}

export type DocsOutputWriteResult =
  | { ok: true }
  | {
      ok: false;
      errorCode: 'FILE_EXISTS' | 'PATH_NOT_ALLOWED' | 'ATOMIC_PUBLISH_UNSUPPORTED' | 'INTERNAL';
      message: string;
    };
