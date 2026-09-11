import { describe, expect, it } from 'vitest';
import {
  credentialSigningIdentity,
  credentialSigningArguments,
  credentialVerificationArguments,
} from '../credentialSigning';

describe('development credential helper signing', () => {
  it.each([undefined, '', '-', 'Apple Development', 'a'.repeat(39)])(
    'rejects absent or ambiguous signing identity: %s',
    (value) => {
      expect(() => credentialSigningIdentity(value)).toThrow(
        'CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED',
      );
    },
  );

  it('uses one stable identifier across source hashes and requires an Apple signature on cached helpers', () => {
    const identity = 'a'.repeat(40);
    const first = credentialSigningArguments(identity, '/cache/first/helper');
    const second = credentialSigningArguments(identity, '/cache/second/helper');
    expect(first.slice(0, -1)).toEqual(second.slice(0, -1));
    expect(first).toContain(identity.toUpperCase());
    expect(first).not.toContain('-');
    expect(credentialVerificationArguments('/cache/helper', identity)).toContain(
      `=anchor apple generic and identifier "co.cindy.remote-credentials.development" and certificate leaf = H"${identity.toUpperCase()}"`,
    );
  });
});
