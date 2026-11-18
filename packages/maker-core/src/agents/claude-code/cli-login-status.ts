/**
 * `claude auth status --json` — parsing and a host-neutral reader.
 *
 * Cindy never reads Claude credentials: it asks the bundled CLI, whose own login
 * stays in the CLI's credential store. Only the subscription decision lives here,
 * shared by the Desktop main process and the Node host so both classify an
 * account identically (Console keys and third-party clouds are not subscriptions).
 */

import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

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
  /** Official CLI tier (for example max_5x / max_20x); never inferred from usage. */
  planTier?: string;
  /** Official product name; display metadata, never a subscription/auth verdict. */
  planDisplayName?: string;
  email?: string;
  /** Official CLI estimate for the end of this login's refresh chain, not an auth verdict. */
  loginExpiresAt?: string;
}

/** Read-only status queries; never a login, session or model call. */
export const CLAUDE_CLI_STATUS_ARGS = ['auth', 'status', '--json'] as const;
const CLAUDE_CLI_TEXT_STATUS_ARGS = ['auth', 'status', '--text'] as const;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function displayName(value: unknown): string | undefined {
  const name = optionalString(value);
  return name && name.length <= 128 && !/\p{Cc}/u.test(name) ? name : undefined;
}

function statusRecord(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Text is advisory only, and must describe the JSON query's email and organization. */
function textDisplayName(record: Record<string, unknown>, stdout: string): string | undefined {
  const fields = new Map<string, string>();
  for (const line of stripVTControlCharacters(stdout).split(/\r?\n/)) {
    const match = /^\s*(Login method|Email|Organization):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1])) return undefined;
    fields.set(match[1], match[2]);
  }
  const email = optionalString(record.email);
  const orgName = optionalString(record.orgName);
  const orgId = optionalString(record.orgId);
  if (!email || fields.get('Email') !== email || (!orgName && !orgId)) return undefined;
  const organization = fields.get('Organization');
  if (organization !== (orgName ?? orgId) &&
      !(orgName && orgId && organization === `${orgName} · ${orgId}`)) return undefined;
  const match = /^Claude (.+) account$/.exec(fields.get('Login method') ?? '');
  return match ? displayName(match[1]) : undefined;
}

/**
 * Classify one `auth status` payload. A malformed payload returns null so the
 * caller can treat it as "unknown" instead of silently claiming signed-out.
 */
export function parseClaudeCliLoginStatus(stdout: string, textStdout?: string): ClaudeCliLoginStatus | null {
  const record = statusRecord(stdout);
  if (!record) return null;
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
  const planTier = optionalString(record.planTier);
  const planDisplayName = displayName(record.planDisplayName)
    ?? (textStdout ? textDisplayName(record, textStdout) : undefined);
  const email = optionalString(record.email);
  const expiry = optionalString(record.loginExpiresAt);
  const loginExpiresAt = expiry && expiry.length <= 64 && Number.isFinite(Date.parse(expiry))
    ? new Date(expiry).toISOString()
    : undefined;
  return {
    loggedIn: true,
    ...(authMethod ? { authMethod } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(planTier ? { planTier } : {}),
    ...(planDisplayName ? { planDisplayName } : {}),
    ...(email ? { email } : {}),
    ...(loginExpiresAt ? { loginExpiresAt } : {}),
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
 * same reader in a worker thread to keep a blocking OS launch off its main thread.
 * CLI versions without a JSON display name can supply it through official text
 * status. Both queries share the binary, environment/profile and timeout budget.
 */
export async function readClaudeCliLoginStatusBySpawn(
  options: ReadClaudeCliStatusOptions,
): Promise<ClaudeCliLoginStatus | null> {
  const deadline = Date.now() + options.timeoutMs;
  const stdout = await readStatusOutput(options, CLAUDE_CLI_STATUS_ARGS, true);
  const status = parseClaudeCliLoginStatus(stdout);
  const record = statusRecord(stdout);
  if (!status?.loggedIn || status.planDisplayName || !status.email ||
      !record || (!optionalString(record.orgName) && !optionalString(record.orgId))) return status;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return status;
  try {
    const text = await readStatusOutput({ ...options, timeoutMs: remainingMs }, CLAUDE_CLI_TEXT_STATUS_ARGS);
    return parseClaudeCliLoginStatus(stdout, text);
  } catch {
    // An optional display label must never make a valid JSON login unavailable.
    return status;
  }
}

function readStatusOutput(options: ReadClaudeCliStatusOptions, args: readonly string[], acceptErrorOutput = false): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    options.binary,
    [...args],
    {
      env: options.env,
      timeout: options.timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
    (error, stdout) => {
      // Some CLI versions exit non-zero while still printing logged-out JSON.
      if (typeof stdout === 'string' && stdout.trim() && (!error || acceptErrorOutput)) {
        resolve(stdout);
        return;
      }
      if (error) reject(error);
      else resolve('');
    },
  );
  return promise;
}
