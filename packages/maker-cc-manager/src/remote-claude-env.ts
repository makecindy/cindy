import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REMOTE_CLAUDE_CONFIG_SEGMENTS = ['.xdt-server', 'v1', 'claude-home'] as const;

// Keep in sync with maker-core's env-builder. The standalone daemon cannot
// inherit the remote shell's credentials or provider routing into a session.
const SENSITIVE_ANTHROPIC_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CINDY_CLAUDE_ACCOUNT_PROVIDER_ID',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
] as const;

/** Clean daemon boot state as well as each explicit SDK environment merge. */
export function stripSensitiveAnthropicEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const stripped: string[] = [];
  for (const key of SENSITIVE_ANTHROPIC_ENV_KEYS) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }
  return stripped;
}

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

/**
 * SDK >= 0.2.113 replaces process.env with options.env. Merge this host's
 * HOME/PATH at the SDK boundary, keeping ambient authentication out.
 */
export function buildRemoteClaudeSdkEnv(
  env: Readonly<Record<string, string>>,
  remoteProcessEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const cleanEnv = { ...remoteProcessEnv };
  stripSensitiveAnthropicEnv(cleanEnv);
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(cleanEnv)) {
    if (value !== undefined) inherited[key] = value;
  }
  return {
    ...inherited,
    ...env,
  };
}

/** Create the daemon-owned directory with private permissions before SDK use. */
export function ensureRemoteClaudeConfigDir(remoteHomeDir: string = os.homedir()): string {
  const configDir = resolveRemoteClaudeConfigDir(remoteHomeDir);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  return configDir;
}
