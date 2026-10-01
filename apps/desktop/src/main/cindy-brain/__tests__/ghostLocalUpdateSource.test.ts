import { describe, expect, it } from 'vitest';
import type { GhostTrustInfo } from '../../../shared/ghost.js';
import { resolveGhostFirstPartyPrivilege } from '../ghostFirstPartyPrivilege.js';
import {
  classifyGhostLocalUpdateSource,
  type GhostLocalUpdateSourceInput,
} from '../ghostLocalUpdateSource.js';

const OLD_SHA = 'a'.repeat(64);
const NEW_SHA = 'b'.repeat(64);
const UNSIGNED: GhostTrustInfo = {
  level: 'unverified', publisherSigned: false, publisherVerified: false, reviewed: false,
};
const OFFICIAL: GhostTrustInfo = {
  level: 'cindy-official', publisherSigned: true, publisherVerified: true,
  reviewed: true, publisherName: 'Cindy Plugin Market',
};
const SIGNED: GhostTrustInfo = {
  level: 'verified-publisher', publisherSigned: true, publisherVerified: true,
  reviewed: false, publisherKeyId: 'ed25519:' + 'c'.repeat(32),
};

function input(): GhostLocalUpdateSourceInput {
  return {
    existingSourceChanged: false,
    previousApprovedReceipt: {
      id: 'filo-google', namespace: null, packageSha256: OLD_SHA,
      trust: OFFICIAL, legacyFirstPartyEligible: true,
    },
    inspectedPackage: {
      ghostId: 'filo-google', namespace: null, packageSha256: NEW_SHA, trust: UNSIGNED,
    },
  };
}

describe('local update provenance independent of legacy privileges', () => {
  it('only feeds the install gate a legacy override after proving package continuity', () => {
    for (const packageSha256 of [OLD_SHA, NEW_SHA]) {
      const facts = input();
      facts.inspectedPackage.packageSha256 = packageSha256;
      const decision = classifyGhostLocalUpdateSource(facts);
      const privilege = resolveGhostFirstPartyPrivilege({
        ghostId: 'filo-google', namespace: null, builtin: false, marketRecord: null,
        currentOrganization: null, installOrigin: 'manual',
        legacyFirstPartyEligible: decision.legacyFirstPartyEligible,
      });
      expect(privilege.brokerEligible).toBe(packageSha256 === OLD_SHA);
      expect(privilege.hostPrimitiveEligible).toBe(packageSha256 === OLD_SHA);
    }
  });

  it('isolates a ledgerless retired official instance from a new same-ID unsigned manual package', () => {
    expect(classifyGhostLocalUpdateSource(input())).toEqual({
      sourceChanged: true, legacyFirstPartyEligible: false,
    });
  });

  it('protects Host-official receipts even before a legacy qualification was captured', () => {
    const facts = input();
    facts.previousApprovedReceipt!.legacyFirstPartyEligible = false;
    expect(classifyGhostLocalUpdateSource(facts).sourceChanged).toBe(true);
  });

  it('protects captured public legacy qualification without Host-official trust', () => {
    const facts = input();
    facts.previousApprovedReceipt!.trust = UNSIGNED;
    expect(classifyGhostLocalUpdateSource(facts).sourceChanged).toBe(true);
  });

  it('retains the old qualification for the exact approved package bytes', () => {
    const facts = input();
    facts.inspectedPackage.packageSha256 = OLD_SHA;
    expect(classifyGhostLocalUpdateSource(facts)).toEqual({
      sourceChanged: false, legacyFirstPartyEligible: true,
    });
  });

  it.each(['other-id', 'other-namespace'])('does not accept exact bytes with %s', (change) => {
    const facts = input();
    facts.inspectedPackage.packageSha256 = OLD_SHA;
    if (change === 'other-id') facts.inspectedPackage.ghostId = 'filo-other';
    else facts.inspectedPackage.namespace = 'xd';
    expect(classifyGhostLocalUpdateSource(facts).sourceChanged).toBe(true);
  });

  it('does not treat an arbitrary new verified publisher or official-looking display name as continuity', () => {
    const facts = input();
    facts.inspectedPackage.trust = { ...SIGNED, publisherName: 'Cindy Plugin Market' };
    expect(classifyGhostLocalUpdateSource(facts).sourceChanged).toBe(true);
  });

  it('accepts a newly inspected signature from the previously pinned verified publisher key', () => {
    const facts = input();
    facts.previousApprovedReceipt!.trust = SIGNED;
    facts.inspectedPackage.trust = { ...SIGNED, publisherName: 'renamed publisher' };
    expect(classifyGhostLocalUpdateSource(facts)).toEqual({
      sourceChanged: false, legacyFirstPartyEligible: true,
    });
  });

  it.each(['other-key', 'unsigned', 'unverified', 'missing-key', 'unverified-old-key'])(
    'does not carry credentials or legacy qualification across %s', (change) => {
      const facts = input();
      facts.previousApprovedReceipt!.trust = { ...SIGNED };
      facts.inspectedPackage.trust = { ...SIGNED };
      if (change === 'other-key') facts.inspectedPackage.trust.publisherKeyId = 'another-key';
      if (change === 'unsigned') facts.inspectedPackage.trust.publisherSigned = false;
      if (change === 'unverified') facts.inspectedPackage.trust.publisherVerified = false;
      if (change === 'missing-key') delete facts.inspectedPackage.trust.publisherKeyId;
      if (change === 'unverified-old-key') facts.previousApprovedReceipt!.trust.publisherVerified = false;
      expect(classifyGhostLocalUpdateSource(facts)).toEqual({
        sourceChanged: true, legacyFirstPartyEligible: false,
      });
    },
  );

  it('accepts exact new bytes verified by the Host for the same current source resource', () => {
    const facts = input();
    facts.currentTrustedMarketSource = {
      resourceId: 'market-resource-1', ghostId: 'filo-google', namespace: null,
    };
    facts.hostVerifiedRelease = { ...facts.currentTrustedMarketSource, packageSha256: NEW_SHA };
    expect(classifyGhostLocalUpdateSource(facts)).toEqual({
      sourceChanged: false, legacyFirstPartyEligible: true,
    });
  });

  it.each(['no-current-source', 'other-resource', 'other-id', 'other-namespace', 'other-sha', 'empty-resource'])(
    'rejects cached source evidence with %s', (change) => {
      const facts = input();
      facts.currentTrustedMarketSource = {
        resourceId: 'market-resource-1', ghostId: 'filo-google', namespace: null,
      };
      facts.hostVerifiedRelease = { ...facts.currentTrustedMarketSource, packageSha256: NEW_SHA };
      if (change === 'no-current-source') facts.currentTrustedMarketSource = null;
      if (change === 'other-resource') facts.hostVerifiedRelease.resourceId = 'market-resource-2';
      if (change === 'other-id') facts.hostVerifiedRelease.ghostId = 'filo-other';
      if (change === 'other-namespace') facts.hostVerifiedRelease.namespace = 'xd';
      if (change === 'other-sha') facts.hostVerifiedRelease.packageSha256 = OLD_SHA;
      if (change === 'empty-resource') {
        facts.currentTrustedMarketSource!.resourceId = '';
        facts.hostVerifiedRelease.resourceId = '';
      }
      expect(classifyGhostLocalUpdateSource(facts).sourceChanged).toBe(true);
    },
  );

  it('never overrides an already established market-route or origin change, even with identical bytes', () => {
    const facts = input();
    facts.existingSourceChanged = true;
    facts.inspectedPackage.packageSha256 = OLD_SHA;
    expect(classifyGhostLocalUpdateSource(facts)).toEqual({
      sourceChanged: true, legacyFirstPartyEligible: false,
    });
  });

  it.each(['missing-receipt', 'missing-old-hash', 'invalid-old-hash', 'invalid-new-hash'])(
    'fails closed for %s', (change) => {
      const facts = input();
      facts.inspectedPackage.packageSha256 = OLD_SHA;
      if (change === 'missing-receipt') facts.previousApprovedReceipt = null;
      if (change === 'missing-old-hash') delete facts.previousApprovedReceipt!.packageSha256;
      if (change === 'invalid-old-hash') facts.previousApprovedReceipt!.packageSha256 = 'invalid';
      if (change === 'invalid-new-hash') facts.inspectedPackage.packageSha256 = 'invalid';
      expect(classifyGhostLocalUpdateSource(facts)).toEqual({
        sourceChanged: true, legacyFirstPartyEligible: false,
      });
    },
  );

  it('keeps ordinary unsigned local-to-local update semantics without granting legacy privilege', () => {
    const facts = input();
    facts.previousApprovedReceipt!.trust = UNSIGNED;
    facts.previousApprovedReceipt!.legacyFirstPartyEligible = false;
    expect(classifyGhostLocalUpdateSource(facts)).toEqual({
      sourceChanged: false, legacyFirstPartyEligible: false,
    });
  });

  it('does not mint a legacy qualification for a new trusted publisher update', () => {
    const facts = input();
    facts.previousApprovedReceipt!.trust = SIGNED;
    facts.previousApprovedReceipt!.legacyFirstPartyEligible = false;
    facts.inspectedPackage.trust = SIGNED;
    expect(classifyGhostLocalUpdateSource(facts)).toEqual({
      sourceChanged: false, legacyFirstPartyEligible: false,
    });
  });
});
