/**
 * `claude auth status --json` — parsing and a host-neutral reader.
 *
 * Cindy never reads Claude credentials: it asks the bundled CLI, whose own login
 * stays in the CLI's credential store. Only the subscription decision lives here,
 * shared by the Desktop main process and the Node host so both classify an
 * account identically (Console keys and third-party clouds are not subscriptions).
 */

import { execFile } from 'node:child_process';

export interface ClaudeCliLoginStatus {
  /** CLI signed in with a Claude.ai subscription — the only shape Cindy counts. */
  loggedIn: boolean;
  /**
   * Signed in, but not as a Claude.ai subscription (Console account, API key,
   * apiKeyHelper, relay token, Bedrock/Vertex). Present only when loggedIn=false.
   */
  notSubscription?: true;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
}

/** The single read-only status query; never a login, session or model call. */
export const CLAUDE_CLI_STATUS_ARGS = ['auth', 'status', '--json'] as const;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Classify one `auth status` payload. A malformed payload returns null so the
 * caller can treat it as "unknown" instead of silently claiming signed-out.
 */
export function parseClaudeCliLoginStatus(stdout: string): ClaudeCliLoginStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.loggedIn !== 'boolean') return null;
  const authMethod = optionalString(record.authMethod);
  const apiProvider = optionalString(record.apiProvider);
  if (!record.loggedIn || authMethod === 'none') return { loggedIn: false };
  const subscription =
    authMethod === 'claude.ai' &&
    optionalString(record.apiKeySource) === undefined &&
    (apiProvider === undefined || apiProvider === 'firstParty');
  if (!subscription) return { loggedIn: false, notSubscription: true };
  const subscriptionType = optionalString(record.subscriptionType);
  const email = optionalString(record.email);
  return {
    loggedIn: true,
    ...(authMethod ? { authMethod } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(email ? { email } : {}),
  };
}

export interface ReadClaudeCliStatusOptions {
  /** Absolute path to the vetted CLI binary. */
  binary: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/**
 * Read the status through a normal child process. The Desktop process runs the
 * same query in a worker thread to keep a blocking OS launch off its main thread;
 * both paths parse with `parseClaudeCliLoginStatus`.
 */
export function readClaudeCliLoginStatusBySpawn(
  options: ReadClaudeCliStatusOptions,
): Promise<ClaudeCliLoginStatus | null> {
  const { promise, resolve, reject } = Promise.withResolvers<ClaudeCliLoginStatus | null>();
  execFile(
    options.binary,
    [...CLAUDE_CLI_STATUS_ARGS],
    {
      env: options.env,
      timeout: options.timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
    (error, stdout) => {
      // Some CLI versions exit non-zero while still printing logged-out JSON.
      if (typeof stdout === 'string' && stdout.trim()) {
        resolve(parseClaudeCliLoginStatus(stdout));
        return;
      }
      if (error) reject(error);
      else resolve(null);
    },
  );
  return promise;
}
