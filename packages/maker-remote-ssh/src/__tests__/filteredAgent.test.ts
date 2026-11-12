/**
 * Tests for FilteredAgent — wraps an upstream ssh-agent so only the
 * identity matching a target fingerprint is offered to the server.
 *
 * Why these tests matter:
 *   FilteredAgent is what makes "pinned key + agent" mode dodge OpenSSH
 *   MaxAuthTries when the agent holds many keys. A bug in the fingerprint
 *   match (off-by-one in base64 trim, wrong hash algo, wrapper-unwrap
 *   missing a case) silently degrades back to enumerating every key,
 *   tripping the very disconnect this class was built to avoid.
 *
 *   Pure-logic surface: getIdentities() + the fingerprint helpers.
 *   No real ssh-agent needed — mock upstream + mock ParsedKey suffices.
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BaseAgent, type ParsedKey, type PublicKeyEntry, type SignCallback, type SigningRequestOptions } from 'ssh2';

import {
  FilteredAgent,
  rawFingerprintOfPublicKey,
  sshFingerprint,
} from '../filteredAgent.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the minimum object that satisfies the bits of ParsedKey we exercise
 * (FilteredAgent only calls `getPublicSSH()`). Avoids pulling real ssh2 key
 * parsing into the test.
 */
function makeKey(pubBytes: Buffer): ParsedKey {
  return {
    getPublicSSH: () => pubBytes,
  } as unknown as ParsedKey;
}

/** Wrap a ParsedKey in the doubly-nested PublicKeyEntry form ssh2 also accepts. */
function makeNestedKey(pubBytes: Buffer): PublicKeyEntry {
  return {
    pubKey: { pubKey: makeKey(pubBytes) },
  } as unknown as PublicKeyEntry;
}

/**
 * Mock BaseAgent that returns a fixed list of identities. Not exercising
 * sign() here — FilteredAgent.sign() is pure pass-through, covered separately
 * if/when sign behaviour grows logic.
 */
class MockUpstreamAgent extends BaseAgent<ParsedKey> {
  constructor(
    private readonly keys: Array<ParsedKey | PublicKeyEntry>,
    private readonly error: Error | null = null,
  ) {
    super();
  }
  getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void): void {
    if (this.error) return cb(this.error);
    cb(undefined, this.keys as ParsedKey[]);
  }
  sign(_pubKey: ParsedKey, _data: Buffer, _optsOrCb: SigningRequestOptions | SignCallback, _cb?: SignCallback): void {
    // unused in these tests
  }
}

// ── fingerprint helpers ──────────────────────────────────────────────────────

describe('rawFingerprintOfPublicKey', () => {
  it('returns SHA256 base64 of the bytes, without trailing = padding', () => {
    const blob = Buffer.from('hello world');
    const expected = crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
    expect(rawFingerprintOfPublicKey(blob)).toBe(expected);
    // Sanity: no trailing = signs.
    expect(rawFingerprintOfPublicKey(blob)).not.toMatch(/=+$/);
  });

  it('differs for different inputs', () => {
    const a = rawFingerprintOfPublicKey(Buffer.from('a'));
    const b = rawFingerprintOfPublicKey(Buffer.from('b'));
    expect(a).not.toBe(b);
  });
});

describe('sshFingerprint', () => {
  it('prefixes raw fingerprint with "SHA256:"', () => {
    const blob = Buffer.from('test-key-bytes');
    const key = makeKey(blob);
    expect(sshFingerprint(key)).toBe(`SHA256:${rawFingerprintOfPublicKey(blob)}`);
  });
});

// ── FilteredAgent.getIdentities ──────────────────────────────────────────────

describe('FilteredAgent.getIdentities', () => {
  it('returns only the key whose fingerprint matches', async () => {
    const blobA = Buffer.from('keyA-pub-bytes');
    const blobB = Buffer.from('keyB-pub-bytes');
    const blobC = Buffer.from('keyC-pub-bytes');
    const keyA = makeKey(blobA);
    const keyB = makeKey(blobB);
    const keyC = makeKey(blobC);

    const targetFingerprint = sshFingerprint(keyB);
    const upstream = new MockUpstreamAgent([keyA, keyB, keyC]);
    const filtered = new FilteredAgent(upstream, targetFingerprint);

    const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
      filtered.getIdentities((err, ks) => (err ? reject(err) : resolve(ks ?? [])));
    });

    expect(keys).toHaveLength(1);
    expect(sshFingerprint(keys[0])).toBe(targetFingerprint);
  });

  it('returns multiple keys in configured order rather than upstream order', async () => {
    const keyA = makeKey(Buffer.from('ordered-a'));
    const keyB = makeKey(Buffer.from('ordered-b'));
    const keyC = makeKey(Buffer.from('ordered-c'));
    const filtered = new FilteredAgent(
      new MockUpstreamAgent([keyA, keyB, keyC]),
      [sshFingerprint(keyC), sshFingerprint(keyA), sshFingerprint(keyC)],
    );

    const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
      filtered.getIdentities((err, values) => (err ? reject(err) : resolve(values ?? [])));
    });

    expect(keys.map(sshFingerprint)).toEqual([
      sshFingerprint(keyC),
      sshFingerprint(keyA),
    ]);
  });

  it('rejects an empty allow-list instead of exposing every agent identity', () => {
    expect(() => new FilteredAgent(new MockUpstreamAgent([]), [])).toThrow(
      'requires at least one allowed fingerprint',
    );
  });

  it('returns empty array when no upstream key matches', async () => {
    const upstream = new MockUpstreamAgent([
      makeKey(Buffer.from('only-key')),
    ]);
    const filtered = new FilteredAgent(upstream, 'SHA256:nonexistent-fingerprint');

    const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
      filtered.getIdentities((err, ks) => (err ? reject(err) : resolve(ks ?? [])));
    });

    expect(keys).toEqual([]);
  });

  it('propagates upstream errors', async () => {
    const boom = new Error('agent unreachable');
    const upstream = new MockUpstreamAgent([], boom);
    const filtered = new FilteredAgent(upstream, 'SHA256:x');

    await expect(
      new Promise<ParsedKey[]>((resolve, reject) => {
        filtered.getIdentities((err, ks) => (err ? reject(err) : resolve(ks ?? [])));
      }),
    ).rejects.toThrow('agent unreachable');
  });

  it('unwraps PublicKeyEntry wrapper form returned by some upstreams', async () => {
    const blob = Buffer.from('wrapped-key');
    const targetFingerprint = sshFingerprint(makeKey(blob));
    // Use the doubly-nested wrapper form (PublicKeyEntry → { pubKey: { pubKey: ParsedKey } })
    // which ssh2's type union permits even though OpenSSHAgent returns bare keys.
    const upstream = new MockUpstreamAgent([makeNestedKey(blob)]);
    const filtered = new FilteredAgent(upstream, targetFingerprint);

    const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
      filtered.getIdentities((err, ks) => (err ? reject(err) : resolve(ks ?? [])));
    });

    expect(keys).toHaveLength(1);
    expect(sshFingerprint(keys[0])).toBe(targetFingerprint);
  });
});
