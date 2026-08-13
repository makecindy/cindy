import { describe, expect, it } from 'vitest';
import type { PluginMarketItem } from '../../../../../shared/pluginMarket';
import {
  ghostReapprovalRoute,
  marketReviewTargetsInstalledGhost,
  orderPluginCatalogItems,
  pluginPresentationOrigin,
  pluginUpdateForInstalledVersion,
} from '../pluginMarketPresentation';

function marketItem(
  pluginId: string,
  ghostId: string,
  installState: PluginMarketItem['installState'],
): PluginMarketItem {
  return {
    pluginId,
    ghostId,
    name: ghostId,
    description: null,
    author: null,
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    releaseId: `release-${pluginId}`,
    version: '1.0.0',
    publishedAt: '2026-07-27T00:00:00.000Z',
    icon: null,
    installState,
    enabled: installState === 'not-installed' ? null : true,
    sourceType: 'server',
    sourceMarketName: null,
  };
}

describe('marketReviewTargetsInstalledGhost', () => {
  it('always allows a pending release', () => {
    expect(
      marketReviewTargetsInstalledGhost(marketItem('p', 'g', 'update-available'), 'approved'),
    ).toBe(true);
  });

  it('allows re-reviewing the current release when the install carries no approval', () => {
    const installed = marketItem('p', 'g', 'installed');
    expect(marketReviewTargetsInstalledGhost(installed, 'legacy-unapproved')).toBe(true);
    expect(marketReviewTargetsInstalledGhost(installed, 'invalid')).toBe(true);
  });

  it('has nothing to review for an approved install at the current release', () => {
    expect(marketReviewTargetsInstalledGhost(marketItem('p', 'g', 'installed'), 'approved')).toBe(
      false,
    );
  });

  it('refuses when the local install is gone or the market record is unusable', () => {
    expect(marketReviewTargetsInstalledGhost(marketItem('p', 'g', 'installed'), undefined)).toBe(
      false,
    );
    expect(marketReviewTargetsInstalledGhost(marketItem('p', 'g', 'conflict'), 'invalid')).toBe(
      false,
    );
    expect(marketReviewTargetsInstalledGhost(null, 'legacy-unapproved')).toBe(false);
  });
});

describe('ghostReapprovalRoute', () => {
  it('replays the market confirmation for market-owned installs', () => {
    expect(ghostReapprovalRoute(marketItem('p', 'g', 'installed'))).toBe('market');
    expect(ghostReapprovalRoute(marketItem('p', 'g', 'update-available'))).toBe('market');
  });

  it('asks for a local package when the market cannot supply the bytes', () => {
    expect(ghostReapprovalRoute(null)).toBe('local-package');
    expect(ghostReapprovalRoute(undefined)).toBe('local-package');
    // conflict = 同 id 归属不清,不能拿市场包顶上去当恢复来源。
    expect(ghostReapprovalRoute(marketItem('p', 'g', 'conflict'))).toBe('local-package');
    expect(ghostReapprovalRoute(marketItem('p', 'g', 'not-installed'))).toBe('local-package');
  });
});

describe('pluginPresentationOrigin', () => {
  it('maps public plugins independently of their default-install policy', () => {
    expect(pluginPresentationOrigin({ scope: 'public', sourceType: 'server' })).toBe('public');
  });

  it('maps organization plugins to their organization source', () => {
    expect(
      pluginPresentationOrigin({ scope: 'organization', sourceType: 'server' }),
    ).toBe('organization');
  });

  it('keeps personal plugins out of the client-facing market taxonomy', () => {
    expect(pluginPresentationOrigin({ scope: 'personal', sourceType: 'server' })).toBe('local');
  });

  it('maps custom market sources to the custom origin regardless of scope', () => {
    expect(pluginPresentationOrigin({ scope: 'public', sourceType: 'git-market' })).toBe(
      'custom',
    );
    expect(pluginPresentationOrigin({ scope: 'public', sourceType: 'local-market' })).toBe(
      'custom',
    );
  });

  it.each([null, undefined])('keeps unmatched installed plugins local', (item) => {
    expect(pluginPresentationOrigin(item)).toBe('local');
  });
});

describe('pluginUpdateForInstalledVersion', () => {
  it('surfaces a real version update', () => {
    const update = marketItem('plugin-update', 'example', 'update-available');
    update.version = '2.0.0';

    expect(pluginUpdateForInstalledVersion(update)).toBe(update);
  });

  it.each([
    ['same-version metadata refresh', marketItem('plugin-same', 'same', 'installed')],
    ['already installed', marketItem('plugin-installed', 'installed', 'installed')],
    ['conflict', marketItem('plugin-conflict', 'conflict', 'conflict')],
    ['missing market record', null],
  ] as const)('does not surface %s as a package update', (_label, item) => {
    expect(pluginUpdateForInstalledVersion(item)).toBeNull();
  });

  it('keeps a same-version legacy-adopted install updateable', () => {
    const legacy = marketItem('plugin-legacy', 'legacy', 'update-available');

    expect(pluginUpdateForInstalledVersion(legacy)).toBe(legacy);
  });
});

describe('orderPluginCatalogItems', () => {
  it('renders installed and available cards in the server response order', () => {
    const first = marketItem('plugin-first', 'first', 'not-installed');
    const second = marketItem('plugin-second', 'second', 'installed');
    const third = marketItem('plugin-third', 'third', 'not-installed');

    const ordered = orderPluginCatalogItems(
      [first, second, third],
      [{ id: 'second' }],
      [first, third],
    );

    expect(
      ordered.map(({ kind, item }) => `${kind}:${kind === 'installed' ? item.id : item.ghostId}`),
    ).toEqual(['market:first', 'installed:second', 'market:third']);
  });

  it('keeps local-only installed plugins after the server-ordered catalog', () => {
    const market = marketItem('plugin-market', 'market', 'not-installed');

    const ordered = orderPluginCatalogItems(
      [market],
      [{ id: 'local-z' }, { id: 'local-a' }],
      [market],
    );

    expect(
      ordered.map(({ kind, item }) => `${kind}:${kind === 'installed' ? item.id : item.ghostId}`),
    ).toEqual(['market:market', 'installed:local-z', 'installed:local-a']);
  });

  it('keeps a conflicting market card and its local install at the server position', () => {
    const first = marketItem('plugin-first', 'first', 'not-installed');
    const conflict = marketItem('plugin-conflict', 'collision', 'conflict');
    const third = marketItem('plugin-third', 'third', 'not-installed');

    const ordered = orderPluginCatalogItems(
      [first, conflict, third],
      [{ id: 'collision' }],
      [first, conflict, third],
    );

    expect(
      ordered.map(({ kind, item }) => `${kind}:${kind === 'installed' ? item.id : item.ghostId}`),
    ).toEqual(['market:first', 'market:collision', 'installed:collision', 'market:third']);
  });

  it('does not duplicate installed records passed through the available-item input', () => {
    const installed = marketItem('plugin-installed', 'installed', 'installed');
    const update = marketItem('plugin-update', 'update', 'update-available');

    const ordered = orderPluginCatalogItems(
      [installed, update],
      [{ id: 'installed' }, { id: 'update' }],
      [installed, update],
    );

    expect(
      ordered.map(({ kind, item }) => `${kind}:${kind === 'installed' ? item.id : item.ghostId}`),
    ).toEqual(['installed:installed', 'installed:update']);
  });

  it('preserves server order after search or origin filters remove entries', () => {
    const first = marketItem('plugin-first', 'first', 'not-installed');
    const hidden = marketItem('plugin-hidden', 'hidden', 'not-installed');
    const third = marketItem('plugin-third', 'third', 'update-available');

    const ordered = orderPluginCatalogItems([first, hidden, third], [{ id: 'third' }], [first]);

    expect(
      ordered.map(({ kind, item }) => `${kind}:${kind === 'installed' ? item.id : item.ghostId}`),
    ).toEqual(['market:first', 'installed:third']);
  });
});
