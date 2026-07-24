// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import {
  _resetTabKindRegistry,
  getTabKind,
  listGhostTabMenuMetas,
} from '../../features/right-sidebar/registry';
import { __resetPanelRegistryForTest, hasPanelKind } from '../../panels/registry';
import { __resetGhostPanelsForTest, syncGhostPanelRegistrations } from '../ghostPanels';
import {
  __resetGhostTabPluginsForTest,
  buildGhostTabPlugin,
  syncGhostTabRegistrations,
} from '../ghostTabPlugins';

/** 造一个已装意识(panel 可覆写;enabled 默认 true)。 */
function ghost(id: string, panel?: GhostManifest['panel'], enabled = true): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: `${id} 意识`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: panel ?? { html: 'panel.html', position: 'tab' },
  };
  return { manifest, dir: `/fake/${id}`, enabled };
}

afterEach(() => {
  __resetGhostTabPluginsForTest();
  _resetTabKindRegistry();
  __resetPanelRegistryForTest();
  __resetGhostPanelsForTest();
});

describe('buildGhostTabPlugin · 契约形状', () => {
  it('kind 复用 ghost:<id>;menu 单例、labelText 取 panel.title 缺省意识名', () => {
    const withTitle = buildGhostTabPlugin(ghost('art', { html: 'p.html', position: 'tab', title: '画廊' }).manifest);
    expect(withTitle.kind).toBe('ghost:art');
    expect(withTitle.menu).toMatchObject({
      kind: 'ghost:art',
      labelText: '画廊',
      labelKey: 'rightSidebar.tabs.kinds.ghostPanel',
      singleton: true,
      enabled: true,
    });
    expect(withTitle.defaultState()).toBeNull();

    const noTitle = buildGhostTabPlugin(ghost('plain').manifest);
    expect(noTitle.menu.labelText).toBe('plain 意识');
  });
});

describe('syncGhostTabRegistrations · Tab 注册表与已装清单对齐', () => {
  it("position:'tab' 且启用的注册;停用/消失的注销", () => {
    syncGhostTabRegistrations([ghost('a'), ghost('b')]);
    expect(getTabKind('ghost:a')).not.toBeNull();
    expect(getTabKind('ghost:b')).not.toBeNull();

    // b 停用、a 保留
    syncGhostTabRegistrations([ghost('a'), ghost('b', undefined, false)]);
    expect(getTabKind('ghost:a')).not.toBeNull();
    expect(getTabKind('ghost:b')).toBeNull();

    // 全卸光
    syncGhostTabRegistrations([]);
    expect(getTabKind('ghost:a')).toBeNull();
  });

  it('清单没变 → 不重注册(plugin 身份稳定);换版 → 原位换新', () => {
    syncGhostTabRegistrations([ghost('a')]);
    const before = getTabKind('ghost:a');
    syncGhostTabRegistrations([ghost('a')]);
    expect(getTabKind('ghost:a')).toBe(before);

    const upgraded = ghost('a');
    upgraded.manifest.version = '2.0.0';
    syncGhostTabRegistrations([upgraded]);
    const after = getTabKind('ghost:a');
    expect(after).not.toBe(before);
    expect(after).not.toBeNull();
  });

  it('listGhostTabMenuMetas 只含 ghost 项,按 labelText 稳定排序', () => {
    syncGhostTabRegistrations([
      ghost('zeta', { html: 'p.html', position: 'tab', title: '备忘' }),
      ghost('alpha', { html: 'p.html', position: 'tab', title: '画廊' }),
    ]);
    expect(listGhostTabMenuMetas().map((m) => m.labelText)).toEqual(['备忘', '画廊']);
  });
});

describe('syncGhostPanelRegistrations · 按 position 分派两个注册表', () => {
  it("tab 型只进 Tab 注册表;停靠型只进顶层面板注册表", () => {
    syncGhostPanelRegistrations([
      ghost('tabbed'),
      ghost('docked', { html: 'panel.html', position: 'right' }),
    ]);
    expect(getTabKind('ghost:tabbed')).not.toBeNull();
    expect(hasPanelKind('ghost:tabbed')).toBe(false);
    expect(hasPanelKind('ghost:docked')).toBe(true);
    expect(getTabKind('ghost:docked')).toBeNull();
  });

  it('换版把 position 从 right 改成 tab → 顶层注销、页签注册(反向亦然)', () => {
    syncGhostPanelRegistrations([ghost('m', { html: 'panel.html', position: 'right' })]);
    expect(hasPanelKind('ghost:m')).toBe(true);

    syncGhostPanelRegistrations([ghost('m', { html: 'panel.html', position: 'tab' })]);
    expect(hasPanelKind('ghost:m')).toBe(false);
    expect(getTabKind('ghost:m')).not.toBeNull();

    syncGhostPanelRegistrations([ghost('m', { html: 'panel.html', position: 'left' })]);
    expect(hasPanelKind('ghost:m')).toBe(true);
    expect(getTabKind('ghost:m')).toBeNull();
  });
});
