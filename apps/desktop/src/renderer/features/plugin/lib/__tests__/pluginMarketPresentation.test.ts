import { describe, expect, it } from 'vitest';
import type { InstalledGhost } from '../../../../../shared/ghost';
import type { PluginMarketItem } from '../../../../../shared/pluginMarket';
import { marketPresentationForInstalledGhost } from '../ghostPluginViewModel';
import {
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

function installedGhost(): Pick<InstalledGhost, 'manifest' | 'iconDataUrl'> {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'example',
      name: 'Example',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: [],
    },
    iconDataUrl: 'data:image/png;base64,LOCAL',
  };
}

describe('marketPresentationForInstalledGhost', () => {
  it('uses the server market icon URL for an exact installed version', () => {
    const item = marketItem('plugin-server-icon', 'example', 'installed');
    item.icon = {
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      sizeBytes: 128,
      url: 'https://plugin.example.invalid/example.png?signature=new',
      expiresAt: '2026-07-27T01:00:00.000Z',
    };

    expect(marketPresentationForInstalledGhost(installedGhost(), item)?.iconDataUrl).toBe(
      item.icon.url,
    );
  });

  it('keeps a null server icon authoritative over the local package icon', () => {
    const presentation = marketPresentationForInstalledGhost(
      installedGhost(),
      marketItem('plugin-server-no-icon', 'example', 'installed'),
    );

    expect(presentation).not.toBeNull();
    expect(presentation?.iconDataUrl).toBeUndefined();
  });

  it.each(['git-market', 'local-market'] as const)(
    'uses the installed package icon for an exact %s item',
    (sourceType) => {
      const ghost = installedGhost();
      const item = marketItem(`plugin-${sourceType}`, 'example', 'installed');
      item.sourceType = sourceType;
      item.sourceMarketName = 'Custom Market';

      expect(marketPresentationForInstalledGhost(ghost, item)?.iconDataUrl).toBe(ghost.iconDataUrl);
    },
  );

  it('returns null when the market item does not exactly own the installed version', () => {
    const versionMismatch = marketItem('plugin-version-mismatch', 'example', 'installed');
    versionMismatch.version = '2.0.0';
    const conflict = marketItem('plugin-conflict', 'example', 'conflict');

    expect(marketPresentationForInstalledGhost(installedGhost(), versionMismatch)).toBeNull();
    expect(marketPresentationForInstalledGhost(installedGhost(), conflict)).toBeNull();
    expect(marketPresentationForInstalledGhost(installedGhost(), null)).toBeNull();
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
