import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function resolveThroughExistingParent(candidate: string): string | null {
  const absolute = path.resolve(candidate);
  if (existsSync(absolute)) {
    try {
      return realpathSync(absolute);
    } catch {
      return null;
    }
  }
  const missing: string[] = [];
  let cursor = absolute;
  for (let depth = 0; depth < 128; depth += 1) {
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
    if (!existsSync(cursor)) continue;
    try {
      return path.resolve(realpathSync(cursor), ...missing);
    } catch {
      return null;
    }
  }
  return null;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const PROTECTED_WORKSPACE_CONTROL_DIRS = new Set(['.git', '.agents', '.codex']);

function isProtectedWorkspaceControlPath(candidate: string, cwd: string): boolean {
  const relative = path.relative(path.resolve(cwd), path.resolve(candidate));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  return PROTECTED_WORKSPACE_CONTROL_DIRS.has(relative.split(path.sep)[0] ?? '');
}

/** Host-owned, symlink-aware write-scope check shared by Bot harness adapters. */
export function isWorkspaceWritePathAllowed(
  candidate: string,
  cwd: string,
  grants: readonly string[],
): boolean {
  if (!candidate || grants.length === 0) return false;
  const target = resolveThroughExistingParent(path.resolve(cwd, candidate));
  if (!target) return false;
  const resolvedCwd = resolveThroughExistingParent(path.resolve(cwd));
  if (
    isProtectedWorkspaceControlPath(path.resolve(cwd, candidate), cwd)
    || (resolvedCwd && isProtectedWorkspaceControlPath(target, resolvedCwd))
  ) return false;
  return grants.some((grant) => {
    const resolvedGrant = resolveThroughExistingParent(path.resolve(grant));
    if (!resolvedGrant) return false;
    try {
      if (existsSync(resolvedGrant) && statSync(resolvedGrant).isFile()) {
        return path.resolve(target) === path.resolve(resolvedGrant);
      }
    } catch {
      return false;
    }
    return isInside(target, resolvedGrant);
  });
}

export function claudeStructuredWriteTarget(
  toolName: string,
  input: unknown,
): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  const fields = toolName === 'NotebookEdit'
    ? ['notebook_path', 'file_path', 'path']
    : ['file_path', 'path'];
  for (const field of fields) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
