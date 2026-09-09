/**
 * FilteredAgent — `ssh2.BaseAgent` wrapper that exposes ONLY the identity
 * matching a given public-key fingerprint.
 *
 * Why this exists:
 *   ssh2's default agent integration enumerates every identity in the user's
 *   ssh-agent and offers them all to the server. Servers enforce
 *   `MaxAuthTries` (default 6 on OpenSSH); with a busy agent (>6 keys) the
 *   connection gets dropped before the *right* key is reached, producing the
 *   classic "Too many authentication failures" disconnect — even though the
 *   correct key is sitting right there in the agent.
 *
 *   OpenSSH CLI solves this with `IdentityFile <key> + IdentitiesOnly yes`
 *   in ~/.ssh/config: it reads the .pub, asks the agent for identities,
 *   filters down to the single matching one, and offers exactly that. We
 *   replicate that behaviour here so xdt-maker hosts pinned to a specific
 *   key benefit from the same single-shot auth path.
 *
 *   We deliberately delegate `sign` straight through to the upstream agent
 *   so the key's passphrase (if any) stays cached where it always was —
 *   in ssh-agent / macOS Keychain — rather than forcing the user to retype
 *   it on every connect.
 */

import crypto from 'node:crypto';
import { BaseAgent, createAgent, type ParsedKey, type PublicKeyEntry, type SignCallback, type SigningRequestOptions } from 'ssh2';

/** SHA256 base64 (without trailing `=` and without the `SHA256:` prefix). */
export function rawFingerprintOfPublicKey(blob: Buffer): string {
  return crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** OpenSSH-style `SHA256:...` fingerprint of a parsed key. */
export function sshFingerprint(key: ParsedKey): string {
  return `SHA256:${rawFingerprintOfPublicKey(key.getPublicSSH())}`;
}

/**
 * ssh2's `IdentityCallback` may return either bare `ParsedKey`s or
 * `PublicKeyEntry` wrappers ({ pubKey: ParsedKey | nested }). In practice
 * `OpenSSHAgent.getIdentities` returns bare ParsedKey[], but the type
 * permits the wrapper form. Unwrap here so the filter logic only deals
 * with one shape.
 */
function asParsedKey(item: ParsedKey | PublicKeyEntry): ParsedKey | null {
  // Bare ParsedKey case — has getPublicSSH directly. Cast away through unknown
  // so the structural test isn't undermined by the PublicKeyEntry branch's
  // narrower shape (PublicKeyEntry has `pubKey`, not `getPublicSSH`).
  const candidate = item as unknown as { getPublicSSH?: unknown; pubKey?: unknown };
  if (typeof candidate.getPublicSSH === 'function') {
    return candidate as unknown as ParsedKey;
  }
  // PublicKeyEntry — `{ pubKey: ParsedKey | { pubKey: ... } }`. May be
  // singly or doubly nested per the ssh2 type definition.
  const inner = candidate.pubKey as unknown as { getPublicSSH?: unknown; pubKey?: unknown };
  if (inner && typeof inner.getPublicSSH === 'function') {
    return inner as unknown as ParsedKey;
  }
  if (inner && inner.pubKey && typeof (inner.pubKey as { getPublicSSH?: unknown }).getPublicSSH === 'function') {
    return inner.pubKey as unknown as ParsedKey;
  }
  return null;
}

/**
 * Wraps an upstream `BaseAgent` (typically `OpenSSHAgent` / `PageantAgent` /
 * `CygwinAgent` produced by `createAgent`) and exposes only the identity
 * whose fingerprint matches `allowedFingerprint`. Sign calls pass through
 * unmodified so the agent's signing capability (and any cached passphrase)
 * is still what does the crypto.
 *
 * If the desired fingerprint is not currently loaded in the upstream agent,
 * `getIdentities` resolves with an empty array — the ssh2 client will then
 * fail with "no matching authentication method" rather than silently fall
 * back to enumerating every agent key. Callers map this to a "load the key
 * into ssh-agent first" hint.
 */
export class FilteredAgent extends BaseAgent<ParsedKey> {
  private readonly upstream: BaseAgent<ParsedKey>;
  /** Full `SHA256:...` forms, de-duplicated in OpenSSH configuration order. */
  private readonly allowedFingerprints: string[];

  constructor(upstream: BaseAgent<ParsedKey>, allowedFingerprints: string | readonly string[]) {
    super();
    this.upstream = upstream;
    const values = typeof allowedFingerprints === 'string'
      ? [allowedFingerprints]
      : [...allowedFingerprints];
    this.allowedFingerprints = values.filter((value, index) => values.indexOf(value) === index);
    if (this.allowedFingerprints.length === 0) {
      throw new Error('FilteredAgent requires at least one allowed fingerprint');
    }
  }

  getIdentities(cb: (err: Error | undefined, publicKeys?: ParsedKey[]) => void): void {
    this.upstream.getIdentities((err, keys) => {
      if (err) return cb(err);
      const byFingerprint = new Map<string, ParsedKey>();
      for (const item of keys ?? []) {
        const key = asParsedKey(item);
        if (key) byFingerprint.set(sshFingerprint(key), key);
      }
      // OpenSSH offers configured identities in configuration order. Agent
      // enumeration order is unrelated and can hit MaxAuthTries first.
      const matches = this.allowedFingerprints
        .map((fingerprint) => byFingerprint.get(fingerprint))
        .filter((key): key is ParsedKey => key !== undefined);
      cb(undefined, matches);
    });
  }

  sign(pubKey: ParsedKey, data: Buffer, options: SigningRequestOptions, cb?: SignCallback): void;
  sign(pubKey: ParsedKey, data: Buffer, cb: SignCallback): void;
  sign(
    pubKey: ParsedKey,
    data: Buffer,
    optsOrCb: SigningRequestOptions | SignCallback,
    cb?: SignCallback,
  ): void {
    // Defer to upstream. The signature for sign() varies — handle both arities.
    if (typeof optsOrCb === 'function') {
      this.upstream.sign(pubKey, data, optsOrCb);
    } else {
      this.upstream.sign(pubKey, data, optsOrCb, cb);
    }
  }
}

export function createFilteredAgentFromFingerprints(
  fingerprints: readonly string[],
  agentEndpoint: string,
): FilteredAgent {
  const upstream = createAgent(agentEndpoint) as BaseAgent<ParsedKey>;
  return new FilteredAgent(upstream, fingerprints);
}
