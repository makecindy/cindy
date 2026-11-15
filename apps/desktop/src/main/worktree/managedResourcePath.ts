import path from 'node:path';
import { isManagedWorktreeDirectoryName } from '../../shared/managedWorktreePaths.js';

/** Map a local cwd (including descendants) to its managed resource. SSH callers skip this helper. */
export function managedWorktreeRoot(value: string): string | null {
  let current = path.resolve(value);
  for (;;) {
    const parent = path.dirname(current);
    if (isManagedWorktreeDirectoryName(path.basename(parent))) return current;
    if (parent === current) return null;
    current = parent;
  }
}

