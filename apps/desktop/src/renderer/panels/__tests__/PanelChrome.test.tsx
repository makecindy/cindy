// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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
});
