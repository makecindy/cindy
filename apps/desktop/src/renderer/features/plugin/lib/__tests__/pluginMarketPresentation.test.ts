import { describe, expect, it } from 'vitest';
import type { PluginMarketItem } from '../../../../../shared/pluginMarket';
import { orderPluginCatalogItems, pluginPresentationOrigin } from '../pluginMarketPresentation';

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
  };
}

describe('pluginPresentationOrigin', () => {
  it('maps public plugins independently of their default-install policy', () => {
    expect(pluginPresentationOrigin({ scope: 'public' })).toBe('public');
  });

  it('maps organization plugins to their organization source', () => {
    expect(pluginPresentationOrigin({ scope: 'organization' })).toBe('organization');
  });

  it('keeps personal plugins out of the client-facing market taxonomy', () => {
    expect(pluginPresentationOrigin({ scope: 'personal' })).toBe('local');
  });

  it.each([null, undefined])('keeps unmatched installed plugins local', (item) => {
    expect(pluginPresentationOrigin(item)).toBe('local');
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
