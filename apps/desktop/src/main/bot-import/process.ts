import { spawn } from 'node:child_process';
import { killProcessTree } from '../scheduler-host/proc-util.js';
import { CompanionImportError } from './types.js';

/** Inherit OS execution basics only; proxy/auth/runtime injection must be explicitly selected. */
export function importedProcessEnvironment(selected: NodeJS.ProcessEnv = {}, host: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const basics = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']);
  const nameOf = (name: string) => platform === 'win32' ? name.toUpperCase() : name;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) if (typeof value === 'string' && basics.has(name.toUpperCase())) env[nameOf(name)] = value;
  for (const [name, value] of Object.entries(selected)) if (typeof value === 'string') env[nameOf(name)] = value;
  return env;
}

/** Imported commands get a private subprocess environment; the host environment is never mutated. */
export function runImportedProcess(input: {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number;
  windowsVerbatimArguments?: boolean;
  signal: AbortSignal; assertOwner(): void;
}): Promise<{ stdout: string; exitCode: number }> {
  input.assertOwner();
  if (input.signal.aborted) return Promise.reject(new CompanionImportError('AUTOMATION_CANCELLED'));
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env,
      detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: input.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0; const chunks: Buffer[] = [];
    let failure: string | undefined; let settled = false;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timeout); clearInterval(ownerTimer); clearTimeout(forced); input.signal.removeEventListener('abort', abort); };
    const finish = (code: number | null) => {
      if (settled) return; settled = true; cleanup();
      if (failure) reject(new CompanionImportError(failure));
      else { try { input.assertOwner(); resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: code ?? 1 }); } catch { reject(new CompanionImportError('OWNER_CHANGED')); } }
    };
    const stop = (reason: string) => {
      if (failure || settled) return;
      failure = reason;
      killProcessTree(child.pid, child, () => { forced = setTimeout(() => finish(null), 2000); });
    };
    const abort = () => stop('AUTOMATION_CANCELLED');
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    const timeout = setTimeout(() => stop('AUTOMATION_TIMEOUT'), input.timeoutMs);
    const ownerTimer = setInterval(() => { try { input.assertOwner(); } catch { stop('OWNER_CHANGED'); } }, 250);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop('AUTOMATION_OUTPUT_TOO_LARGE'); else chunks.push(chunk); });
    // stderr can contain request headers, tokens and source URLs. Never send it to logs or models.
    child.stderr.resume();
    child.once('error', () => { failure = 'AUTOMATION_COMMAND_FAILED'; finish(null); });
    child.once('close', finish);
  });
}

/** Recognisable ordinary settings keep their meaning; arbitrary keys remain private. */
export function isPublicImportSetting(name: string, value: string): boolean {
  return /^(LANG|LANGUAGE|LC_ALL|LC_CTYPE)$/i.test(name) && /^(?:C|POSIX|[a-z]{2,3}(?:[_-][a-z]{2})?)(?:\.UTF-?8)?$/i.test(value)
    || /^(?:[A-Z0-9]+_)*REGION$/i.test(name) && /^(?:[a-z]{2}|global|[a-z]{2}(?:-[a-z]+)+-\d)$/i.test(value)
    || /^(?:DEBUG|VERBOSE|CI|NO_COLOR|FORCE_COLOR)$/i.test(name) && /^(?:true|false|0|1)$/i.test(value)
    || /^(?:PORT|HTTP_PORT|HTTPS_PORT|SERVER_PORT|APP_PORT)$/i.test(name) && /^\d{1,5}$/.test(value) && Number(value) <= 65535
    || /^LOG_LEVEL$/i.test(name) && /^(?:trace|debug|info|warn|warning|error|fatal|silent)$/i.test(value)
    || /^NODE_ENV$/i.test(name) && /^(?:development|production|test)$/i.test(value);
}

export function environmentRedactions(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => !isPublicImportSetting(name, value) && value.length > 0));
}

export function redactEnvironmentValues(text: string, env: Record<string, string>, onMatch?: (value: string) => void): string {
  // Unknown variable names remain private. Short values match whole tokens so
  // "us" cannot corrupt "status"; exact short credentials are still masked.
  // Match in one pass so replacements cannot redact each other.
  const values = new Map(Object.entries(environmentRedactions(env)).map(([name, value]) => [value, `[${name}]`]));
  if (!values.size) return text;
  const pattern = [...values.keys()].sort((a, b) => b.length - a.length)
    .map(value => {
      const literal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return value.length < 8 ? `(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])` : literal;
    }).join('|');
  return text.replace(new RegExp(pattern, 'gu'), value => { onMatch?.(value); return values.get(value)!; });
}

/** Redact untrusted keys and string values without corrupting JSON numbers or booleans. */
export function redactEnvironmentData<T>(value: T, env: Record<string, string>): T {
  if (typeof value === 'string') return redactEnvironmentValues(value, env) as T;
  if (Array.isArray(value)) return value.map(child => redactEnvironmentData(child, env)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [redactEnvironmentValues(key, env), redactEnvironmentData(child, env)])) as T;
  return value;
}
