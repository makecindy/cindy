/** Compare actual workspace directories, without the worktree folding used by project groups. */
export function workspacePathsEqual(left: string, right: string): boolean {
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}

function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim();
  // The path belongs to the remote host, not the phone's OS. POSIX backslashes are literal.
  const windows = /^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('//');
  const path = windows ? trimmed.replaceAll('\\', '/').toLowerCase() : trimmed;
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') {
    // Keep drive roots absolute: D:/ is not the drive-relative D:.
    if (end === 3 && /^[a-z]:/i.test(path)) break;
    end -= 1;
  }
  return path.slice(0, end);
}
