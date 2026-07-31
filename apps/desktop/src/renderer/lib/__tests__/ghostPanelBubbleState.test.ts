// @vitest-environment jsdom
// ghostPanelBubbleState:localStorage 持久化的气泡最小化状态。
import { afterEach, describe, expect, it } from 'vitest';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import {
  __resetGhostPanelBubbleStateForTest,
  getGhostPanelBubbleState,
  isGhostPanelKindMinimized,
  minimizeGhostPanel,
  reconcileGhostPanelBubbles,
  restoreGhostPanel,
  setGhostPanelBubblePosition,
} from '../ghostPanelBubbleState';

const KEY = 'xdt:ghostPanelBubble:v1';

function ghost(
  id: string,
  opts: { enabled?: boolean; position?: 'left' | 'tab'; minimizeButton?: boolean; panel?: boolean } = {},
): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: opts.panel === false ? ['tool'] : ['panel'],
    ...(opts.panel === false
      ? {}
      : {
          panel: {
            html: 'panel.html',
            ...(opts.position !== undefined ? { position: opts.position } : {}),
            ...(opts.minimizeButton === false ? { systemButtons: { minimize: false } } : {}),
          },
        }),
  };
  return { manifest, dir: `/fake/${id}`, enabled: opts.enabled ?? true };
}

afterEach(() => {
  __resetGhostPanelBubbleStateForTest();
});

describe('ghostPanelBubbleState · sanitize', () => {
  it('坏 JSON / 非对象 → 空表', () => {
    window.localStorage.setItem(KEY, '{{{');
    expect(getGhostPanelBubbleState()).toEqual({});
    __resetGhostPanelBubbleStateForTest();
    window.localStorage.setItem(KEY, '[1,2]');
    expect(getGhostPanelBubbleState()).toEqual({});
  });

  it('minimized 非布尔整条丢;x/y 非双双有限数则略去;空条目不留', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        bad: { minimized: 'yes', x: 1, y: 2 },
        halfpos: { minimized: true, x: 10 },
        floaty: { minimized: true, x: 10.6, y: 20.2 },
        empty: { minimized: false },
        good: { minimized: false, x: 5, y: 6 },
      }),
    );
    expect(getGhostPanelBubbleState()).toEqual({
      halfpos: { minimized: true },
      floaty: { minimized: true, x: 11, y: 20 },
      good: { minimized: false, x: 5, y: 6 },
    });
  });
});

describe('ghostPanelBubbleState · 最小化/恢复/位置', () => {
  it('minimize → restore 往返:位置保留;无位置的还原条目清除;持久化可重读', () => {
    minimizeGhostPanel('a');
    expect(isGhostPanelKindMinimized('ghost:a')).toBe(true);
    setGhostPanelBubblePosition('a', 100.4, 200.6);
    restoreGhostPanel('a');
    expect(isGhostPanelKindMinimized('ghost:a')).toBe(false);
    expect(getGhostPanelBubbleState().a).toEqual({ minimized: false, x: 100, y: 201 });

    // 持久化载荷可直接重读(模拟重启的数据面)
    minimizeGhostPanel('b');
    setGhostPanelBubblePosition('b', 1, 2);
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    expect(raw.b).toEqual({ minimized: true, x: 1, y: 2 });

    // 无位置的还原条目直接清除
    minimizeGhostPanel('c');
    restoreGhostPanel('c');
    expect(getGhostPanelBubbleState().c).toBeUndefined();
  });

  it('谓词:非 ghost 前缀恒 false', () => {
    minimizeGhostPanel('a');
    expect(isGhostPanelKindMinimized('chat-main')).toBe(false);
    expect(isGhostPanelKindMinimized('right-tabs')).toBe(false);
  });
});

describe('ghostPanelBubbleState · reconcile(与已装清单对齐)', () => {
  it('卸载删条目;停用/tab/关按钮强制还原(留位置);合格的不动', () => {
    minimizeGhostPanel('gone');
    minimizeGhostPanel('disabled');
    setGhostPanelBubblePosition('disabled', 9, 9);
    minimizeGhostPanel('tabbed');
    minimizeGhostPanel('nobtn');
    minimizeGhostPanel('stays');

    reconcileGhostPanelBubbles([
      ghost('disabled', { enabled: false }),
      ghost('tabbed', { position: 'tab' }),
      ghost('nobtn', { minimizeButton: false }),
      ghost('stays'),
    ]);

    const state = getGhostPanelBubbleState();
    expect(state.gone).toBeUndefined();
    expect(state.disabled).toEqual({ minimized: false, x: 9, y: 9 });
    expect(state.tabbed).toBeUndefined(); // 无位置的还原条目清除
    expect(state.nobtn).toBeUndefined();
    expect(state.stays).toEqual({ minimized: true });
  });
});

describe('ghostPanelBubbleState · 变化信号(引用替换)', () => {
  it('只有真实变化才替换表引用(useSyncExternalStore 的更新信号)', () => {
    const before = getGhostPanelBubbleState();
    reconcileGhostPanelBubbles([ghost('x')]); // 无条目 → 无变化,同一引用
    expect(getGhostPanelBubbleState()).toBe(before);
    minimizeGhostPanel('x'); // commit 替换引用
    expect(getGhostPanelBubbleState()).not.toBe(before);
    const after = getGhostPanelBubbleState();
    minimizeGhostPanel('x'); // 已最小化,幂等短路,不替换
    expect(getGhostPanelBubbleState()).toBe(after);
  });
});
