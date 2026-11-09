import path from 'node:path';

/**
 * Where the remote Claude daemon keeps its state.
 *
 * `cc-mgr` forces `CLAUDE_CONFIG_DIR` to this directory so Cindy-managed state
 * stays outside the host's global `~/.claude`. Discovery that reads `~/.claude`
 * on a remote host therefore looks at a directory the session never loads.
 *
 * Shared here because writer (maker-cc-manager) and reader (maker-core) must
 * agree; the two packages do not depend on each other otherwise.
 */
export const REMOTE_CLAUDE_CONFIG_SEGMENTS = ['.xdt-server', 'v1', 'claude-home'] as const;

/**
 * Resolve the remote config directory for a POSIX home path.
 *
 * `home` may be a literal like `$HOME` when the path is evaluated on the remote
 * side; `path.posix.join` keeps it verbatim.
 */
export function remoteClaudeConfigDir(home: string): string {
  const normalized = home.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!normalized) throw new Error('remote home directory is empty');
  return path.posix.join(normalized, ...REMOTE_CLAUDE_CONFIG_SEGMENTS);
}
