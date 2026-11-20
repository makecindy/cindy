import path from 'node:path';
import { homedir } from 'node:os';
import type { RemoteTerminalConnection, RemoteTerminalContext, RemoteTerminalDescription } from '../../shared/terminal-bridge.js';
import type { CreateOptions } from './ptyManager.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Runtime adapter keeps account, database and device-link dependencies out of the PTY manager. */
export interface RemoteTerminalRuntime {
  scope(): string;
  ownerKey(): string;
  describe(context: RemoteTerminalContext): Promise<RemoteTerminalDescription>;
  prepare(connection: RemoteTerminalConnection, cwd: string, key: string, scope: string, assertCurrent: () => void): Promise<Pick<CreateOptions, 'launch' | 'cwd'>>;
  save(key: string, connection: RemoteTerminalConnection, scope: string, assertCurrent: () => void): Promise<void>;
  onInvalidated(callback: (disposeSessions: boolean) => void): void;
}

function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    return throwIpcError('INVALID_PARAMS', `Invalid ${name}`);
  }
  return value;
}

export function parseRemoteContext(raw: unknown): RemoteTerminalContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return throwIpcError('INVALID_PARAMS', 'Missing task context');
  const value = raw as Record<string, unknown>;
  return {
    sessionId: text(value.sessionId, 'sessionId', 256),
    deviceId: value.deviceId == null ? null : text(value.deviceId, 'deviceId', 256),
  };
}

export function remoteContextKey(context: RemoteTerminalContext): string {
  return JSON.stringify([context.deviceId ?? null, context.sessionId]);
}

/** Credential paths are main-only, including legacy persisted bindings. */
export interface InternalRemoteTerminalConnection extends Omit<RemoteTerminalConnection, 'hostRef'> {
  identityFile?: string;
}

export function parseRemoteConnection(raw: unknown): RemoteTerminalConnection {
  if (raw && typeof raw === 'object' && 'identityFile' in raw) return throwIpcError('INVALID_PARAMS', 'Credential paths are not accepted');
  const connection = parseStoredRemoteConnection(raw);
  const value = raw as Record<string, unknown>;
  const hostRef = value.hostRef === undefined ? undefined : text(value.hostRef, 'SSH host reference', 128);
  return { host: connection.host, user: connection.user, port: connection.port, ...(hostRef ? { hostRef } : {}) };
}

export function parseStoredRemoteConnection(raw: unknown): InternalRemoteTerminalConnection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return throwIpcError('INVALID_PARAMS', 'Missing SSH connection');
  const value = raw as Record<string, unknown>;
  const host = text(value.host, 'SSH host', 253);
  if (!/^[a-zA-Z0-9_.:][a-zA-Z0-9_.:\-]*$/.test(host)) return throwIpcError('INVALID_PARAMS', 'Invalid SSH host');
  const user = value.user === undefined ? undefined : text(value.user, 'SSH user', 128);
  if (user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/.test(user)) return throwIpcError('INVALID_PARAMS', 'Invalid SSH user');
  const port = value.port;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return throwIpcError('INVALID_PARAMS', 'Invalid SSH port');
  }
  const identityFile = value.identityFile === undefined ? undefined : text(value.identityFile, 'identity file');
  if (identityFile && !(path.posix.isAbsolute(identityFile) || path.win32.isAbsolute(identityFile) || identityFile.startsWith('~/'))) {
    return throwIpcError('INVALID_PARAMS', 'Identity file must be absolute or home-relative');
  }
  return { host, user, port: port as number | undefined, identityFile };
}

/** Metadata is authoritative; nested SSH host IDs are namespaced by the owning device. */
export async function describeRemoteTerminal(context: RemoteTerminalContext, deps: {
  task(): Promise<{ workingDir?: unknown; remoteHostId?: unknown; status?: unknown } | null>;
  hosts(): Promise<Array<{ id: string; hostname: string; user: string; port: number; identityFile?: string; source?: string }>>;
  binding(key: string): InternalRemoteTerminalConnection | undefined;
  project(connection: InternalRemoteTerminalConnection, source: 'host' | 'binding', key: string): RemoteTerminalConnection;
}): Promise<RemoteTerminalDescription> {
  const task = await deps.task();
  if (!task || task.status === 'deleted') return throwIpcError('NOT_FOUND', 'Task is unavailable');
  const cwd = remoteCwd(task.workingDir);
  if (task.remoteHostId !== null && typeof task.remoteHostId !== 'string') return throwIpcError('PRECONDITION_FAILED', 'Incomplete task metadata');
  if (!context.deviceId && !task.remoteHostId) return throwIpcError('PRECONDITION_FAILED', 'Task files are local');
  const key = JSON.stringify([context.deviceId ?? null, task.remoteHostId]);
  const hosts = await deps.hosts();
  // OpenSSH must interpret aliases itself: the pool cannot fully resolve Match/Include.
  const toConnection = (host: typeof hosts[number]): RemoteTerminalConnection => deps.project(connectionForHost(host), 'host', host.id);
  const candidates = hosts.flatMap(host => { try { return [toConnection(host)]; } catch { return []; } });
  const ownHost = !context.deviceId ? hosts.find(host => host.id === task.remoteHostId) : undefined;
  return {
    context,
    target: { key, label: String(task.remoteHostId || context.deviceId), cwd },
    connection: (() => {
      const binding = deps.binding(key);
      return binding ? deps.project(binding, 'binding', key) : (ownHost ? toConnection(ownHost) : null);
    })(),
    candidates,
  };
}

export function connectionForHost(host: { id: string; hostname: string; user: string; port: number; identityFile?: string; source?: string }): InternalRemoteTerminalConnection {
  return parseStoredRemoteConnection(host.source === 'ssh-config' ? { host: host.id } : {
    host: host.hostname, user: host.user || undefined, port: host.port, identityFile: host.identityFile,
  });
}

/** Inner command is interpreted by /bin/sh; cwd is always data, never shell syntax. */
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
/** Fish preserves \` in double quotes, so join literal backticks as single-quoted segments. */
const quoteForLoginShell = (value: string): string => value.split('`')
  .map(part => `"${part.replace(/[\\"$]/g, '\\$&')}"`)
  .join("'`'");

function remoteCwd(value: unknown): string {
  const cwd = text(value, 'remote cwd');
  if (!cwd.startsWith('/') || cwd.startsWith('//')) {
    return throwIpcError('PRECONDITION_FAILED', 'Remote terminal requires a POSIX directory; Windows targets are unsupported');
  }
  return cwd;
}

/** No cwd fallback: failed cd ends the SSH session before an interactive shell can run. */
export function remoteShellScript(cwd: string): string {
  return `cd -- ${quote(remoteCwd(cwd))} && exec "\${SHELL:-/bin/sh}" -l`;
}

/** Launch OpenSSH directly, including on Windows controllers; never via cmd/PowerShell. */
export function remoteLaunch(connection: InternalRemoteTerminalConnection, cwd: string, platform: NodeJS.Platform = process.platform): Pick<CreateOptions, 'launch' | 'cwd'> {
  const validated = parseStoredRemoteConnection(connection);
  const args = ['-tt', '-o', 'StrictHostKeyChecking=ask', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  if (validated.user) args.push('-l', validated.user);
  if (validated.port) args.push('-p', String(validated.port));
  if (validated.identityFile) args.push('-i', validated.identityFile);
  // Escape for the login shell first, then let /bin/sh interpret the inner command.
  args.push('--', validated.host, `/bin/sh -c ${quoteForLoginShell(remoteShellScript(cwd))}`);
  return {
    cwd: homedir(),
    launch: { id: 'sh', command: platform === 'win32' ? 'ssh.exe' : 'ssh', args, displayName: `SSH · ${validated.host}` },
  };
}
