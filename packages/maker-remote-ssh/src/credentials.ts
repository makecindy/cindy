/**
 * Credential resolution for a single connect attempt.
 *
 * Three auth paths, picked from HostConfig:
 *   1. SSH agent, unfiltered  (authMethod='agent', no identityFile)
 *        → enumerate every key in the agent. Risks tripping MaxAuthTries
 *          when the agent holds many keys; fine for users with 1-2.
 *   2. SSH agent, pinned to one key  (authMethod='agent', identityFile=<pubkey>)
 *        → wrap the agent in a FilteredAgent that only offers the matching
 *          identity. Same UX as OpenSSH CLI's `IdentitiesOnly yes` + the
 *          agent still owns the (cached) passphrase so the user doesn't
 *          retype it. This is the recommended setup for multi-host devs.
 *   3. Identity file  (authMethod='key', identityFile=<private key>)
 *        → read the file, hand the bytes straight to ssh2. Bypasses the
 *          agent entirely; encrypted keys need a passphrase per connect.
 *
 * On macOS / Linux: agent socket comes from $SSH_AUTH_SOCK.
 * On Windows: prefer OpenSSH agent's named pipe, fall back to Pageant.
 *   ssh2 accepts the named pipe path or the literal string "pageant".
 *
 * Returns an `auth` object spreadable into ssh2 `Client.connect()`.
 * Throws on unresolvable input — caller maps to IPC error.
 */

import { promises as fs } from 'node:fs';
import type { BaseAgent } from 'ssh2';

import { createFilteredAgentFromPubkey } from './filteredAgent.js';
import type { HostConfig } from './types.js';

/**
 * Stable local code tagged onto the ENOENT identityFile error so the connect
 * IPC layer can classify it as SSH_KEY_FILE_NOT_FOUND WITHOUT pattern-matching
 * the message text (see resolveAuth). Only set by our own code — a remote SSH
 * server can never produce it.
 */
export const KEY_FILE_NOT_FOUND_CODE = 'KEY_FILE_NOT_FOUND';

export interface ResolvedAuth {
  /**
   * ssh2 agent option — either a socket path / pipe string (unfiltered) OR
   * a `BaseAgent` instance (typically our FilteredAgent for the pinned-key
   * case). ssh2 happily accepts either form.
   */
  agent?: string | BaseAgent;
  /** raw private key bytes when using a key file. */
  privateKey?: Buffer;
  /** for encrypted keys — Phase A leaves undefined; caller can extend. */
  passphrase?: string;
  /** Human-readable label used in logs / errors so we don't leak the path. */
  label: string;
}

/** Detect platform default SSH agent endpoint. */
export function defaultAgentEndpoint(): string | undefined {
  if (process.platform === 'win32') {
    // OpenSSH agent (default-installed on Win10 1809+) exposes a named pipe.
    // ssh2 special-cases this path on win32; falls back to Pageant if needed.
    return '\\\\.\\pipe\\openssh-ssh-agent';
  }
  return process.env.SSH_AUTH_SOCK;
}

export async function resolveAuth(host: HostConfig): Promise<ResolvedAuth> {
  if (host.authMethod === 'agent') {
    const endpoint = defaultAgentEndpoint();
    if (!endpoint) {
      throw new Error(
        process.platform === 'win32'
          ? 'OpenSSH agent named pipe not available. Start the "OpenSSH Authentication Agent" service.'
          : '$SSH_AUTH_SOCK is not set. Start ssh-agent and `ssh-add` your key first.',
      );
    }
    // Pinned-key flavour: identityFile present alongside agent auth → we
    // treat identityFile as a *public* key reference (path may point at the
    // private key, but the matching .pub sits next to it by convention).
    // Wrap the agent so only that fingerprint gets offered, bypassing the
    // MaxAuthTries-trigger of enumerating every loaded key.
    if (host.identityFile) {
      const pubkeyPath = host.identityFile.endsWith('.pub')
        ? host.identityFile
        : `${host.identityFile}.pub`;
      try {
        const filtered = await createFilteredAgentFromPubkey(pubkeyPath, endpoint);
        return { agent: filtered, label: `ssh-agent[${baseName(pubkeyPath)}]` };
      } catch (err) {
        throw new Error(
          `agent + pinned key failed (${(err as Error).message}). ` +
          `Make sure ${pubkeyPath} exists and is a valid SSH public key, ` +
          `and that the matching private key is loaded in ssh-agent ('ssh-add ${pubkeyPath.replace(/\.pub$/, '')}').`,
        );
      }
    }
    return { agent: endpoint, label: 'ssh-agent' };
  }

  if (host.authMethod === 'key') {
    if (!host.identityFile) {
      throw new Error('authMethod=key requires identityFile');
    }
    let privateKey: Buffer;
    try {
      privateKey = await fs.readFile(host.identityFile);
    } catch (err) {
      // Tag ENOENT with KEY_FILE_NOT_FOUND_CODE so classifyConnectFailure can
      // distinguish a local path problem from network/remote errors without
      // pattern-matching the message text (see connect-failure.ts).
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const e = new Error(`identity file not found: ${host.identityFile}`);
        (e as { code?: string }).code = KEY_FILE_NOT_FOUND_CODE;
        throw e;
      }
      throw new Error(`failed to read identityFile ${host.identityFile}: ${(err as Error).message}`);
    }
    return { privateKey, label: `key:${baseName(host.identityFile)}` };
  }

  throw new Error(`unsupported authMethod: ${(host as { authMethod: string }).authMethod}`);
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
