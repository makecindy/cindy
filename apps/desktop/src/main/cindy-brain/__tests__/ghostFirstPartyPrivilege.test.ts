import { describe, expect, it } from 'vitest';

import {
  FIRST_PARTY_ALIAS_GHOST_IDS,
  authorizeGhostTokenBroker,
  resolveGhostFirstPartyPrivilege,
  type GhostFirstPartyFacts,
  type GhostFirstPartyMarketRecord,
} from '../ghostFirstPartyPrivilege.js';

const CURRENT_ORG = { organizationId: 'org-acme', pluginPrefix: 'acme' as const };

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
  return {
    builtin: false,
    marketRecord: null,
    currentOrganization: null,
    installOrigin: 'manual',
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
  // 纯函数分支测试:用 xd-feishu / xd-atlassian 作为代表性官方前缀 id，验证
  // builtin + 官方前缀会同时得到 Broker 与宿主原语；这不表示它们随发行包分发。
  // 静态官方前缀的存量兼容由后面的 authorizeGhostTokenBroker(...,
  // { kind: 'unavailable' }) 对照用例锁定。
  // `currentOrganization: null` 与 `marketRecord: null` 在这里**显式写出**,不吃
  // `facts()` 的默认值:否则将来有人为省事把默认改成"有组织",这条依然会通过
  // (优先级 1 本就不看 org),但"个人身份"这个场景就悄悄没人守了。
  it('gives builtin official plugins broker and host primitives with no ledger and no organization', () => {
    for (const ghostId of ['xd-feishu', 'xd-atlassian']) {
      expect(
        resolveGhostFirstPartyPrivilege(
          facts({ ghostId, builtin: true, marketRecord: null, currentOrganization: null }),
        ),
        ghostId,
      ).toEqual({
        brokerEligible: true,
        hostPrimitiveEligible: true,
        basis: 'builtin-official',
      });
    }
  });

  // 事实供给层(`ghostFirstPartyFacts.ts` 的 `builtinOnlyFacts`)在「身份是组织、但前缀
  // 缓存取不到」时会给随包插件填 `currentOrganization: null`——那不是真事实，只是输入
  // 类型没有「是组织但前缀未知」的表示。它安全的唯一依据就是这条不变量:
  // **优先级 1 在返回前不读 `currentOrganization` 与 `marketRecord`。**
  // 这条测试就是那个填充值的护栏:哪天有人让优先级 1 开始读这两个字段,这里会红,
  // 提醒他去修供给层,而不是让一个假事实静默生效。
  it('priority 1 is independent of ledger and organization facts', () => {
    const expected = {
      brokerEligible: true,
      hostPrimitiveEligible: true,
      basis: 'builtin-official',
    };
    const ledgerShapes = [
      null,
      market({ scope: 'personal' }),
      market({ scope: 'organization', organizationId: 'org-other' }),
      market({ scope: 'public', source: 'legacy-adopted' }),
      market({ scope: 'public', installed: false }),
    ];
    const orgShapes = [
      null,
      CURRENT_ORG,
      { organizationId: 'org-acme', pluginPrefix: null },
      { organizationId: 'org-other', pluginPrefix: 'other' },
    ];
    for (const marketRecord of ledgerShapes) {
      for (const currentOrganization of orgShapes) {
        expect(
          resolveGhostFirstPartyPrivilege(
            facts({ ghostId: 'xd-feishu', builtin: true, marketRecord, currentOrganization }),
          ),
          JSON.stringify({ marketRecord, currentOrganization }),
        ).toEqual(expected);
      }
    }
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
        basis: 'denied-alias',
      });
    }
    expect(
      resolveGhostFirstPartyPrivilege(facts({ ghostId: 'xd-mivo', builtin: true })),
    ).toMatchObject({ basis: 'builtin-official', brokerEligible: true });
  });

  it('trusts server-market public installs only when the id hits the static table', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'cindy-art',
          marketRecord: market({ scope: 'public', organizationId: null, source: 'market' }),
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: true,
      basis: 'market-public',
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

  it('denies an official-looking org plugin whose prefix does not belong to the current org', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'xd-evil',
          marketRecord: market({ scope: 'organization', organizationId: 'org-acme' }),
          currentOrganization: CURRENT_ORG,
        }),
      ),
    ).toEqual({
      brokerEligible: false,
      hostPrimitiveEligible: false,
      basis: 'denied-unknown-origin',
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

  it('keeps Broker only for a legacy Forge receipt under the current organization prefix', () => {
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'acme-feishu',
          currentOrganization: CURRENT_ORG,
          installOrigin: 'agent-forge',
        }),
      ),
    ).toEqual({
      brokerEligible: true,
      hostPrimitiveEligible: false,
      basis: 'legacy-forge-current-org-prefix',
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
          installOrigin: 'agent-forge',
        }),
      ).brokerEligible,
    ).toBe(true);
    expect(
      resolveGhostFirstPartyPrivilege(
        facts({
          ghostId: 'other-feishu',
          currentOrganization: CURRENT_ORG,
          installOrigin: 'agent-forge',
        }),
      ).brokerEligible,
    ).toBe(false);
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
    // 作者自测:从未发布过的 id 没有台账行，本地装入仍然 deny。
  });

  it('keeps official-prefix broker even when facts are unavailable, and asks the resolver otherwise', () => {
    expect(
      authorizeGhostTokenBroker('xd-feishu', { kind: 'unavailable' }),
    ).toBe(true);
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

  it('uses pending org-market facts only for non-official ids; official prefix never consults them', () => {
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
    ).toBe(true);
    expect(authorizeGhostTokenBroker('cindy-art', { kind: 'unavailable' })).toBe(true);
  });

  // `legacy-adopted` 是市场列表成功后为「早于市场就已装在本机的官方前缀插件」合成的
  // 来源(`plugin-market/service.ts::adoptLegacyInstallations`)。判据对它一律 deny:
  // 它既不是 `source: 'market'`(所以进不了 public 那支),也不是 git/local market。
  //
  // `legacy-adopted` 不是静态官方资格或组织资格的替代来源:即使 id 命中静态官方前缀,
  // 或命中当前组织前缀,也必须 fail-closed。若要改变这条来源边界必须显式决策,
  // 不能把它当漏网 bug 顺手放宽。
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
      brokerEligible: true,
      hostPrimitiveEligible: true,
      basis: 'builtin-official',
    });
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
          currentOrganization: { organizationId: 'org-acme', pluginPrefix: null },
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
