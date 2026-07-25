// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CHROME_ACTIONS_GEOMETRY } from '../../components/layout/chromeActionsGeometry';
import { PanelMaximizeContext, type PanelMaximizeState } from '../../layout/panelMaximize';
import { PanelChrome } from '../PanelChrome';

// 仓库同款 i18n mock:t 返回 key 本身,便于断言。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** 带真实 toggle 语义的 harness:同 kind 再点 = 还原(与 LayoutRoot 实现一致)。 */
function Harness({ panelKind }: { panelKind?: string }) {
  const [maximizedKind, setMaximizedKind] = useState<string | null>(null);
  const ctx: PanelMaximizeState = {
    maximizedKind,
    toggle: (kind) => setMaximizedKind((cur) => (cur === kind ? null : kind)),
  };
  return (
    <PanelMaximizeContext.Provider value={ctx}>
      <PanelChrome title="测试面板" panelKind={panelKind} />
    </PanelMaximizeContext.Provider>
  );
}

afterEach(cleanup);

describe('PanelChrome · 撑满系统按钮', () => {
  it('传 panelKind 且在 PanelMaximizeContext 下 → 长出撑满按钮,点按在撑满/还原间切换', () => {
    render(<Harness panelKind="ghost:demo" />);
    const btn = screen.getByRole('button', { name: 'panelChrome.maximizeAria' });
    fireEvent.click(btn);
    // 撑满后按钮语义翻转为"还原"
    const restore = screen.getByRole('button', { name: 'panelChrome.restoreAria' });
    fireEvent.click(restore);
    expect(screen.getByRole('button', { name: 'panelChrome.maximizeAria' })).toBeTruthy();
  });

  it('不传 panelKind → 不渲染系统按钮(旧行为不变)', () => {
    render(<Harness />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('脱离 PanelMaximizeContext 单渲(如测试/独立宿主)→ 不渲染系统按钮', () => {
    render(<PanelChrome title="测试面板" panelKind="ghost:demo" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('传 onDetach → 长出独立窗口按钮,点击回调触发;与撑满按钮并存', () => {
    const onDetach = vi.fn();
    render(
      <PanelMaximizeContext.Provider
        value={{ maximizedKind: null, toggle: () => undefined }}
      >
        <PanelChrome title="测试面板" panelKind="ghost:demo" onDetach={onDetach} />
      </PanelMaximizeContext.Provider>,
    );
    const detachBtn = screen.getByRole('button', { name: 'panelChrome.detachAria' });
    fireEvent.click(detachBtn);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'panelChrome.maximizeAria' })).toBeTruthy();
  });

  it('只传 onDetach(无 panelKind)→ 只有独立窗口按钮', () => {
    render(<PanelChrome title="测试面板" onDetach={() => undefined} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'panelChrome.detachAria' })).toBeTruthy();
  });

  it('46px 顶带为 ChromeActions 按钮簇挖 no-drag 洞(左栏折叠 + 面板顶到窗口最左时按钮可点)', () => {
    render(<PanelChrome title="测试面板" />);
    const hole = screen.getByTestId('panel-chrome-actions-hit-hole');
    const strip = hole.parentElement as HTMLElement;
    // 洞必须是 drag 顶带的后代(Electron 挖洞只在 drag 元素后代上可靠生效)。
    expect(
      (strip.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('drag');
    expect(
      (hole.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
    // fixed 定位钉窗口坐标(jsdom 无 electronAPI → 非 mac → defaultLeft)。
    expect(hole.className).toContain('fixed');
    expect(hole.style.left).toBe(`${CHROME_ACTIONS_GEOMETRY.defaultLeft}px`);
    expect(hole.style.width).toBe(`${CHROME_ACTIONS_GEOMETRY.clusterWidth}px`);
  });

  it('传 onMinimize → 长出气泡最小化按钮并触发回调;三按钮 DOM 顺序 minimize→detach→maximize', () => {
    const onMinimize = vi.fn();
    render(
      <PanelMaximizeContext.Provider value={{ maximizedKind: null, toggle: () => undefined }}>
        <PanelChrome
          title="测试面板"
          panelKind="ghost:demo"
          onDetach={() => undefined}
          onMinimize={onMinimize}
        />
      </PanelMaximizeContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'panelChrome.minimizeAria' }));
    expect(onMinimize).toHaveBeenCalledTimes(1);
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([
      'panelChrome.minimizeAria',
      'panelChrome.detachAria',
      'panelChrome.maximizeAria',
    ]);
  });
});
