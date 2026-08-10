/**
 * Contract tests for Plugin list/detail adapters over the shared Ghost model.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import type { PluginMarketItem } from '../../../shared/pluginMarket';
import {
  filterGhostPluginItems,
  ghostFallbackIconKind,
  ghostPanelOwnerKey,
  ghostPrimaryAction,
  marketPresentationForInstalledGhost,
  nextOpenPanelIdForOwner,
  sortGhostPluginItemsByRecentUse,
  installedVisibleCount,
  sortInstalledForDisplay,
  toGhostPluginDetail,
  toGhostPluginListItem,
  type GhostPluginListItem,
} from '../../features/plugin/lib/ghostPluginViewModel';

function manifest(overrides: Partial<GhostManifest> = {}): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'xd-mivo',
    name: 'XD Mivo',
    version: '1.5.10',
    author: 'XD',
    description: 'Generate media assets.',
    whenToUse: 'When the user needs media generation.',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool', 'network', 'card'],
    tools: [
      { name: 'submit_gen_image', description: 'Generate an image.' },
      { name: 'download_file', description: 'Download a file.' },
    ],
    network: {
      hosts: ['aigc.example.com'],
      secrets: [
        {
          key: 'mivo_api_key',
          label: 'Mivo API Key',
          source: 'user',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
        },
      ],
    },
    command: 'xd-mivo',
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledGhost> = {}): InstalledGhost {
  return {
    manifest: manifest(),
    dir: '/tmp/cindy-brain/xd-mivo',
    enabled: true,
    ...overrides,
  };
}

function marketItem(overrides: Partial<PluginMarketItem> = {}): PluginMarketItem {
  return {
    pluginId: `c${'a'.repeat(24)}`,
    ghostId: 'xd-mivo',
    name: 'Mivo Studio',
    description: 'Latest market description.',
    author: 'Xindong Design',
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    releaseId: 'release-1',
    version: '1.5.10',
    publishedAt: '2026-07-27T00:00:00.000Z',
    sourceType: 'server',
    sourceMarketName: null,
    icon: {
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      sizeBytes: 128,
      url: 'https://plugin.example.invalid/mivo.png?signature=new',
      expiresAt: '2026-07-27T01:00:00.000Z',
    },
    installState: 'installed',
    enabled: true,
    ...overrides,
  };
}

describe('ghostPluginViewModel', () => {
  it('maps iconless Plugins to restrained functional fallback symbols', () => {
    expect(ghostFallbackIconKind('Lizi Mivo', 'lizi-mivo')).toBe('media');
    expect(ghostFallbackIconKind('Cindy Mermaid', 'cindy-mermaid')).toBe('diagram');
    expect(ghostFallbackIconKind('XD Feishu', 'xd-feishu')).toBe('communication');
    expect(ghostFallbackIconKind('Local Weather', 'local-weather')).toBe('generic');
  });

  it('matches search text against name, description, and id', () => {
    const items = [
      {
        id: 'xd-mivo',
        name: 'XD Mivo',
        description: 'media',
        version: '1',
        enabled: true,
        canUse: true,
        tabPanel: false,
        hostCapability: null,
      },
      {
        id: 'lizi-mivo',
        name: 'Lizi Mivo',
        description: 'media',
        version: '1',
        enabled: true,
        canUse: true,
        tabPanel: false,
        hostCapability: null,
      },
      {
        id: 'slack',
        name: 'Cindy Slack',
        description: 'messages',
        version: '1',
        enabled: true,
        canUse: true,
        tabPanel: false,
        hostCapability: null,
      },
    ] satisfies GhostPluginListItem[];

    const searched = filterGhostPluginItems(items, 'miv');

    expect(searched.map((item) => item.id)).toEqual(['xd-mivo', 'lizi-mivo']);
  });

  it('sorts used Plugins newest-first and keeps untouched Plugins stable', () => {
    const items = [{ id: 'first' }, { id: 'second' }, { id: 'third' }, { id: 'fourth' }];

    expect(
      sortGhostPluginItemsByRecentUse(items, ['third', 'missing', 'first']).map((item) => item.id),
    ).toEqual(['third', 'first', 'second', 'fourth']);
  });

  describe('sortInstalledForDisplay', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

    it('surfaces unread notifications first, newest badge on top', () => {
      expect(
        sortInstalledForDisplay(items, {
          recentIds: [],
          unreadAtById: new Map([
            ['c', 100],
            ['a', 300],
          ]),
        }).map((item) => item.id),
      ).toEqual(['a', 'c', 'b', 'd']);
    });

    it('ranks unread above recently-used, then recent, then base order', () => {
      // b is unread (top); d & a are recently used (d newest); c falls to base tail.
      expect(
        sortInstalledForDisplay(items, {
          recentIds: ['d', 'a'],
          unreadAtById: new Map([['b', 5]]),
        }).map((item) => item.id),
      ).toEqual(['b', 'd', 'a', 'c']);
    });

    it('keeps base order stable when no signal applies and ignores marketUpdate entirely', () => {
      // No unread / no recent → untouched. marketUpdate is not an input, so it cannot reorder.
      expect(
        sortInstalledForDisplay(items, { recentIds: [], unreadAtById: new Map() }).map(
          (item) => item.id,
        ),
      ).toEqual(['a', 'b', 'c', 'd']);
    });

    it('breaks unread ties on the same badge time by stable base order', () => {
      expect(
        sortInstalledForDisplay(items, {
          recentIds: [],
          unreadAtById: new Map([
            ['d', 7],
            ['b', 7],
          ]),
        }).map((item) => item.id),
      ).toEqual(['b', 'd', 'a', 'c']);
    });
  });

  describe('installedVisibleCount (unread never folded)', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ id: `p-${index}` }));

    it('keeps the base cap when unread count is within it', () => {
      expect(installedVisibleCount(items, new Map([['p-0', 9]]), 8)).toBe(8);
      expect(installedVisibleCount(items, new Map(), 8)).toBe(8);
    });

    it('expands the window to cover every unread plugin beyond the cap', () => {
      const unread = new Map(Array.from({ length: 10 }, (_, i) => [`p-${i}`, i]));
      // 10 unread > cap 8 → window grows to 10 so no unread plugin is folded.
      expect(installedVisibleCount(items, unread, 8)).toBe(10);
    });

    it('ignores unread ids that are not in the installed list', () => {
      expect(installedVisibleCount(items, new Map([['not-installed', 1]]), 8)).toBe(8);
    });
  });

  it('maps install-record facts onto the list item', () => {
    const item = toGhostPluginListItem(installed());

    expect(item).toMatchObject({
      id: 'xd-mivo',
      name: 'XD Mivo',
      enabled: true,
      canUse: true,
      hostCapability: null,
      version: '1.5.10',
    });
  });

  it('projects the iOS Simulator slot as an explicit Host capability action', () => {
    const item = toGhostPluginListItem(
      installed({
        manifest: manifest({
          command: undefined,
          slots: ['skill', 'ios-simulator'],
          tools: undefined,
          network: undefined,
        }),
      }),
    );

    expect(item.hostCapability).toBe('ios-simulator');
    expect(ghostPrimaryAction(item)).toBe('capability');
  });

  it('overlays exact installed market presentation without changing runtime facts', () => {
    const ghost = installed({
      iconDataUrl: 'data:image/png;base64,OLD',
      enabled: false,
    });
    const presentation = marketPresentationForInstalledGhost(ghost, marketItem());

    expect(toGhostPluginListItem(ghost, presentation)).toMatchObject({
      id: 'xd-mivo',
      name: 'Mivo Studio',
      description: 'Latest market description.',
      iconDataUrl: 'https://plugin.example.invalid/mivo.png?signature=new',
      version: '1.5.10',
      enabled: false,
      canUse: true,
    });
    const detail = toGhostPluginDetail(ghost, presentation);
    expect(detail.author).toBe('Xindong Design');
    expect(detail.permissions.map((item) => item.kind)).toEqual([
      'network',
      'network',
      'tool',
      'tool',
      'command',
      'card',
      'code',
    ]);
  });

  it('treats a server market null icon as an explicit presentation override', () => {
    const ghost = installed({ iconDataUrl: 'data:image/png;base64,OLD' });
    const presentation = marketPresentationForInstalledGhost(ghost, marketItem({ icon: null }));

    expect(presentation).not.toBeNull();
    expect(toGhostPluginListItem(ghost, presentation)).not.toHaveProperty('iconDataUrl');
  });

  it('uses the installed package icon for an exact Git market mapping', () => {
    const ghost = installed({ iconDataUrl: 'data:image/png;base64,LOCAL' });
    const presentation = marketPresentationForInstalledGhost(
      ghost,
      marketItem({
        sourceType: 'git-market',
        sourceMarketName: 'community-plugins',
        icon: null,
      }),
    );

    expect(toGhostPluginListItem(ghost, presentation)).toMatchObject({
      iconDataUrl: 'data:image/png;base64,LOCAL',
    });
    expect(toGhostPluginDetail(ghost, presentation)).toMatchObject({
      iconDataUrl: 'data:image/png;base64,LOCAL',
    });
  });

  it.each([
    ['local market miss', null],
    ['not installed', marketItem({ installState: 'not-installed' })],
    ['source conflict', marketItem({ installState: 'conflict' })],
    ['pending update', marketItem({ installState: 'update-available', version: '1.6.0' })],
    ['unresolved same-version provenance', marketItem({ installState: 'update-available' })],
    ['version mismatch', marketItem({ version: '1.6.0' })],
    ['ghost ID mismatch', marketItem({ ghostId: 'another-plugin' })],
  ] as const)('keeps local presentation for %s', (_label, item) => {
    const ghost = installed({ iconDataUrl: 'data:image/png;base64,LOCAL' });
    const presentation = marketPresentationForInstalledGhost(ghost, item);

    expect(presentation).toBeNull();
    expect(toGhostPluginListItem(ghost, presentation)).toMatchObject({
      name: 'XD Mivo',
      description: 'Generate media assets.',
      iconDataUrl: 'data:image/png;base64,LOCAL',
    });
  });

  it('keeps disabled state and does not invent marketplace fields', () => {
    const item = toGhostPluginListItem(installed({ enabled: false }));

    expect(item.enabled).toBe(false);
    expect(item).not.toHaveProperty('installCount');
    expect(item).not.toHaveProperty('usageCount');
    expect(item).not.toHaveProperty('certified');
    expect(item).not.toHaveProperty('whenToUse');
  });

  it('derives detail permissions and runtime declarations from the manifest', () => {
    const detail = toGhostPluginDetail(installed());

    expect(detail.contents).toEqual(['code', 'slotTool', 'slotNetwork', 'slotCard']);
    expect(detail.tools.map((tool) => tool.name)).toEqual(['submit_gen_image', 'download_file']);
    expect(detail.panelMinWidth).toBeNull();
    expect(detail.installDir).toBe('/tmp/cindy-brain/xd-mivo');
    expect(detail.canUse).toBe(true);
    expect(detail).not.toHaveProperty('manifest');
    expect(detail.permissions.map((item) => item.kind)).toEqual([
      'network',
      'network',
      'tool',
      'tool',
      'command',
      'card',
      'code',
    ]);
  });

  it('does not render absent optional capabilities as empty fake sections', () => {
    const detail = toGhostPluginDetail(
      installed({
        manifest: manifest({
          author: undefined,
          description: undefined,
          tools: undefined,
          network: undefined,
          command: undefined,
          slots: ['tool'],
        }),
      }),
    );

    expect(detail.author).toBeNull();
    expect(detail.description).toBe('');
    expect(detail.tools).toEqual([]);
    expect(detail.canUse).toBe(false);
    expect(detail.permissions.map((item) => item.kind)).toEqual(['code']);
  });

  it('derives the real panel field without exposing the raw manifest', () => {
    const detail = toGhostPluginDetail(
      installed({
        manifest: manifest({
          slots: ['panel', 'cindy'],
          panel: { html: 'panel.html', minWidth: 360 },
          cindy: { image: ['generate', 'edit'], video: ['generate'] },
        }),
      }),
    );

    expect(detail.panelMinWidth).toBe(360);
    expect(detail).not.toHaveProperty('manifest');
  });
});

describe('plugin panel owner isolation', () => {
  it('gives each data owner its own panel host key and stays stable within one', () => {
    const cloudA = ghostPanelOwnerKey('cloud', 'owner-a');
    const cloudB = ghostPanelOwnerKey('cloud', 'owner-b');
    const local = ghostPanelOwnerKey('local', null);

    // 账号 A 与 B 即便装了同 id / 同版本 / 同入口的插件,宿主 key 也必须不同——
    // 否则 React 复用同一 webview 实例,A 的 DOM 与内存态会留在 B 面前。
    expect(new Set([cloudA, cloudB, local]).size).toBe(3);
    // 同一身份内稳定,不会无谓重挂面板。
    expect(ghostPanelOwnerKey('cloud', 'owner-a')).toBe(cloudA);
  });

  it('closes an open panel when the data owner changes, keeps it otherwise', () => {
    const a = ghostPanelOwnerKey('cloud', 'owner-a');
    const b = ghostPanelOwnerKey('cloud', 'owner-b');

    // A 打开着面板 → 切到 B:必须关掉,不许因为 B 也装了同 id 的插件就留着。
    expect(nextOpenPanelIdForOwner(a, b, 'ghost-shared')).toBeNull();
    // 云 → 本地同样算换身份。
    expect(
      nextOpenPanelIdForOwner(a, ghostPanelOwnerKey('local', null), 'ghost-shared'),
    ).toBeNull();
    // 身份没变则原样保留(别把用户正在用的面板关掉)。
    expect(nextOpenPanelIdForOwner(a, a, 'ghost-shared')).toBe('ghost-shared');
    expect(nextOpenPanelIdForOwner(a, a, null)).toBeNull();
  });
});
