// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../hooks/useWorkers';
import { WorkerListToolbar } from '../RolePillDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-a',
    sessionId: 'session-a',
    role: 'developer',
    agent: 'codex',
    model: 'gpt-5.4',
    effort: null,
    label: null,
    status: 'idle',
    focused: true,
    idleSince: null,
    ...overrides,
  };
}

function renderToolbar() {
  const current = worker();
  return render(
    <WorkerListToolbar
      worker={current}
      workers={[current]}
      selectedWorkerId={current.workerId}
      activeWorkerCount={1}
      softLimit={5}
      hardLimit={8}
      onSwitchFocus={vi.fn()}
      onOpenCreate={vi.fn()}
      onOpenSettings={vi.fn()}
      onArchiveWorker={vi.fn()}
    />,
  );
}

function menuButton(): HTMLElement {
  return screen.getByRole('button', { name: 'orca.rolePill.layoutMenuLabel' });
}

// 侧栏拖拽分割线（pointermove）不会触发 window.resize，菜单边界需靠 ResizeObserver
// 监听裁剪祖先容器尺寸变化来重算。本组用例验证该接线。
describe('worker 菜单随裁剪容器缩放重算边界', () => {
  type ObserverRecord = { callback: ResizeObserverCallback; observed: Element | null };
  let observers: ObserverRecord[];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly callback: ResizeObserverCallback;
        observed: Element | null = null;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(el: Element) {
          this.observed = el;
          observers.push({ callback: this.callback, observed: el });
        }
        unobserve() {}
        disconnect() {}
      },
    );
    // 让最近祖先被识别为 overflow 非 visible 的裁剪容器，命中 ResizeObserver 分支。
    // 其余属性/方法透传真实 CSSStyleDeclaration，避免破坏 dom-accessibility-api 的
    // getPropertyValue 等调用。
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const style = realGetComputedStyle(el);
      return new Proxy(style, {
        get(target, prop) {
          if (prop === 'overflowX' || prop === 'overflowY') return 'hidden';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it('打开 ⋮ 菜单后，ResizeObserver 观察裁剪祖先容器', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();

    // 至少存在一个观察了非空裁剪容器的 ResizeObserver（⋮ 菜单 / dropdown 各一个）。
    expect(observers.length).toBeGreaterThan(0);
    expect(observers.some((o) => o.observed !== null)).toBe(true);
  });

  it('裁剪容器尺寸变化触发回调时菜单重新计算边界且不报错', () => {
    renderToolbar();
    fireEvent.click(menuButton());
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();

    const observed = observers.filter((o) => o.observed !== null);
    expect(observed.length).toBeGreaterThan(0);

    act(() => {
      observed.forEach((o) =>
        o.callback([{ contentRect: { width: 280 } } as ResizeObserverEntry], o as unknown as ResizeObserver),
      );
    });

    // 重算后菜单仍正常渲染（未被裁剪祖先缩放逻辑抛错）。
    expect(screen.getByText('orca.rolePill.workersHeader')).toBeTruthy();
  });
});
