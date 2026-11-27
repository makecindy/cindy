/**
 * `claude auth status --json` — parsing and a host-neutral reader.
 *
 * Cindy never reads Claude credentials: it asks the bundled CLI, whose own login
 * stays in the CLI's credential store. Only the subscription decision lives here,
 * shared by the Desktop main process and the Node host so both classify an
 * account identically (Console keys and third-party clouds are not subscriptions).
 */

import { execFile, spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/**
 * How a long-lived token (`claude setup-token`, valid about a year, model requests only)
 * reaches the CLI. `descriptor`: the host opens the account's token file and hands the CLI the
 * open descriptor, so every session kind gets it. `settings`: the token sits in the account's
 * Claude user settings, so only sessions that load user settings get it.
 */
export type ClaudeLongLivedTokenSource = 'descriptor' | 'settings';

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
  /**
   * Tasks run on a long-lived token. Such a token carries no profile scope, so `email`, the plan
   * fields and `loginExpiresAt` then describe the ordinary login stored beside it (when there is one).
   */
  longLivedToken?: ClaudeLongLivedTokenSource;
  /** Secret-free file version of the long-lived token observed during status read; never token content. */
  longLivedTokenVersion?: string;
  /** With `longLivedToken`: whether the ordinary login beside it is still signed in. Absent when unread. */
  storedLogin?: boolean;
}

/** The token file in an account's Claude config directory. Only the official CLI reads its content. */
export const CLAUDE_LONG_LIVED_TOKEN_FILE = 'cindy-long-lived-token';
/** Official CLI variable naming an inherited descriptor that holds the OAuth token. */
export const CLAUDE_OAUTH_TOKEN_DESCRIPTOR_ENV = 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR';
/** `stdio[3]` of the CLI process; the value of CLAUDE_OAUTH_TOKEN_DESCRIPTOR_ENV. */
export const CLAUDE_OAUTH_TOKEN_DESCRIPTOR = 3;

export function claudeConfigDirectory(configDir?: string): string {
  return configDir?.trim() || path.join(homedir(), '.claude');
}

/**
 * The account's long-lived token file, when one exists. The CLI reads an inherited descriptor
 * through `/dev/fd`, which Windows does not have, so there the token lives in user settings instead.
 * Existence and size only: the host never reads the token.
 */
export function claudeLongLivedTokenFile(
  configDir?: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') return undefined;
  const file = path.join(claudeConfigDirectory(configDir), CLAUDE_LONG_LIVED_TOKEN_FILE);
  try {
    const stats = statSync(file);
    return stats.isFile() && stats.size > 0 ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Secret-free version key derived solely from file metadata (never reads token bytes). */
export function claudeLongLivedTokenVersionFromStats(
  source: ClaudeLongLivedTokenSource,
  stats: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>,
): string {
  return `${source}:${stats.dev}:${stats.ino}:${stats.size}:${Math.trunc(stats.mtimeMs)}:${Math.trunc(stats.ctimeMs)}`;
}

/** Secret-free version of the account's long-lived token file or user settings file, if present. */
export function claudeLongLivedTokenFileVersion(
  source: ClaudeLongLivedTokenSource,
  configDir?: string,
): string | undefined {
  const file = path.join(
    claudeConfigDirectory(configDir),
    source === 'descriptor' ? CLAUDE_LONG_LIVED_TOKEN_FILE : 'settings.json',
  );
  try {
    const stats = statSync(file);
    return stats.isFile() && stats.size > 0 ? claudeLongLivedTokenVersionFromStats(source, stats) : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only status queries; never a login, session or model call. */
export const CLAUDE_CLI_STATUS_ARGS = ['auth', 'status', '--json'] as const;
const CLAUDE_CLI_TEXT_STATUS_ARGS = ['auth', 'status', '--text'] as const;
/** Global flag: answer from the stored login alone, without the user's settings file. */
const CLAUDE_CLI_SKIP_USER_SETTINGS_ARGS = ['--setting-sources', ''] as const;

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
 * JSON reports every bearer token as `oauth_token`, including relay tokens. Only the text status
 * names where the token came from, so a long-lived subscription token is recognized there.
 */
function longLivedTokenSource(stdout: string): ClaudeLongLivedTokenSource | undefined {
  const sources = stripVTControlCharacters(stdout).split(/\r?\n/)
    .map(line => /^\s*Auth token:\s*(\S+)\s*$/.exec(line)?.[1])
    .filter((source): source is string => source !== undefined);
  if (sources.length !== 1) return undefined;
  if (sources[0] === CLAUDE_OAUTH_TOKEN_DESCRIPTOR_ENV) return 'descriptor';
  return sources[0] === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'settings' : undefined;
}

function tokenLogin(record: Record<string, unknown>): boolean {
  const apiProvider = optionalString(record.apiProvider);
  return record.loggedIn === true && optionalString(record.authMethod) === 'oauth_token' &&
    optionalString(record.apiKeySource) === undefined &&
    (apiProvider === undefined || apiProvider === 'firstParty');
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
  if (tokenLogin(record)) {
    const source = textStdout ? longLivedTokenSource(textStdout) : undefined;
    return source ? { loggedIn: true, authMethod: 'oauth_token', longLivedToken: source }
      : { loggedIn: false, notSubscription: true };
  }
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
  /** The account's long-lived token file (claudeLongLivedTokenFile); passed on as a descriptor. */
  oauthTokenFile?: string;
}

interface StatusLaunch {
  oauthTokenFile?: string;
  skipUserSettings?: boolean;
  onTokenVersion?: (version: string) => void;
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
  const status = await readStatusOnce(options, deadline, { oauthTokenFile: options.oauthTokenFile });
  if (!status?.longLivedToken) return status;
  // The token cannot say whose it is. The ordinary login stored beside it still can.
  let stored: ClaudeCliLoginStatus | null = null;
  try {
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) stored = await readStatusOnce(options, deadline, { skipUserSettings: true }, remainingMs);
  } catch {
    // The token login stands; the stored login just stays unread this time.
  }
  if (!stored || stored.longLivedToken || stored.notSubscription) return status;
  if (!stored.loggedIn) return { ...status, storedLogin: false };
  return {
    ...status,
    storedLogin: true,
    ...(stored.subscriptionType ? { subscriptionType: stored.subscriptionType } : {}),
    ...(stored.planTier ? { planTier: stored.planTier } : {}),
    ...(stored.planDisplayName ? { planDisplayName: stored.planDisplayName } : {}),
    ...(stored.email ? { email: stored.email } : {}),
    ...(stored.loginExpiresAt ? { loginExpiresAt: stored.loginExpiresAt } : {}),
  };
}

async function readStatusOnce(
  options: ReadClaudeCliStatusOptions,
  deadline: number,
  launch: StatusLaunch,
  timeoutMs = options.timeoutMs,
): Promise<ClaudeCliLoginStatus | null> {
  const prefix = launch.skipUserSettings ? CLAUDE_CLI_SKIP_USER_SETTINGS_ARGS : [];
  let jsonDescriptorVersion: string | undefined;
  let textDescriptorVersion: string | undefined;
  const settingsVersionBefore = launch.skipUserSettings
    ? undefined : claudeLongLivedTokenFileVersion('settings', options.env.CLAUDE_CONFIG_DIR);
  const stdout = await readStatusOutput(
    { ...options, timeoutMs },
    [...prefix, ...CLAUDE_CLI_STATUS_ARGS],
    { ...launch, onTokenVersion: (version) => { jsonDescriptorVersion = version; } },
    true,
  );
  const status = parseClaudeCliLoginStatus(stdout);
  const record = statusRecord(stdout);
  const viaToken = !!record && tokenLogin(record);
  if (!viaToken && (!status?.loggedIn || status.planDisplayName || !status.email ||
      !record || (!optionalString(record.orgName) && !optionalString(record.orgId)))) return status;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return status;
  try {
    const text = await readStatusOutput(
      { ...options, timeoutMs: remainingMs },
      [...prefix, ...CLAUDE_CLI_TEXT_STATUS_ARGS],
      { ...launch, onTokenVersion: (version) => { textDescriptorVersion = version; } },
    );
    const parsed = parseClaudeCliLoginStatus(stdout, text);
    if (!parsed?.longLivedToken) return parsed;
    const version = parsed.longLivedToken === 'descriptor'
      ? (jsonDescriptorVersion && jsonDescriptorVersion === textDescriptorVersion ? jsonDescriptorVersion : undefined)
      : (settingsVersionBefore && settingsVersionBefore === claudeLongLivedTokenFileVersion('settings', options.env.CLAUDE_CONFIG_DIR)
        ? settingsVersionBefore : undefined);
    return version ? { ...parsed, longLivedTokenVersion: version } : parsed;
  } catch {
    // An optional display label must never make a valid JSON login unavailable.
    return status;
  }
}

function readStatusOutput(
  options: ReadClaudeCliStatusOptions,
  args: readonly string[],
  launch: StatusLaunch = {},
  acceptErrorOutput = false,
): Promise<string> {
  if (launch.oauthTokenFile) {
    return readStatusOutputWithToken(options, args, launch.oauthTokenFile, acceptErrorOutput, launch.onTokenVersion);
  }
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

/** `execFile` cannot pass an extra descriptor, so the token read spawns the CLI itself. */
function readStatusOutputWithToken(
  options: ReadClaudeCliStatusOptions,
  args: readonly string[],
  oauthTokenFile: string,
  acceptErrorOutput: boolean,
  onTokenVersion?: (version: string) => void,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let descriptor: number;
  try {
    descriptor = openSync(oauthTokenFile, 'r');
  } catch (error) {
    reject(error);
    return promise;
  }
  let child: ReturnType<typeof spawn>;
  try {
    onTokenVersion?.(claudeLongLivedTokenVersionFromStats('descriptor', fstatSync(descriptor)));
    child = spawn(options.binary, [...args], {
      env: { ...options.env, [CLAUDE_OAUTH_TOKEN_DESCRIPTOR_ENV]: String(CLAUDE_OAUTH_TOKEN_DESCRIPTOR) },
      stdio: ['ignore', 'pipe', 'ignore', descriptor],
      windowsHide: true,
    });
  } catch (error) {
    reject(error);
    return promise;
  } finally {
    // The child owns its inherited copy; the host never reads from this descriptor.
    closeSync(descriptor);
  }
  let stdout = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8');
  });
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code) => {
    clearTimeout(timer);
    const failed = timedOut || code !== 0;
    if (stdout.trim() && (!failed || (acceptErrorOutput && !timedOut))) resolve(stdout);
    else if (failed) reject(new Error(timedOut ? 'claude auth status timed out' : 'claude auth status failed'));
    else resolve('');
  });
  return promise;
}
