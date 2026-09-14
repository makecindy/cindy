import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utils } from 'ssh2';

import { sshFingerprint } from './filteredAgent.js';
import type { HostConfig } from './types.js';

const MAX_PUBLIC_KEY_BYTES = 64 * 1024;

/** The configured/default SSH Agent endpoint is not currently reachable. */
export const SSH_AGENT_UNAVAILABLE_CODE = 'SSH_AGENT_UNAVAILABLE';

/** Cindy's deliberately bounded default identity subset, not all OpenSSH versions. */
export const CINDY_DEFAULT_IDENTITY_NAMES = [
  'id_rsa',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519',
  'id_ed25519_sk',
] as const;

export interface IdentityFingerprintResolution {
  fingerprints: string[];
  missing: boolean;
  invalid: boolean;
}

/** Read only public-key-shaped text; never parse/decrypt a private-key body. */
async function fingerprintPublicKeyFile(filePath: string): Promise<{
  fingerprint?: string;
  missing: boolean;
  invalid: boolean;
}> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { missing: true, invalid: false };
    }
    return { missing: false, invalid: true };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PUBLIC_KEY_BYTES) {
      return { missing: false, invalid: true };
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
    // utils.parseKey also accepts private keys. Admit only the one-line
    // OpenSSH public-key form so discovery never decrypts or interprets any
    // private-key serialization (OpenSSH, PEM, PuTTY, or otherwise).
    if (!/^(?:ssh-|ecdsa-|sk-)[^\s]+\s+[A-Za-z0-9+/=]+(?:\s|$)/.test(text)) {
      return { missing: false, invalid: true };
    }
    const parsed = utils.parseKey(text);
    if (parsed instanceof Error) return { missing: false, invalid: true };
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key) return { missing: false, invalid: true };
    return { fingerprint: sshFingerprint(key), missing: false, invalid: false };
  } catch {
    return { missing: false, invalid: true };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Resolve one OpenSSH IdentityFile entry using only the path itself or its
 * conventional `${path}.pub` sibling. An already-public `.pub` path is never
 * extended again, and Cindy intentionally does not guess custom names such as
 * `lab.key -> lab.pub`.
 */
export async function resolveIdentityFingerprints(
  identityPath: string,
): Promise<IdentityFingerprintResolution> {
  const candidates = identityPath.toLowerCase().endsWith('.pub')
    ? [identityPath]
    : [identityPath, `${identityPath}.pub`];
  let anyPresent = false;
  let anyInvalid = false;
  for (const candidate of candidates) {
    const result = await fingerprintPublicKeyFile(candidate);
    if (!result.missing) anyPresent = true;
    if (result.invalid) anyInvalid = true;
    if (result.fingerprint) {
      return { fingerprints: [result.fingerprint], missing: false, invalid: false };
    }
  }
  return {
    fingerprints: [],
    missing: !anyPresent,
    invalid: anyPresent && anyInvalid,
  };
}

export function defaultIdentityPaths(): string[] {
  return CINDY_DEFAULT_IDENTITY_NAMES.map((name) => path.join(os.homedir(), '.ssh', name));
}

export function defaultAgentEndpoint(): string | undefined {
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return process.env.SSH_AUTH_SOCK;
}

function expandEnvironment(value: string): { value?: string; error?: string } {
  let missing = false;
  const expanded = value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced: string | undefined, plain: string | undefined) => {
      const name = braced ?? plain!;
      const replacement = process.env[name];
      if (replacement === undefined) {
        missing = true;
        return '';
      }
      return replacement;
    },
  );
  return missing
    ? { error: 'the configured IdentityAgent environment variable is not set' }
    : { value: expanded };
}

export function previewAgentEndpoint(identityAgent?: string): {
  endpoint?: string;
  unsupportedReason?: string;
  unavailableReason?: string;
  explicit: boolean;
} {
  if (identityAgent === undefined) {
    return { endpoint: defaultAgentEndpoint(), explicit: false };
  }
  if (identityAgent === 'none') {
    return {
      unsupportedReason: 'IdentityAgent none disables SSH Agent authentication',
      explicit: true,
    };
  }
  if (identityAgent.includes('%')) {
    return {
      unsupportedReason: 'Cindy does not support percent-token expansion in IdentityAgent',
      explicit: true,
    };
  }
  const source = identityAgent === 'SSH_AUTH_SOCK' ? '$SSH_AUTH_SOCK' : identityAgent;
  const expanded = expandEnvironment(source);
  if (expanded.error) return { unavailableReason: expanded.error, explicit: true };
  let endpoint = expanded.value!;
  if (endpoint === '~') endpoint = os.homedir();
  else if (endpoint.startsWith('~/') || endpoint.startsWith('~\\')) {
    endpoint = path.join(os.homedir(), endpoint.slice(2).replace(/\\/g, '/'));
  }
  if (!endpoint) {
    return { unavailableReason: 'the configured IdentityAgent endpoint is empty', explicit: true };
  }
  return { endpoint, explicit: true };
}

function throwAgentUnavailable(reason: string): never {
  const error = new Error(reason);
  (error as { code?: string }).code = SSH_AGENT_UNAVAILABLE_CODE;
  throw error;
}

export async function resolveAgentEndpoint(identityAgent?: string): Promise<string> {
  const preview = previewAgentEndpoint(identityAgent);
  if (preview.unsupportedReason) throw new Error(preview.unsupportedReason);
  if (preview.unavailableReason) throwAgentUnavailable(preview.unavailableReason);
  if (!preview.endpoint) {
    throwAgentUnavailable(
      process.platform === 'win32'
        ? 'OpenSSH agent named pipe not available. Start the "OpenSSH Authentication Agent" service.'
        : '$SSH_AUTH_SOCK is not set. Start ssh-agent and `ssh-add` your key first.',
    );
  }
  if (preview.explicit && process.platform !== 'win32') {
    try {
      const stat = await fs.stat(preview.endpoint);
      if (!stat.isSocket()) throw new Error('not a socket');
    } catch {
      throwAgentUnavailable('the configured IdentityAgent endpoint is unavailable');
    }
  }
  return preview.endpoint;
}

/** Stable comparison key shared by main connections and Agent Proxy tunnels. */
export function effectiveAuthenticationFingerprint(host: HostConfig): string {
  if (host.authMethod === 'key') {
    return JSON.stringify({
      method: 'key',
      identityFile: host.identityFile ?? null,
      unsupportedReason: host.sshAuthentication?.unsupportedReason ?? null,
    });
  }
  const metadata = host.sshAuthentication;
  const endpoint = previewAgentEndpoint(metadata?.identityAgent);
  return JSON.stringify({
    method: 'agent',
    marker: metadata?.marker ?? null,
    explicitPin: host.identityFile ?? null,
    identitiesOnly: metadata?.identitiesOnly ?? false,
    endpoint: endpoint.endpoint ?? null,
    endpointUnsupported: endpoint.unsupportedReason ?? null,
    endpointUnavailable: endpoint.unavailableReason ?? null,
    configuredIdentityFiles: metadata?.configuredIdentityFiles ?? [],
    allowedAgentFingerprints: metadata?.allowedAgentFingerprints ?? null,
    unsupportedReason: metadata?.unsupportedReason ?? null,
  });
}
