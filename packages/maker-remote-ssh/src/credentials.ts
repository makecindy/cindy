/**
 * Credential resolution for a single connect attempt.
 *
 * Three auth paths, picked from HostConfig:
 *   1. SSH agent, unfiltered  (authMethod='agent', no identityFile)
 *        → enumerate every key in the agent. Risks tripping MaxAuthTries
 *          when the agent holds many keys; fine for users with 1-2.
 *   2. SSH agent, pinned to an ordered key set
 *        → an explicit Cindy marker pin or effective `IdentitiesOnly yes`
 *          supplies public-key fingerprints. FilteredAgent offers only those
 *          identities, in SSH config order. The agent still owns any cached
 *          passphrases; Cindy never decrypts private keys for this path.
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

import { createFilteredAgentFromFingerprints } from './filteredAgent.js';
import {
  resolveAgentEndpoint,
  resolveIdentityFingerprints,
  SSH_AGENT_UNAVAILABLE_CODE,
} from './sshAuthentication.js';
import type { HostConfig } from './types.js';

/**
 * Stable local code tagged onto the ENOENT identityFile error so the connect
 * IPC layer can classify it as SSH_KEY_FILE_NOT_FOUND WITHOUT pattern-matching
 * the message text (see resolveAuth). Only set by our own code — a remote SSH
 * server can never produce it.
 */
export const KEY_FILE_NOT_FOUND_CODE = 'KEY_FILE_NOT_FOUND';
/** 轮 21-W2 MEDIUM:本地 key 读取的其它确定性错误(EACCES/EISDIR/格式)——
 *  与 ENOENT 一样是「本地配置问题」, 不能落进 SSH_AUTH_FAILED 语义。 */
export const KEY_FILE_UNREADABLE_CODE = 'KEY_FILE_UNREADABLE';
/** 轮 21-W2 MEDIUM:agent + pinned-key 解析失败(缺 .pub/内容非法/不匹配)——
 *  确定性本地配置错误, 不应落进 SSH_CONNECT_FAILED(可重试语义)。 */
export const PINNED_AGENT_FAILED_CODE = 'PINNED_AGENT_FAILED';
/** Cindy can discover an SSH config it cannot faithfully express in ssh2. */
export const SSH_CONFIG_AUTH_UNSUPPORTED_CODE = 'SSH_CONFIG_AUTH_UNSUPPORTED';

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

export async function resolveAuth(host: HostConfig): Promise<ResolvedAuth> {
  // Discovery may retain a host in the list while marking it unsupported so
  // the UI can explain why Cindy cannot faithfully reproduce the SSH config.
  // This guard must run before either auth branch; otherwise a marked key host
  // could still connect to a default endpoint after Match directives were
  // ignored.
  if (host.sshAuthentication?.unsupportedReason) {
    throwUnsupported(host.sshAuthentication.unsupportedReason);
  }

  if (host.authMethod === 'agent') {
    let allowedFingerprints = host.sshAuthentication?.allowedAgentFingerprints;

    // A marker-authenticated agent host may carry an explicit Cindy pin even
    // when IdentitiesOnly is no. External IdentityFile metadata never enters
    // HostConfig.identityFile, so it cannot accidentally become a pin.
    if (!allowedFingerprints && host.identityFile) {
      const resolved = await resolveIdentityFingerprints(host.identityFile);
      allowedFingerprints = resolved.fingerprints;
      if (allowedFingerprints.length === 0) {
        const e = new Error(
          `agent + pinned key failed: ${host.identityFile} is not a readable public key `
          + `and its .pub sibling is unavailable or invalid`,
        );
        (e as { code?: string }).code = PINNED_AGENT_FAILED_CODE;
        throw e;
      }
    }

    // Validate deterministic configuration limits before touching the local
    // Agent endpoint. This keeps a missing SSH_AUTH_SOCK from masking the
    // more actionable IdentitiesOnly capability error (and makes the result
    // independent of whether an Agent happens to be running in the process
    // environment).
    if (host.sshAuthentication?.identitiesOnly
      && (!allowedFingerprints || allowedFingerprints.length === 0)) {
      throwUnsupported('IdentitiesOnly yes has no public key Cindy can use to pin the agent');
    }

    let endpoint: string;
    try {
      endpoint = await resolveAgentEndpoint(host.sshAuthentication?.identityAgent);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === SSH_AGENT_UNAVAILABLE_CODE) throw err;
      throwUnsupported((err as Error).message);
    }

    if (allowedFingerprints && allowedFingerprints.length > 0) {
      try {
        const filtered = createFilteredAgentFromFingerprints(allowedFingerprints, endpoint);
        return {
          agent: filtered,
          label: allowedFingerprints.length === 1
            ? 'ssh-agent[filtered]'
            : `ssh-agent[filtered:${allowedFingerprints.length}]`,
        };
      } catch (err) {
        throwUnsupported((err as Error).message);
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
      // 轮 21-W2 MEDIUM:非 ENOENT 本地读取错误(EACCES 权限/EISDIR/IO 错)也
      // 是确定性本地配置问题 —— tag KEY_FILE_UNREADABLE, 防 classifyConnectFailure
      // 按文本把 "permission denied" 误归成远端 SSH_AUTH_FAILED。
      const e = new Error(`failed to read identityFile ${host.identityFile}: ${(err as Error).message}`);
      (e as { code?: string }).code = KEY_FILE_UNREADABLE_CODE;
      throw e;
    }
    return { privateKey, label: `key:${baseName(host.identityFile)}` };
  }

  throw new Error(`unsupported authMethod: ${(host as { authMethod: string }).authMethod}`);
}

function throwUnsupported(reason: string): never {
  const error = new Error(
    `SSH config authentication is outside Cindy's supported subset: ${reason}. `
    + 'Terminal ssh may still work with this configuration.',
  );
  (error as { code?: string }).code = SSH_CONFIG_AUTH_UNSUPPORTED_CODE;
  throw error;
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
