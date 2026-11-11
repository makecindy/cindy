import { describe, expect, it } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import type { GhostFirstPartyFactsLoad } from '../ghostFirstPartyFacts.js';
import type {
  GhostFirstPartyCurrentOrganization,
  GhostFirstPartyFacts,
  GhostFirstPartyMarketRecord,
} from '../ghostFirstPartyPrivilege.js';
import { isTrustedXdGhostForScriptTarget } from '../ghostTrustedXdTarget.js';

const packageSha256 = 'a'.repeat(64);
const organization: GhostFirstPartyCurrentOrganization = {
  organizationId: 'org-xd',
  orgSlug: 'xd',
  pluginPrefix: 'xd',
};
const marketRecord: GhostFirstPartyMarketRecord = {
  scope: 'organization',
  organizationId: organization.organizationId,
  source: 'market',
  installed: true,
  sha256: packageSha256,
  approvedPackageSha256: packageSha256,
};

function installed(overrides: Partial<InstalledGhost> = {}): InstalledGhost {
  const ghost: InstalledGhost = {
    manifest: {
      schemaVersion: 2,
      id: 'xd-feishu',
      name: 'Feishu',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
    },
    dir: '/tmp/brain/_ns/xd/xd-feishu',
    namespace: 'xd',
    enabled: true,
    approval: { state: 'approved', revision: 'trusted-revision' },
    ...overrides,
  };
  if (ghost.namespace === undefined) delete ghost.namespace;
  return ghost;
}

function ready(overrides: Partial<GhostFirstPartyFacts> = {}): GhostFirstPartyFactsLoad {
  return {
    kind: 'ready',
    facts: {
      ghostId: 'xd-feishu',
      namespace: 'xd',
      builtin: false,
      marketRecord,
      currentOrganization: organization,
      installOrigin: 'manual',
      ...overrides,
    },
  };
}

function builtin(namespace: string | null): GhostFirstPartyFactsLoad {
  return ready({
    namespace,
    builtin: true,
    marketRecord: null,
    approvedPackageSha256: packageSha256,
    trustedSource: { kind: 'builtin-official', ghostId: 'xd-feishu', namespace, packageSha256 },
  });
}

describe('trusted XD script target', () => {
  it.each(['xd', undefined, null])('accepts verified XD namespace with orgSlug %s', (orgSlug) => {
    expect(
      isTrustedXdGhostForScriptTarget(
        installed(),
        ready({
          currentOrganization: { organizationId: organization.organizationId, orgSlug },
        }),
        false,
      ),
    ).toBe(true);
  });

  it.each(['xd', undefined, null])(
    'accepts approved pending legacy with current XD identity %s',
    (orgSlug) => {
      expect(
        isTrustedXdGhostForScriptTarget(
          installed({ namespace: undefined }),
          ready({
            namespace: null,
            currentOrganization: { ...organization, orgSlug },
          }),
          true,
        ),
      ).toBe(true);
    },
  );

  it.each(['xd', undefined])(
    'accepts pending trusted builtin with current XD identity %s',
    (orgSlug) => {
      const load = builtin(null);
      if (load.kind === 'ready') load.facts.currentOrganization = { ...organization, orgSlug };
      expect(isTrustedXdGhostForScriptTarget(installed({ namespace: undefined }), load, true)).toBe(
        true,
      );
    },
  );

  it('accepts trusted builtin evidence for explicit XD namespace', () => {
    expect(isTrustedXdGhostForScriptTarget(installed(), builtin('xd'), false)).toBe(true);
  });

  it.each(['xd', undefined])(
    'rejects known root even with pending argument and slug %s',
    (orgSlug) => {
      expect(
        isTrustedXdGhostForScriptTarget(
          installed({ namespace: null }),
          ready({
            namespace: null,
            currentOrganization: { ...organization, orgSlug },
          }),
          true,
        ),
      ).toBe(false);
    },
  );

  it('rejects unknown namespace outside the pending transition', () => {
    expect(
      isTrustedXdGhostForScriptTarget(
        installed({ namespace: undefined }),
        ready({ namespace: null }),
        false,
      ),
    ).toBe(false);
  });

  it('does not treat an explicit undefined delivery field as missing legacy namespace', () => {
    const ghost = installed({ namespace: undefined });
    ghost.namespace = undefined;
    expect(isTrustedXdGhostForScriptTarget(ghost, ready({ namespace: null }), true)).toBe(false);
  });

  it.each([false, true])(
    'rejects explicit foreign slug despite prefix XD, pending %s',
    (pending) => {
      expect(
        isTrustedXdGhostForScriptTarget(
          installed({ namespace: pending ? undefined : 'xd' }),
          ready({
            namespace: pending ? null : 'xd',
            currentOrganization: { ...organization, orgSlug: 'foreign' },
          }),
          pending,
        ),
      ).toBe(false);
    },
  );

  it.each([undefined, null, 'foreign'])(
    'rejects pending legacy without affirmative XD identity, prefix %s',
    (pluginPrefix) => {
      expect(
        isTrustedXdGhostForScriptTarget(
          installed({ namespace: undefined }),
          ready({
            namespace: null,
            currentOrganization: { organizationId: organization.organizationId, pluginPrefix },
          }),
          true,
        ),
      ).toBe(false);
    },
  );

  it.each(['invalid', 'legacy-unapproved'] as const)(
    'rejects pending legacy approval %s',
    (state) => {
      expect(
        isTrustedXdGhostForScriptTarget(
          installed({ namespace: undefined, approval: { state } }),
          ready({ namespace: null }),
          true,
        ),
      ).toBe(false);
    },
  );

  it('rejects foreign delivery namespace even with trusted current-org market evidence', () => {
    expect(
      isTrustedXdGhostForScriptTarget(
        installed({ namespace: 'foreign' }),
        ready({ namespace: 'foreign' }),
        true,
      ),
    ).toBe(false);
  });

  it.each([
    { organizationId: 'foreign-org' },
    { scope: 'public', organizationId: null },
    { source: 'local-market' },
    { source: 'git-market' },
    { source: 'legacy-adopted' },
    { installed: false },
    { sha256: 'b'.repeat(64) },
    { approvedPackageSha256: null },
    { sha256: 'invalid', approvedPackageSha256: 'invalid' },
  ] satisfies Partial<GhostFirstPartyMarketRecord>[])(
    'rejects untrusted market evidence %j',
    (overrides) => {
      expect(
        isTrustedXdGhostForScriptTarget(
          installed(),
          ready({
            marketRecord: { ...marketRecord, ...overrides },
          }),
          false,
        ),
      ).toBe(false);
    },
  );

  it.each([false, true])('rejects new public XD name even on builtin roster %s', (builtin) => {
    expect(
      isTrustedXdGhostForScriptTarget(
        installed({ namespace: undefined }),
        ready({
          namespace: null,
          builtin,
          legacyFirstPartyEligible: true,
          marketRecord: { ...marketRecord, scope: 'public', organizationId: null },
        }),
        true,
      ),
    ).toBe(false);
  });

  it.each([
    { trustedSource: null },
    { approvedPackageSha256: 'b'.repeat(64) },
    {
      trustedSource: {
        kind: 'builtin-official',
        ghostId: 'other-plugin',
        namespace: 'xd',
        packageSha256,
      },
    },
    {
      trustedSource: {
        kind: 'builtin-official',
        ghostId: 'xd-feishu',
        namespace: null,
        packageSha256,
      },
    },
  ] satisfies Partial<GhostFirstPartyFacts>[])(
    'rejects builtin without matching receipt evidence %j',
    (overrides) => {
      const load = builtin('xd');
      if (load.kind === 'ready') Object.assign(load.facts, overrides);
      expect(isTrustedXdGhostForScriptTarget(installed(), load, false)).toBe(false);
    },
  );

  it.each([false, true])('rejects anonymous identity with builtin evidence %s', (useBuiltin) => {
    const load = useBuiltin ? builtin('xd') : ready();
    if (load.kind === 'ready') load.facts.currentOrganization = null;
    expect(isTrustedXdGhostForScriptTarget(installed(), load, false)).toBe(false);
  });

  it.each([{ ghostId: 'other-plugin' }, { namespace: null }])(
    'rejects mismatched facts %j',
    (overrides) => {
      expect(isTrustedXdGhostForScriptTarget(installed(), ready(overrides), false)).toBe(false);
    },
  );

  it('rejects unavailable facts', () => {
    expect(
      isTrustedXdGhostForScriptTarget(
        installed(),
        {
          kind: 'unavailable',
          reason: 'market-installation-read-failed',
          purpose: 'runtime',
          action: 'load-without-privilege',
        },
        false,
      ),
    ).toBe(false);
  });
});
