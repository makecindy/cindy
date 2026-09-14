import { describe, expect, it } from 'vitest';

import { deriveCardState, localGroupForItem, type LocalSkillIndex } from '../../hooks/useMarketList';
import { skillhubCatalogKey } from '../../../../../shared/skillhubCatalog';

const item = (over: Record<string, unknown> = {}) => ({
  name: 'x',
  isMine: false,
  latestVersion: '1.0.0',
  latestPublishedFromDeviceId: null,
  ...over,
} as never);

const grp = (g?: { version: string | null; hasRegistryEntry: boolean }) =>
  (g
    ? { global: { version: g.version, absolutePath: '/p', hasRegistryEntry: g.hasRegistryEntry }, projects: [] }
    : { global: undefined, projects: [] }) as never;

describe('deriveCardState — isMine 按目录判已装', () => {
  it('mine + 本地有全局目录 → installed-latest(即便无 registry)', () => {
    expect(deriveCardState(item({ isMine: true }), grp({ version: null, hasRegistryEntry: false }), false))
      .toBe('installed-latest');
  });

  it('mine + 本地无目录 → not-installed(换机器可重新下载)', () => {
    expect(deriveCardState(item({ isMine: true }), grp(undefined), false)).toBe('not-installed');
  });

  it('非 mine + 有目录但无 registry → not-installed(保护手写同名)', () => {
    expect(deriveCardState(item({ isMine: false }), grp({ version: null, hasRegistryEntry: false }), false))
      .toBe('not-installed');
  });

  it('非 mine + 有 registry 且版本落后 → installed-outdated', () => {
    expect(deriveCardState(item({ isMine: false, latestVersion: '2.0.0' }), grp({ version: '1.0.0', hasRegistryEntry: true }), false))
      .toBe('installed-outdated');
  });

  it('installing 优先级最高', () => {
    expect(deriveCardState(item({ isMine: true }), grp(undefined), true)).toBe('installing');
  });
});

describe('market install catalog matching', () => {
  const entry = (version: string) => ({
    version,
    absolutePath: `/p/${version}`,
    hasRegistryEntry: true,
  });
  const index: LocalSkillIndex = {
    byCatalogKey: new Map([
      [skillhubCatalogKey('same', 'market'), { global: entry('1.0.0'), projects: [] }],
      [skillhubCatalogKey('same', 'team'), { global: entry('2.0.0'), projects: [] }],
    ]),
    untrackedByName: new Map(),
  };

  it('keeps same-slug market and team installs independent', () => {
    expect(localGroupForItem({ name: 'same', isMine: false, catalogScope: 'market' }, index)?.global?.version)
      .toBe('1.0.0');
    expect(localGroupForItem({ name: 'same', isMine: false, catalogScope: 'team' }, index)?.global?.version)
      .toBe('2.0.0');
    expect(localGroupForItem({ name: 'same', isMine: false }, index)).toBeUndefined();
  });
});
