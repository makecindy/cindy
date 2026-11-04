import { describe, expect, it } from 'vitest';

import {
  FIRST_PARTY_ALIAS_GHOST_IDS,
  isTrustedMivoSecretAlias,
  authorizeGhostHostPrimitive,
  authorizeGhostTokenBroker,
  resolveGhostFirstPartyPrivilege,
  type GhostFirstPartyFacts,
  type GhostFirstPartyMarketRecord,
} from '../ghostFirstPartyPrivilege.js';

const CURRENT_ORG = { organizationId: 'org-acme', pluginPrefix: 'acme' as const, orgSlug: 'acme' as const };

const BUNDLED_NON_OFFICIAL_IDS = [
  '163-mail',
  'google-calendar',
  'google-drive',
  'google-gmail',
  'google-sheets',
  'icloud-mail',
  'ios-simulator',
  'qq-mail',
  'yahoo-mail',
  'world-bank-open-data',
  'taptap-maker',
  'x-manager',
] as const;

function facts(partial: Partial<GhostFirstPartyFacts> & Pick<GhostFirstPartyFacts, 'ghostId'>): GhostFirstPartyFacts {
  const namespace = partial.namespace !== undefined ? partial.namespace :
    !partial.builtin && partial.marketRecord?.scope === 'organization'
      ? partial.currentOrganization?.orgSlug ?? 'acme' : null;
  return {
    builtin: false,
    namespace,
    marketRecord: null,
    currentOrganization: null,
    installOrigin: 'manual',
    ...(partial.builtin && ['xd-feishu', 'xd-atlassian', 'xd-mivo', 'cindy-web-search', 'cindy-art'].includes(partial.ghostId)
      ? {
          trustedSource: {
            kind: 'builtin-official' as const,
            ghostId: partial.ghostId,
            namespace,
            packageSha256: 'a'.repeat(64),
          },
          approvedPackageSha256: 'a'.repeat(64),
        }
      : {}),
    ...partial,
  };
}

function market(
  partial: Partial<GhostFirstPartyMarketRecord> & Pick<GhostFirstPartyMarketRecord, 'scope'>,
): GhostFirstPartyMarketRecord {
  return {
    organizationId: partial.scope === 'organization' ? (partial.organizationId ?? 'org-acme') : null,
    source: 'market',
    installed: true,
    sha256: 'a'.repeat(64),
    approvedPackageSha256: 'a'.repeat(64),
    ...partial,
  };
}

describe('resolveGhostFirstPartyPrivilege', () => {
  // Confirmed scope: Broker is an enterprise credential. An official name or
  // verified public/bundled bytes no longer grants it to a local/public package.
  it.each(['cindy-art', 'xd-feishu', 'helper'])('does not grant Broker to a local copy named %s', ghostId => {
    expect(authorizeGhostTokenBroker(ghostId, { kind: 'ready', facts: facts({
      ghostId, namespace: 'local', builtin: true, installOrigin: 'agent-forge', currentOrganization: CURRENT_ORG,
      marketRecord: market({ scope: 'public' }),
    }) })).toBe(false);
  });
  it('does not treat pluginPrefix as the organization namespace', () => {
    const currentOrganization = { organizationId: 'org-1', orgSlug: 'org-abcdefgh', pluginPrefix: 'acme' };
    const marketRecord = market({ scope: 'organization', organizationId: 'org-1' });
    expect(resolveGhostFirstPartyPrivilege(facts({
      ghostId: 'helper', namespace: 'org-abcdefgh', currentOrganization, marketRecord,
    })).brokerEligible).toBe(true);
    expect(resolveGhostFirstPartyPrivilege(facts({
      ghostId: 'helper', namespace: 'acme', currentOrganization, marketRecord,
    })).brokerEligible).toBe(false);
    expect(authorizeGhostTokenBroker('helper', { kind: 'ready', facts: facts({
      ghostId: 'helper', namespace: 'org-abcdefgh', currentOrganization, marketRecord,
    }) })).toBe(true);
  });

  it.each(['xd', null])('retains the trusted Mivo alias with an old token and namespace %s', (namespace) => {
    const trusted = facts({ ghostId: 'xd-mivo', namespace,
      currentOrganization: { organizationId: 'org-xd', orgSlug: null, pluginPrefix: 'xd' },
      marketRecord: market({ scope: 'organization', organizationId: 'org-xd' }),
    });
    expect(isTrustedMivoSecretAlias(trusted, namespace === null)).toBe(true);
    expect(isTrustedMivoSecretAlias({ ...trusted,
      currentOrganization: { organizationId: 'org-xd', orgSlug: 'other', pluginPrefix: 'xd' },
    }, namespace === null)).toBe(true);
    expect(isTrustedMivoSecretAlias({ ...trusted,
      marketRecord: market({ scope: 'organization', organizationId: 'org-other' }),
    }, namespace === null)).toBe(false);
  });

  it('binds the Mivo historical key to a real XD installation, not the plugin name', () => {
    const xdOrganization = { organizationId: 'org-xd', orgSlug: 'xd', pluginPrefix: 'xd' };
    const trusted = facts({
      ghostId: 'xd-mivo', namespace: 'xd', currentOrganization: xdOrganization,
      marketRecord: market({ scope: 'organization', organizationId: 'org-xd' }),
    });
    expect(isTrustedMivoSecretAlias(trusted, false)).toBe(true);
    expect(isTrustedMivoSecretAlias({ ...trusted, namespace: null }, true)).toBe(true);
    expect(isTrustedMivoSecretAlias({ ...trusted, namespace: null }, false)).toBe(false);
    expect(isTrustedMivoSecretAlias({ ...trusted, installOrigin: 'agent-forge', marketRecord: null }, true)).toBe(false);
    expect(isTrustedMivoSecretAlias({ ...trusted, currentOrganization: CURRENT_ORG }, false)).toBe(false);
    expect(isTrustedMivoSecretAlias({ ...trusted, marketRecord: market({ scope: 'organization', organizationId: 'org-xd', source: 'legacy-adopted' }) }, false)).toBe(false);
    expect(isTrustedMivoSecretAlias({ ...trusted, marketRecord: market({ scope: 'organization', organizationId: 'org-xd', approvedPackageSha256: null }) }, false)).toBe(false);
  });
  // Scope changed: public/bundled source is not an enterprise credential grant.
  it.each(['xd-feishu', 'xd-atlassian', 'cindy-art'])('rejects bundled %s without enterprise binding', ghostId => {
    expect(resolveGhostFirstPartyPrivilege(facts({ ghostId, builtin: true }))).toMatchObject({
      brokerEligible: false, hostPrimitiveEligible: false, basis: 'denied-unknown-origin',
    });
  });

  it('denies bundled plugins that miss the static official table, including x-manager reclaimPort', () => {
    for (const ghostId of BUNDLED_NON_OFFICIAL_IDS) {
      expect(
        resolveGhostFirstPartyPrivilege(facts({ ghostId, builtin: true })),
        ghostId,
      ).toEqual({
        brokerEligible: false,
        hostPrimitiveEligible: false,
        basis: 'denied-unknown-origin',
      });
    }
    expect(
      resolveGhostFirstPartyPrivilege(facts({ ghostId: 'x-manager', builtin: true })).hostPrimitiveEligible,
    ).toBe(false);
  });

  it('denies alias ids that are not the real builtin seed', () => {
    for (const ghostId of FIRST_PARTY_ALIAS_GHOST_IDS) {
      expect(resolveGhostFirstPartyPrivilege(facts({ ghostId }))).toEqual({
        brokerEligible: false,
        hostPrimitiveEligible: false,
        basis: 'denied-unknown-origin',
      });
    }
    expect(
      resolveGhostFirstPartyPrivilege(facts({ ghostId: 'xd-mivo', builtin: true })),
    ).toMatchObject({ basis: 'denied-unknown-origin', brokerEligible: false });
  });

  it('rejects public market packages regardless of official resource evidence', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'cindy-art',
          marketRecord: market({ scope: 'public', organizationId: null, source: 'market' }),
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'google-gmail',
          marketRecord: market({ scope: 'public', organizationId: null, source: 'market' }),
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('does not treat custom-market public scope as a trust statement', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'google-gmail',
          marketRecord: market({
            scope: 'public',
            organizationId: null,
            source: 'local-market',
          }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('denies server-market personal scope', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({
            scope: 'personal',
            organizationId: null,
            source: 'market',
          }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('gives current-org market plugins broker but not host primitives', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'market-organization-current',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'helper',
          marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
          currentOrganization: { organizationId: 'org-acme', pluginPrefix: null, orgSlug: 'acme' },
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'market-organization-current',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'xd-feishu',
          namespace: 'xd',
          marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
          currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'xd', orgSlug: 'xd' },
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'market-organization-current',
    });
  });

  it('denies organization broker when the namespace is not the current org slug', () => {
    expect(resolveGhostFirstPartyPrivilege(facts({
      ghostId: 'helper',
      namespace: 'other',
      marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
      currentOrganization: CURRENT_ORG,
    }))).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-foreign-org',
    });
  });

  it('denies same-manifest organization packages when Release and approved package bytes differ', () => {
    const sameManifestDifferentBytes = market({
      scope: 'organization',
      organizationId: 'org-acme',
      sha256: 'a'.repeat(64),
      approvedPackageSha256: 'b'.repeat(64),
    });

    // Both hashes are package identities. No manifest digest participates, so
    // keeping ghost.json identical cannot make these different bytes eligible.
    expect(
      authorizeGhostTokenBroker('acme-feishu', {
        kind: 'ready',
        facts: facts({
          ghostId: 'acme-feishu',
          marketRecord: sameManifestDifferentBytes,
          currentOrganization: CURRENT_ORG,
        }),
      }),
    ).toBe(false);
  });

  it('denies organization Broker for a legacy receipt without package SHA', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({
            scope: 'organization',
            organizationId: 'org-acme',
            approvedPackageSha256: null,
          }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('does not let an official-looking name veto a trusted current-org market plugin', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'xd-evil',
          namespace: 'acme',
          marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'market-organization-current',
    });
  });

  it('denies another organization market package', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({ scope: 'organization', organizationId: 'org-other' }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-foreign-org',
    });
  });

  it('does not raise a custom-market package to broker', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({
            scope: 'personal',
            organizationId: null,
            source: 'local-market',
          }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('grants Broker-only self-test to an explicit Forge install under the current organization prefix', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          currentOrganization: CURRENT_ORG,
          namespace: 'acme',
          installOrigin: 'agent-forge',
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'forge-current-org',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          marketRecord: market({
            scope: 'personal',
            organizationId: null,
            source: 'local-market',
          }),
          currentOrganization: CURRENT_ORG,
          namespace: 'acme',
          installOrigin: 'agent-forge',
        }),
      ).brokerEligible,
    ).toBe(true);
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'other-feishu',
          currentOrganization: CURRENT_ORG,
          namespace: 'acme',
          installOrigin: 'agent-forge',
        }),
      ).brokerEligible,
    ).toBe(true);
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'helper',
          currentOrganization: { organizationId: 'org-acme', pluginPrefix: null, orgSlug: 'acme' },
          namespace: 'acme',
          installOrigin: 'agent-forge',
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'forge-current-org',
    });
  });

  it('lets explicit Forge self-test win over every stale or foreign market-row shape', () => {
    const rows = [
      market({ scope: 'organization', installed: false }),
      market({ scope: 'organization', organizationId: 'org-other' }),
      market({ scope: 'personal', organizationId: null, source: 'local-market' }),
    ];
    for (const marketRecord of rows) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({
            ghostId: 'acme-feishu',
            marketRecord,
            currentOrganization: CURRENT_ORG,
            namespace: 'acme',
          installOrigin: 'agent-forge',
          }),
        ),
      ).toEqual({
        brokerEligible: true,
        hostPrimitiveEligible: false,
        basis: 'forge-current-org',
      });
    }
  });

  // 台账里有这条 id 但 installed 为 false 时,曾经会整段跳过市场分支、落到末尾那条
  // 「本地包 + 本组织前缀 → 放行」的兜底。于是同一条 `scope: 'personal'` 记录
  // (明确不可信)把 installed 从 true 改成 false,结论就从 deny 翻成 allow ——
  // **把一个字段置 false 反而提权**,安全判据里的 fail-open。
  // 而且这条路正是冒名场景:市场台账里已经有这个 id,本地却装了个同名手搓包。
  it('does not let a not-installed ledger row fall through to the local-package tail', () => {
    for (const scope of ['personal', 'public', 'organization'] as const) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({
            ghostId: 'acme-feishu',
            marketRecord: market({ scope, installed: false }),
            currentOrganization: CURRENT_ORG,
          }),
        ),
        scope,
      ).toEqual({
        brokerEligible: false,
        hostPrimitiveEligible: false,
        basis: 'denied-unknown-origin',
      });
    }
    // 手动本地包不能借一个 installed=false 的市场行取得资格。
  });

  it('fails closed when facts are unavailable, even for official-looking ids', () => {
    expect(
      authorizeGhostTokenBroker('xd-feishu', { kind: 'unavailable' }),
    ).toBe(false);
    expect(
      authorizeGhostHostPrimitive('xd-feishu', { kind: 'unavailable' }),
    ).toBe(false);
    expect(
      authorizeGhostTokenBroker('acme-feishu', { kind: 'unavailable' }),
    ).toBe(false);
    expect(
      authorizeGhostTokenBroker(
        'acme-feishu',
        {
          kind: 'ready',
          facts: facts({
            ghostId: 'acme-feishu',
            currentOrganization: CURRENT_ORG,
          }),
        },
      ),
    ).toBe(false);
  });

  it('grants organization-market broker from trusted facts, not from an official-looking name', () => {
    const pendingOrgMarket = facts({
      ghostId: 'acme-feishu',
      marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
      currentOrganization: CURRENT_ORG,
    });
    expect(authorizeGhostTokenBroker('acme-feishu', { kind: 'ready', facts: pendingOrgMarket })).toBe(
      true,
    );
    expect(
      authorizeGhostTokenBroker('cindy-art', {
        kind: 'ready',
        facts: facts({
          ghostId: 'cindy-art',
          builtin: false,
          marketRecord: null,
          currentOrganization: null,
        }),
      }),
    ).toBe(false);
    expect(authorizeGhostTokenBroker('cindy-art', { kind: 'unavailable' })).toBe(false);
    expect(authorizeGhostHostPrimitive('cindy-art', { kind: 'unavailable' })).toBe(false);
  });

  it('denies legacy-adopted rows for static official and matching organization ids', () => {
    for (const scope of ['public', 'organization'] as const) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({
            ghostId: 'cindy-art',
            marketRecord: market({ scope, source: 'legacy-adopted' }),
            currentOrganization: CURRENT_ORG,
          }),
        ),
        scope,
      ).toMatchObject({ brokerEligible: false, hostPrimitiveEligible: false });
    }
    // ⚠️ 上面那组用的 id 是 `cindy-art`,而当前组织前缀是 `acme`——它其实死在
    // 「前缀不匹配」那一步,**根本没走到 source 判断**,所以单靠它会给出假信心
    // (reviewer 指出)。下面这组前缀真的匹配,才是实际验证 organization 分支
    // 必须同时要求 `source === 'market'` 的用例:少了那个检查,`legacy-adopted`
    // 与自定义来源的 organization 行都会被判成「本组织市场安装」而拿到 Broker。
    for (const source of ['legacy-adopted', 'git-market', 'local-market'] as const) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({
            ghostId: 'acme-feishu',
            marketRecord: market({ scope: 'organization', organizationId: 'org-acme', source }),
            currentOrganization: CURRENT_ORG,
          }),
        ),
        source,
      ).toEqual({
        brokerEligible: false,
        hostPrimitiveEligible: false,
        basis: 'denied-unknown-origin',
      });
    }
    // 同一个 id 只要 builtin 事实为真就走优先级 1,台账怎么写都不影响。
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'cindy-art',
          builtin: true,
          marketRecord: market({ scope: 'organization', source: 'legacy-adopted' }),
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });

  it('denies Forge broker when the install namespace is not the current organization', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'helper',
          namespace: 'acme',
          currentOrganization: { organizationId: 'org-b', pluginPrefix: 'beta', orgSlug: 'beta' },
          installOrigin: 'agent-forge',
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-foreign-org',
    });
  });

  it('preserves only a verified pending pre-namespace Forge for its original organization', () => {
    const pending = facts({
      ghostId: 'acme-helper',
      currentOrganization: CURRENT_ORG,
      installOrigin: 'agent-forge',
      legacyPendingForge: true,
    });
    expect(resolveGhostFirstPartyPrivilege(pending).brokerEligible).toBe(true);
    expect(resolveGhostFirstPartyPrivilege({ ...pending, legacyPendingForge: false }).brokerEligible).toBe(false);
    expect(resolveGhostFirstPartyPrivilege({ ...pending, ghostId: 'helper' }).brokerEligible).toBe(false);
    expect(resolveGhostFirstPartyPrivilege({ ...pending, currentOrganization: {
      organizationId: 'org-b', pluginPrefix: 'beta', orgSlug: 'beta',
    } }).brokerEligible).toBe(false);
  });

  it('fail-closes unknown origin, missing prefix, and unmatched prefix', () => {
    expect(resolveGhostFirstPartyPrivilege(facts({ ghostId: 'mystery' }))).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          currentOrganization: { organizationId: 'org-acme', pluginPrefix: null, orgSlug: 'acme' },
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'xd-evil',
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
    });
  });
});
