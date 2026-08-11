import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REMOTE_CLAUDE_CONFIG_SEGMENTS = ['.xdt-server', 'v1', 'claude-home'] as const;

/** Resolve the Cindy-managed Claude config directory on the remote POSIX host. */
export function resolveRemoteClaudeConfigDir(remoteHomeDir: string = os.homedir()): string {
  // cc-manager only runs on bash-capable SSH hosts. Normalize separators so
  // Windows unit tests can inject a POSIX home without changing production
  // path semantics.
  const normalizedHome = remoteHomeDir.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!normalizedHome) {
    throw new Error('remote home directory is empty');
  }
  return path.posix.join(normalizedHome, ...REMOTE_CLAUDE_CONFIG_SEGMENTS);
}

/**
 * Override controller-supplied path values before they reach the remote SDK.
 *
 * CLAUDE_CONFIG_DIR is intentionally daemon-owned: a controller path is not
 * meaningful on another machine and may otherwise become a repository-local
 * relative directory on POSIX.
 */
export function prepareRemoteClaudeEnv(
  env: Readonly<Record<string, string>>,
  remoteHomeDir: string = os.homedir(),
): Record<string, string> {
  return {
    ...env,
    CLAUDE_CONFIG_DIR: resolveRemoteClaudeConfigDir(remoteHomeDir),
  };
}

/** Create the daemon-owned directory with private permissions before SDK use. */
export function ensureRemoteClaudeConfigDir(remoteHomeDir: string = os.homedir()): string {
  const configDir = resolveRemoteClaudeConfigDir(remoteHomeDir);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  return configDir;
}
