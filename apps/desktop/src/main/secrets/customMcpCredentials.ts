import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveOwnerScopedSecretStorageKey } from './providerSecretStore.js';
import { customMcpSecretStorageKey } from '../../shared/providerSecrets.js';

export interface McpCredentials {
  token: string;
  headers: Record<string, string>;
}
interface Bundle extends McpCredentials {
  version: 1;
  serverId: string;
  url: string;
  transport: string;
}
function fileFor(key: string): string {
  const scoped = resolveOwnerScopedSecretStorageKey(key);
  if (!scoped) throw new Error('OWNER_CHANGED');
  return path.join(app.getPath('userData'), 'safe-storage', scoped + '.enc');
}
function read(key: string): string | null {
  const file = fileFor(key);
  let encoded: string;
  try {
    encoded = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('SECRET_UNREADABLE');
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error();
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    throw new Error('SECRET_UNREADABLE');
  }
}
/** Absence and unreadable material are deliberately distinct. No anonymous fallback. */
export function readLegacyMcpToken(id: string): string | null {
  return read(customMcpSecretStorageKey(id));
}
export function hasLegacyMcpToken(id: string): boolean {
  return fs.existsSync(fileFor(customMcpSecretStorageKey(id)));
}

/** Immutable, encrypted file before the database reference becomes visible. */
export function writeMcpCredentials(
  server: { id: string; url: string; transport: string },
  credentials: McpCredentials,
): string | null {
  if (!credentials.token && !Object.keys(credentials.headers).length) return null;
  const ref = 'mcp_bundle_' + (credentials.token ? 't_' : 'h_') + randomBytes(16).toString('hex');
  const file = fileFor(ref);
  const temporary = file + '.tmp';
  try {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')
    )
      throw new Error();
    const bundle: Bundle = {
      version: 1,
      serverId: server.id,
      url: server.url,
      transport: server.transport,
      ...credentials,
    };
    const cipher = safeStorage.encryptString(JSON.stringify(bundle));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, cipher.toString('base64'), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
    return ref;
  } catch {
    throw new Error('SECRET_STORE_UNAVAILABLE');
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* no plaintext, no replacement of old files */
    }
  }
}
export function readMcpCredentials(
  server: { id: string; url: string; transport: string },
  ref: string | null,
): McpCredentials {
  if (ref === null) return { token: '', headers: {} };
  if (!/^mcp_bundle_[th]_[a-f0-9]{32}$/.test(ref)) throw new Error('SECRET_UNREADABLE');
  try {
    const value = read(ref);
    if (value === null) throw new Error();
    const b = JSON.parse(value) as Bundle;
    if (
      b.version !== 1 ||
      b.serverId !== server.id ||
      b.url !== server.url ||
      b.transport !== server.transport ||
      typeof b.token !== 'string' ||
      !b.headers ||
      typeof b.headers !== 'object' ||
      Array.isArray(b.headers) ||
      Object.values(b.headers).some((v) => typeof v !== 'string')
    )
      throw new Error();
    return { token: b.token, headers: b.headers };
  } catch {
    throw new Error('SECRET_UNREADABLE');
  }
}
