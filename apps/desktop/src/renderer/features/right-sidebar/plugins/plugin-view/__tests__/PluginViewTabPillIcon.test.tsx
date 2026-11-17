// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果:右侧栏插件面板页签的图标由 `plugin-view` 这个 tab kind 的
 *   `TabPillIcon` 绘制。可观察的是页签里出现的是插件品牌图 <img>,还是系统图标。
 * - Bug / 规则依据:插件面板页签此前只读 `manifest.mainView.icon`,未声明 mainView 的
 *   面板插件(如 hindsight-memory)一律显示默认拼图,与同为插件页签的 `plugin-task`
 *   使用 `iconDataUrl` 的行为不一致。
 * - 最小失败输入:插件带 iconDataUrl 但不声明 mainView。
 * - tier:unit(jsdom,useInstalledGhosts 用固定清单桩)
 */

import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const installedGhostsMock = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => installedGhostsMock.list,
  readInstalledGhostsSnapshot: () => installedGhostsMock.list,
}));

import * as registry from '../../../registry';

// 副作用导入:注册 kind="plugin-view"。
import '../../../plugins/plugin-view';

const INSTANCE_ID = 'hindsight-memory';
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function installGhost(overrides: Record<string, unknown> = {}): void {
  installedGhostsMock.list = [
    {
      instanceKey: INSTANCE_ID,
      enabled: true,
      iconDataUrl: ICON,
      manifest: { id: INSTANCE_ID, name: 'Hindsight 记忆' },
      ...overrides,
    },
  ];
}

function renderPill() {
  const kind = registry.getTabKind('plugin-view')!;
  const Icon = kind.TabPillIcon!;
  return render(<Icon state={{ instanceId: INSTANCE_ID }} sessionId="session-a" active />);
}

describe('plugin-view 页签图标', () => {
  afterEach(cleanup);
  afterAll(() => registry._resetTabKindRegistry());

  it('插件有品牌图标时渲染插件图片', () => {
    installGhost();
    const view = renderPill();

    const image = view.container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(ICON);
    expect(view.container.querySelector('.lucide-puzzle')).toBeNull();
  });

  it('插件没有图标时回退到 mainView 指定的系统图标', () => {
    installGhost({ iconDataUrl: undefined, manifest: { id: INSTANCE_ID, name: 'x', mainView: { icon: 'database' } } });
    const view = renderPill();

    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('.lucide-database')).toBeTruthy();
  });

  it('插件既没有图标也没有 mainView.icon 时显示默认拼图', () => {
    installGhost({ iconDataUrl: undefined });
    const view = renderPill();

    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('.lucide-puzzle')).toBeTruthy();
  });

  it('插件未安装时显示默认拼图', () => {
    installedGhostsMock.list = [];
    const view = renderPill();

    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('.lucide-puzzle')).toBeTruthy();
  });
});