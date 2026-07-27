/**
 * registry 单测 —— TabKindRegistry 行为契约。
 *
 * 覆盖:
 *   - registerTabKind 正常注册 + 重复 throw + listTabKindMenuMetas 按 order 排序
 *   - dev HMR 放行:同 hot.data 标记重注册覆盖不抛;不同 hot.data 撞 kind 仍 throw;
 *     hot 存在但缺 data(vitest 式残缺 stub)不炸、fail-fast 不变
 *   - getTabKind 命中 / 未命中
 *   - hydrateTabState:plugin null / 有 hydrateState / null → defaultState / 透传
 *   - _resetTabKindRegistry 清空 + 不影响后续注册
 *
 * 测试间用 `_resetTabKindRegistry` 隔离,避免 import-side-effect 注册的 file-browser /
 * web-browser plugin 污染单测桩。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Globe, FolderTree } from 'lucide-react';

import {
  _resetTabKindRegistry,
  getTabKind,
  hydrateTabState,
  listGhostTabMenuMetas,
  listTabKindMenuMetas,
  registerTabKind,
  unregisterTabKind,
} from '../registry';
import type { TabKindId, TabKindPlugin } from '../types';

const StubBody = () => null;
const StubTitle = () => null;

function makePlugin(kind: TabKindId, order: number, extras?: Partial<TabKindPlugin>): TabKindPlugin {
  return {
    kind,
    menu: {
      kind,
      labelKey: `stub.${kind}`,
      icon: kind === 'web-browser' ? Globe : FolderTree,
      order,
      enabled: true,
    },
    TabPillTitle: StubTitle,
    TabBody: StubBody,
    defaultState: () => ({ default: true }),
    ...extras,
  } as TabKindPlugin;
}

describe('TabKindRegistry', () => {
  beforeEach(() => _resetTabKindRegistry());
  afterEach(() => _resetTabKindRegistry());

  describe('registerTabKind', () => {
    it('registers a plugin and makes it retrievable via getTabKind', () => {
      const plugin = makePlugin('file-browser', 10);
      registerTabKind(plugin);
      expect(getTabKind('file-browser')).toBe(plugin);
    });

    it('throws on duplicate kind registration (fail-fast)', () => {
      registerTabKind(makePlugin('file-browser', 10));
      expect(() => registerTabKind(makePlugin('file-browser', 20))).toThrow(
        /already registered/,
      );
    });

    it('allows same-module re-registration under HMR (hot.data marker matches)', () => {
      // 模拟 dev HMR:同一插件模块热更重执行,拿到的 hot.data 跨实例持久
      const hot = { data: {} as Record<string, unknown> };
      registerTabKind(makePlugin('file-browser', 10), hot);
      expect(() => registerTabKind(makePlugin('file-browser', 99), hot)).not.toThrow();
      expect(getTabKind('file-browser')?.menu.order).toBe(99);
    });

    it('still throws when a different module collides on the same kind (fresh hot.data)', () => {
      // 两个不同模块各自的 hot.data 互不相识 → fail-fast 语义不变
      const hotA = { data: {} as Record<string, unknown> };
      const hotB = { data: {} as Record<string, unknown> };
      registerTabKind(makePlugin('file-browser', 10), hotA);
      expect(() => registerTabKind(makePlugin('file-browser', 20), hotB)).toThrow(
        /already registered/,
      );
    });

    it('tolerates a hot context without data (vitest-style stub) and keeps fail-fast', () => {
      // vitest(vite-node)注入的 import.meta.hot 是 truthy 但没有 data 的残缺对象:
      // 不能炸,也打不了标记 → 重复注册仍走 fail-fast(2026-07-12 实踩回归)
      const hot = {} as { data?: Record<string, unknown> };
      expect(() => registerTabKind(makePlugin('file-browser', 10), hot)).not.toThrow();
      expect(() => registerTabKind(makePlugin('file-browser', 20), hot)).toThrow(
        /already registered/,
      );
    });

    it('different kinds can co-exist', () => {
      const a = makePlugin('file-browser', 10);
      const b = makePlugin('web-browser', 20);
      registerTabKind(a);
      registerTabKind(b);
      expect(getTabKind('file-browser')).toBe(a);
      expect(getTabKind('web-browser')).toBe(b);
    });
  });

  describe('unregisterTabKind', () => {
    it('removes a registered plugin; idempotent on missing kind', () => {
      registerTabKind(makePlugin('file-browser', 10));
      unregisterTabKind('file-browser');
      expect(getTabKind('file-browser')).toBeNull();
      // 幂等:再注销同 kind / 从未注册的 kind 都不抛
      expect(() => unregisterTabKind('file-browser')).not.toThrow();
      expect(() => unregisterTabKind('ghost:never')).not.toThrow();
    });

    it('allows re-registering same kind after unregister(停用→重新启用复活)', () => {
      registerTabKind(makePlugin('file-browser', 10));
      unregisterTabKind('file-browser');
      expect(() => registerTabKind(makePlugin('file-browser', 99))).not.toThrow();
      expect(getTabKind('file-browser')?.menu.order).toBe(99);
    });
  });

  describe('listGhostTabMenuMetas', () => {
    it('only returns ghost:* kinds, sorted by labelText', () => {
      registerTabKind(makePlugin('file-browser', 10));
      registerTabKind(
        makePlugin('ghost:zeta' as TabKindId, 100, {
          menu: {
            kind: 'ghost:zeta' as TabKindId,
            labelKey: 'stub.ghost',
            labelText: '备忘',
            icon: Globe,
            order: 100,
            enabled: true,
            singleton: true,
          },
        }),
      );
      registerTabKind(
        makePlugin('ghost:alpha' as TabKindId, 100, {
          menu: {
            kind: 'ghost:alpha' as TabKindId,
            labelKey: 'stub.ghost',
            labelText: '画廊',
            icon: Globe,
            order: 100,
            enabled: true,
            singleton: true,
          },
        }),
      );
      expect(listGhostTabMenuMetas().map((m) => m.labelText)).toEqual(['备忘', '画廊']);
      // 内置项不混入
      expect(listGhostTabMenuMetas().some((m) => m.kind === 'file-browser')).toBe(false);
    });
  });

  describe('getTabKind', () => {
    it('returns null for unregistered kind', () => {
      expect(getTabKind('terminal')).toBeNull();
      expect(getTabKind('review')).toBeNull();
    });

    it('returns the registered plugin instance', () => {
      const plugin = makePlugin('web-browser', 20);
      registerTabKind(plugin);
      expect(getTabKind('web-browser')).toBe(plugin);
    });
  });

  describe('listTabKindMenuMetas', () => {
    it('returns metas sorted by order ascending', () => {
      registerTabKind(makePlugin('web-browser', 20));
      registerTabKind(makePlugin('file-browser', 10));
      const metas = listTabKindMenuMetas();
      expect(metas.map((m) => m.kind)).toEqual(['file-browser', 'web-browser']);
    });

    it('filters out plugin kinds that are hidden from the add-tab menu', () => {
      registerTabKind(makePlugin('file-browser', 10));
      registerTabKind(makePlugin('orca-workers', 18, {
        menu: {
          kind: 'orca-workers',
          labelKey: 'stub.orca-workers',
          icon: FolderTree,
          order: 18,
          enabled: true,
          hiddenFromMenu: true,
        },
      }));
      expect(listTabKindMenuMetas().map((m) => m.kind)).toEqual(['file-browser']);
    });

    it('returns empty array when registry is empty', () => {
      expect(listTabKindMenuMetas()).toEqual([]);
    });
  });

  describe('hydrateTabState', () => {
    it('returns raw unchanged when plugin is null', () => {
      const raw = { foo: 'bar' };
      expect(hydrateTabState(null, raw)).toBe(raw);
      expect(hydrateTabState(null, null)).toBeNull();
    });

    it('uses plugin.hydrateState when provided', () => {
      const hydrated = { hydrated: true };
      const plugin = makePlugin('file-browser', 10, {
        hydrateState: () => hydrated,
      });
      expect(hydrateTabState(plugin, { anything: 1 })).toBe(hydrated);
      // hydrateState 必须能处理 null:plugin 应当自行兜底,registry 不替它判
      expect(hydrateTabState(plugin, null)).toBe(hydrated);
    });

    it('falls back to defaultState when raw is null/undefined and no hydrateState', () => {
      const defaultObj = { default: true };
      const plugin = makePlugin('file-browser', 10, {
        defaultState: () => defaultObj,
      });
      expect(hydrateTabState(plugin, null)).toEqual(defaultObj);
      expect(hydrateTabState(plugin, undefined)).toEqual(defaultObj);
    });

    it('returns raw as-is when defined and no hydrateState', () => {
      const plugin = makePlugin('file-browser', 10);
      const raw = { existing: 'state' };
      expect(hydrateTabState(plugin, raw)).toBe(raw);
    });
  });

  describe('_resetTabKindRegistry', () => {
    it('clears all registered plugins', () => {
      registerTabKind(makePlugin('file-browser', 10));
      registerTabKind(makePlugin('web-browser', 20));
      _resetTabKindRegistry();
      expect(getTabKind('file-browser')).toBeNull();
      expect(getTabKind('web-browser')).toBeNull();
      expect(listTabKindMenuMetas()).toEqual([]);
    });

    it('allows re-registering same kind after reset', () => {
      registerTabKind(makePlugin('file-browser', 10));
      _resetTabKindRegistry();
      // 不抛 "already registered"
      expect(() => registerTabKind(makePlugin('file-browser', 99))).not.toThrow();
      expect(getTabKind('file-browser')?.menu.order).toBe(99);
    });
  });
});
