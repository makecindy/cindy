// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsSectionTarget } from '../useSettingsSectionTarget';
import { useSettingDefinition } from '../useSettingDefinition';
import { additionalSettings } from '../AdditionalSettings.settings-search';
import { LinkOpenSection } from '../LinkOpenSection';
import { personalizationDetailsSettings } from '../PersonalizationDetails.settings-search';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Production hooks, observable DOM/scroll results (unit tier). The old single-frame
// lookup lost targets that mounted after IPC, and a detached target could still be
// highlighted after navigation. Fake timers/DOM insertion are the minimum inputs.
// Standalone local run: 2.84s wall time; no real waits or IPC.
const scrollTo = vi.fn();
let targetTop = 100;
let resized: ResizeObserverCallback;
function Page({ ready = false, active = true, hidden = false }: { ready?: boolean; active?: boolean; hidden?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const setting = useSettingDefinition(additionalSettings.browserTarget);
  useSettingsSectionTarget(active ? setting.anchorProps.id : null, ref, String(active), 'fallback');
  return (
    <div ref={ref}>
      <div id="fallback">Fallback</div>
      {ready && (
        <div {...setting.anchorProps} hidden={hidden}>
          <label>{setting.title}</label>
          <select {...setting.controlProps}>
            {setting.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  scrollTo.mockClear();
  targetTop = 100;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return { top: this.id === 'settings-browser-target' ? targetTop : 0 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement,
  ) {
    const rects = this.closest('[hidden]') ? [] : [{} as DOMRect];
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as DOMRectList;
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('settings definition and navigation', () => {
  it('gives the two link preferences distinct targets while retaining their selected defaults', () => {
    // The migration replaces a shared section anchor with row targets. Mount the
    // production section: a duplicated ID would send both results to the first row.
    render(<LinkOpenSection />);
    const web = document.getElementById(personalizationDetailsSettings.linkOpenWebLabel.targetId)!;
    const local = document.getElementById(personalizationDetailsSettings.linkOpenLocalLabel.targetId)!;
    expect(web).not.toBeNull();
    expect(local).not.toBeNull();
    expect(web).not.toBe(local);
    expect(web.querySelector('[aria-checked="true"]')?.textContent).toBe('settings.linkOpen.options.external');
    expect(local.querySelector('[aria-checked="true"]')?.textContent).toBe('settings.linkOpen.options.sidebar');
  });
  // A real settings page can grow above an already mounted target after IPC.
  it('follows late layout growth but yields immediately to user scrolling', () => {
    const view = render(<Page ready />);
    act(() => { vi.advanceTimersByTime(0); });
    targetTop = 500;
    act(() => { resized([], {} as ResizeObserver); });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 492, behavior: 'auto' });
    fireEvent.wheel(view.getByText('Fallback').parentElement!);
    scrollTo.mockClear();
    targetTop = 800;
    act(() => { resized([], {} as ResizeObserver); });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('renders shared options and moves from the fallback to the asynchronously mounted setting', async () => {
    const view = render(<Page />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(
      document.getElementById('fallback')?.classList.contains('settings-search-target-highlight'),
    ).toBe(true);
    await act(async () => {
      view.rerender(<Page ready />);
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 92, behavior: 'auto' });
    expect(
      document.getElementById('fallback')?.classList.contains('settings-search-target-highlight'),
    ).toBe(false);
    expect(
      document
        .getElementById('settings-browser-target')
        ?.classList.contains('settings-search-target-highlight'),
    ).toBe(true);
    expect(
      view
        .getByRole('option', { name: 'settings.computerUse.browserBackend.userBrowser.title' })
        .getAttribute('value'),
    ).toBe('user-browser');
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(
      document
        .getElementById('settings-browser-target')
        ?.classList.contains('settings-search-target-highlight'),
    ).toBe(false);
  });

  // 生产入口：useSettingsSectionTarget；规则：隐藏控件不能接收搜索定位/高亮。
  // 视觉桥关闭后明细仍挂载但 hidden；旧逻辑只按 id 存在选择目标，旧用例只覆盖未挂载→挂载。
  // 最小失败输入：exact 已挂载但 hidden，fallback 可见；tier：unit（真实 hook + fake timers/DOM）。
  it('uses the visible fallback while the exact target is hidden and follows it when revealed', async () => {
    const view = render(<Page ready hidden />);
    act(() => { vi.advanceTimersByTime(0); });
    expect(
      document.getElementById('fallback')?.classList.contains('settings-search-target-highlight'),
    ).toBe(true);
    expect(
      document.getElementById('settings-browser-target')?.classList.contains('settings-search-target-highlight'),
    ).toBe(false);
    await act(async () => {
      view.rerender(<Page ready />);
    });
    act(() => { resized([], {} as ResizeObserver); });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 92, behavior: 'auto' });
    expect(
      document.getElementById('fallback')?.classList.contains('settings-search-target-highlight'),
    ).toBe(false);
    expect(
      document.getElementById('settings-browser-target')?.classList.contains('settings-search-target-highlight'),
    ).toBe(true);
  });

  it.each(['navigate', 'expire'] as const)(
    'does not steal scroll after %s while waiting for a target',
    async (reason) => {
      const view = render(<Page />);
      act(() => {
        vi.advanceTimersByTime(0);
      });
      if (reason === 'expire')
        act(() => {
          vi.advanceTimersByTime(5000);
        });
      else view.rerender(<Page active={false} />);
      scrollTo.mockClear();
      await act(async () => {
        view.rerender(<Page ready active={reason === 'expire'} />);
      });
      expect(scrollTo).not.toHaveBeenCalled();
    },
  );
});
