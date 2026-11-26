import { spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { userDataPath } from '../userDataPath.js';

/** Explicit local override. Contains paths and network settings, never credentials. */
export interface ExternalClaudeRuntimeConfig {
  schema: 1;
  enabled: true;
  accountId: 'default' | `cindy-${string}`;
  executablePath: string;
  configDir: string;
  env: Readonly<Record<string, string>>;
  preflight: { command: string; args: readonly string[]; timeoutMs: number };
}

export interface ExternalClaudeRuntime {
  executablePath: string;
  env: Readonly<Record<string, string>>;
  prepare(signal?: AbortSignal): Promise<void>;
}

const MAX_CONFIG_BYTES = 32 * 1024;
const ENV_KEYS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'BROWSER',
  'DISABLE_AUTOUPDATER', 'DISABLE_NONESSENTIAL_TRAFFIC',
]);
const ROOT_KEYS = new Set(['schema', 'enabled', 'accountId', 'executablePath', 'configDir', 'env', 'preflight']);
const SECONDARY_ACCOUNT_ID = /^cindy-[a-f0-9]{12}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Rejection-only witnesses bridge directory selection and a later CLI launch.
// They never authorize a runtime: the current file must still fully validate.
// Scope by the owning config file; one profile must not contaminate another host.
const selectedDirectories = new Map<string, Map<string, { accountId: string; configDir: string }>>();

function fail(detail: string): never {
  // Values and OS errors can contain command arguments or secrets. Report only a fixed reason.
  throw new Error(`External Claude runtime: ${detail}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) {
    return fail(`${label} must be an absolute local path`);
  }
  if (process.platform === 'win32' && /^(?:\\\\|\/\/)/.test(value)) return fail(`${label} must be local`);
  return path.normalize(value);
}

function executable(value: unknown, label: string): string {
  const file = absolutePath(value, label);
  if (process.platform === 'win32' && path.extname(file).toLowerCase() !== '.exe') {
    return fail(`${label} must be a native executable on Windows`);
  }
  try {
    if (!statSync(file).isFile()) return fail(`${label} is unavailable`);
  } catch { return fail(`${label} is unavailable`); }
  return file;
}

function profileDirectory(value: unknown): string {
  const directory = absolutePath(value, 'configDir');
  if (isSecondaryAccountDirectory(directory)) return fail('configDir cannot use another subscription account directory');
  let existing = directory;
  const missing: string[] = [];
  while (true) {
    try {
      if (!statSync(existing).isDirectory()) return fail('configDir is not a directory');
      existing = realpathSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('configDir is unavailable');
      const parent = path.dirname(existing);
      if (parent === existing) return fail('configDir is unavailable');
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  // Resolve existing aliases before checking ancestors. A symlink must not hide a Git checkout.
  let ancestor = path.join(existing, ...missing);
  if (isSecondaryAccountDirectory(ancestor)) return fail('configDir cannot use another subscription account directory');
  while (true) {
    try {
      statSync(path.join(ancestor, '.git'));
      return fail('configDir must be outside a Git checkout');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail('configDir must be outside a Git checkout');
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return directory;
}

function networkEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (!object(value)) return fail('env must contain explicit proxy and browser settings');
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ENV_KEYS.has(key) || typeof entry !== 'string' || entry.length > 4096 || entry.includes('\0')) {
      return fail('env contains an unsupported setting');
    }
    env[key] = entry;
  }
  const proxy = env.HTTPS_PROXY;
  if (!proxy || env.HTTP_PROXY !== proxy || env.ALL_PROXY !== proxy) return fail('all proxy settings must select one loopback proxy');
  try {
    const url = new URL(proxy);
    if (!['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || !url.port ||
        url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
      return fail('proxy must be a credential-free loopback URL with an explicit port');
    }
  } catch { return fail('proxy must be a credential-free loopback URL with an explicit port'); }
  const bypass = env.NO_PROXY;
  if (bypass === undefined || bypass.split(',').some(item =>
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(item.trim().toLowerCase()))) {
    return fail('NO_PROXY may contain only loopback hosts');
  }
  env.BROWSER = executable(env.BROWSER, 'BROWSER');
  for (const key of ['DISABLE_AUTOUPDATER', 'DISABLE_NONESSENTIAL_TRAFFIC']) {
    if (env[key] !== undefined && !['0', '1', 'true', 'false'].includes(env[key])) return fail('invalid traffic/update setting');
  }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) env[key.toLowerCase()] = env[key]!;
  return Object.freeze(env);
}

/** Read identity before validating the runtime, so an unrelated account never depends on it. */
function readConfiguration(): Record<string, unknown> | null {
  const file = userDataPath('external-claude-runtime.json');
  let fd: number;
  try { fd = openSync(file, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return fail('configuration cannot be read');
  }
  let raw: unknown;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return fail('configuration is not a bounded regular file');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = readSync(fd, buffer, used, buffer.length - used, null);
      if (!read) break;
      used += read;
    }
    if (used > MAX_CONFIG_BYTES) return fail('configuration is too large');
    raw = JSON.parse(buffer.subarray(0, used).toString('utf8').replace(/^\uFEFF/, ''));
  } catch { return fail('configuration is unreadable or invalid'); }
  finally { closeSync(fd); }
  if (!object(raw) || raw.schema !== 1 || typeof raw.enabled !== 'boolean' ||
      Object.keys(raw).some(key => !ROOT_KEYS.has(key))) return fail('configuration schema is invalid');
  if (!raw.enabled) return null;
  if (typeof raw.accountId !== 'string' || (raw.accountId !== 'default' && !SECONDARY_ACCOUNT_ID.test(raw.accountId))) {
    return fail('accountId must select a default or host-owned subscription account');
  }
  return raw;
}

function validateConfiguration(raw: Record<string, unknown>): ExternalClaudeRuntimeConfig {
  if (!object(raw.preflight) || Object.keys(raw.preflight).some(key => !['command', 'args', 'timeoutMs'].includes(key)) ||
      !Array.isArray(raw.preflight.args) || raw.preflight.args.length > 64 ||
      raw.preflight.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192) ||
      !Number.isInteger(raw.preflight.timeoutMs) || (raw.preflight.timeoutMs as number) < 1 ||
      (raw.preflight.timeoutMs as number) > 30_000) return fail('preflight is invalid');
  const config: ExternalClaudeRuntimeConfig = {
    schema: 1, enabled: true, accountId: raw.accountId as ExternalClaudeRuntimeConfig['accountId'],
    executablePath: executable(raw.executablePath, 'executablePath'),
    configDir: profileDirectory(raw.configDir),
    env: networkEnvironment(raw.env),
    preflight: Object.freeze({
      command: executable(raw.preflight.command, 'preflight command'),
      args: Object.freeze([...raw.preflight.args] as string[]),
      timeoutMs: raw.preflight.timeoutMs as number,
    }),
  };
  return Object.freeze(config);
}

/** No fallback on malformed/unreadable opt-in. Missing or explicitly disabled is the stock path. */
export function readExternalClaudeRuntime(): ExternalClaudeRuntimeConfig | null {
  const raw = readConfiguration();
  return raw ? validateConfiguration(raw) : null;
}

/** Discovery only, never authorization: an unrelated broken opt-in must not
 * disable a stock account. Persistently marked accounts always use strict reads.
 */
export function peekExternalClaudeAccountId(): string | undefined {
  try { return readConfiguration()?.accountId as string | undefined; }
  catch { return undefined; }
}

export function isDefaultClaudeDirectory(configDir?: string): boolean {
  return configDir === undefined || sameDirectory(configDir, path.join(homedir(), '.claude'));
}

export function externalClaudeDirectoryForAccount(accountId: string): string | undefined {
  const raw = readConfiguration();
  if (raw?.accountId !== accountId) return undefined;
  const config = validateConfiguration(raw);
  rememberSelection(config);
  return config.configDir;
}

export function externalClaudeDefaultDirectory(): string | undefined {
  return externalClaudeDirectoryForAccount('default');
}

function sameDirectory(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function selectionScope(): string {
  return pathKey(userDataPath('external-claude-runtime.json'));
}

function rememberSelection(config: ExternalClaudeRuntimeConfig): void {
  const scope = selectionScope();
  let selected = selectedDirectories.get(scope);
  if (!selected) { selected = new Map(); selectedDirectories.set(scope, selected); }
  const witness = { accountId: config.accountId, configDir: config.configDir };
  selected.set(pathKey(config.configDir), witness);
  if (config.accountId === 'default') selected.set(pathKey(path.join(homedir(), '.claude')), witness);
}

/** Only the executing host can mint these secondary-account directory names. */
function isSecondaryAccountDirectory(directory: string): boolean {
  const resolved = path.resolve(directory);
  return sameDirectory(path.dirname(resolved), homedir()) &&
    path.basename(resolved).toLowerCase().startsWith('.claude-') &&
    SECONDARY_ACCOUNT_ID.test(path.basename(resolved).slice('.claude-'.length));
}

function runPreflight(config: ExternalClaudeRuntimeConfig, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('External Claude runtime: preflight cancelled'));
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...config.env, CLAUDE_CONFIG_DIR: config.configDir };
    for (const key of Object.keys(env)) {
      if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_OAUTH') || key === 'NODE_OPTIONS') delete env[key];
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.preflight.command, [...config.preflight.args], {
        shell: false, windowsHide: true, stdio: 'ignore', env,
      });
    } catch { reject(new Error('External Claude runtime: preflight could not start')); return; }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = () => {
      try { child.kill('SIGKILL'); } catch { /* Launch stays rejected even if process teardown fails. */ }
    };
    const onAbort = () => {
      if (settled) return;
      finish(new Error('External Claude runtime: preflight cancelled'));
      terminate();
    };
    child.once('error', () => finish(new Error('External Claude runtime: preflight could not start')));
    child.once('close', code => finish(code === 0 ? undefined : new Error('External Claude runtime: preflight rejected launch')));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    timer = setTimeout(() => {
      finish(new Error('External Claude runtime: preflight timed out'));
      terminate();
    }, config.preflight.timeoutMs);
  });
}

/** Trusted host account selection; other profiles must keep their own runtime. */
export function externalClaudeRuntimeForDirectory(configDir?: string): ExternalClaudeRuntime | undefined {
  // An unavailable override must not break a distinct, host-owned account.
  // Check its namespace before touching the unrelated external-runtime file.
  if (configDir !== undefined && isSecondaryAccountDirectory(configDir)) return undefined;
  const requestedDirectory = configDir ?? path.join(homedir(), '.claude');
  const selected = selectedDirectories.get(selectionScope())?.get(pathKey(requestedDirectory));
  const raw = readConfiguration();
  if (selected && (!raw || raw.accountId !== selected.accountId ||
      !sameDirectory(absolutePath(raw.configDir, 'configDir'), selected.configDir))) {
    return fail('selected runtime is no longer configured; refusing bundled fallback');
  }
  if (!raw) return undefined;
  const isDefaultDirectory = isDefaultClaudeDirectory(configDir);
  if (isDefaultDirectory) {
    if (raw.accountId !== 'default') return undefined;
  } else if (configDir === undefined || !sameDirectory(configDir, absolutePath(raw.configDir, 'configDir'))) {
    return undefined;
  }
  const config = validateConfiguration(raw);
  rememberSelection(config);
  const fingerprint = JSON.stringify(config);
  return Object.freeze({
    executablePath: config.executablePath,
    env: Object.freeze({ ...config.env, CLAUDE_CONFIG_DIR: config.configDir }),
    async prepare(signal?: AbortSignal) {
      if (signal?.aborted) return fail('preflight cancelled');
      if (JSON.stringify(readExternalClaudeRuntime()) !== fingerprint) return fail('configuration changed; select the account again');
      await runPreflight(config, signal);
      if (signal?.aborted) return fail('preflight cancelled');
      if (JSON.stringify(readExternalClaudeRuntime()) !== fingerprint) return fail('configuration changed during preflight');
    },
  });
}
