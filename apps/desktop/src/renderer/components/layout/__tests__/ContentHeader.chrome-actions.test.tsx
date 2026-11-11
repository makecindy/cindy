// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chrome = vi.hoisted(() => ({ trafficLightInset: 78 }));

vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => ({ isMac: true, isFullscreen: false, ...chrome }),
}));

import { FeatureSidebarSlotProvider } from '@/features/feature-context';
import { CHROME_ACTIONS_GEOMETRY } from '../chromeActionsGeometry';
import { ContentHeader } from '../ContentHeader';

describe('ContentHeader rail ChromeActions hit hole', () => {
  beforeEach(() => {
    chrome.trafficLightInset = 78;
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  // #8656: at 50% zoom the native safe area exceeds the fixed 78 CSS-px rail.
  // The old capped hole left the last buttons over a drag region. This unit
  // renders the real header and checks the full clickable extent, not source text.
  it('covers the safe-area gap and trailing buttons beside a rail at 50% zoom', () => {
    chrome.trafficLightInset = 156;
    render(
      <FeatureSidebarSlotProvider isCollapsed>
        <ContentHeader
          sidebarVisible={false}
          showCollapsedActions
          isSidebarRail
          rightSidebarAvailable={false}
          hidden={false}
        />
      </FeatureSidebarSlotProvider>,
    );
    const hitHole = screen.getByTestId('content-header-rail-chrome-actions-hit-hole');
    expect(hitHole.style.width).toBe('202px');
    expect(hitHole.parentElement?.style.paddingLeft).toBe('156px');
  });

  // Review 4465271789: a preceding 220px tool pane clips its hole before the
  // zoomed cluster ends. The adjacent real header must own the remaining 60px.
  it('protects a neighbouring header and follows its actual position after resize', () => {
    chrome.trafficLightInset = 156;
    let left = 220;
    let resize: (() => void) | undefined;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const rect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'HEADER'
        ? { x: left, left, y: 0, top: 0, width: 600, height: 46, right: left + 600, bottom: 46, toJSON() {} }
        : rect.call(this);
    });
    render(
      <FeatureSidebarSlotProvider isCollapsed>
        <ContentHeader sidebarVisible={false} showCollapsedActions isSidebarRail={false}
          rightSidebarAvailable={false} hidden={false} />
      </FeatureSidebarSlotProvider>,
    );
    expect(screen.getByTestId('content-header-rail-chrome-actions-hit-hole').style.width).toBe('60px');
    expect(screen.getByTestId('content-header-chrome-actions-spacer').style.maxWidth).toBe('60px');
    left = 300;
    act(() => resize?.());
    expect(screen.queryByTestId('content-header-rail-chrome-actions-hit-hole')).toBeNull();
    expect(screen.getByTestId('content-header-chrome-actions-spacer').style.maxWidth).toBe('0px');
    left = 120;
    act(() => resize?.());
    expect(screen.getByTestId('content-header-rail-chrome-actions-hit-hole').style.width).toBe('160px');
  });

  // Review #8662: the hit hole alone does not move a title in normal flow.
  it.each([[130, 220, 34], [156, 220, 60], [130, 280, 0]])(
    'reserves the actual expanded-header overflow (inset=%s, sidebar=%s)',
    (inset, sidebarWidth, overflow) => {
      chrome.trafficLightInset = inset;
      const { container } = render(
        <FeatureSidebarSlotProvider isCollapsed={false}>
          <ContentHeader
            sidebarVisible
            showCollapsedActions={false}
            isSidebarRail={false}
            sidebarWidth={sidebarWidth}
            rightSidebarAvailable={false}
            hidden={false}
          />
        </FeatureSidebarSlotProvider>,
      );
      const spacer = container.querySelector('header > .overflow-hidden') as HTMLElement;
      expect(spacer.style.maxWidth).toBe(`${overflow}px`);
      expect(Number.parseFloat(spacer.style.width)).toBeGreaterThanOrEqual(overflow);
    },
  );

  it('keeps the macOS rail-edge ChromeActions area outside the window drag region', () => {
    render(
      <FeatureSidebarSlotProvider isCollapsed>
        <ContentHeader
          sidebarVisible={false}
          showCollapsedActions
          isSidebarRail
          rightSidebarAvailable={false}
          hidden={false}
        />
      </FeatureSidebarSlotProvider>,
    );

    const hitHole = screen.getByTestId('content-header-rail-chrome-actions-hit-hole');
    const header = hitHole.parentElement as HTMLElement;

    expect(
      (header.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('drag');
    expect(
      (hitHole.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
    expect(hitHole.className).toContain('left-0');
    expect(hitHole.style.width).toBe(`${CHROME_ACTIONS_GEOMETRY.clusterWidth}px`);
  });

  it('does not remove the fully collapsed header drag area', () => {
    render(
      <FeatureSidebarSlotProvider isCollapsed>
        <ContentHeader
          sidebarVisible={false}
          showCollapsedActions
          isSidebarRail={false}
          rightSidebarAvailable={false}
          hidden={false}
        />
      </FeatureSidebarSlotProvider>,
    );

    expect(screen.queryByTestId('content-header-rail-chrome-actions-hit-hole')).toBeNull();
  });

  it('carves exactly the part of the cluster that a narrow sidebar cannot cover', () => {
    render(
      <FeatureSidebarSlotProvider isCollapsed>
        <ContentHeader
          sidebarVisible
          showCollapsedActions={false}
          isSidebarRail={false}
          // 侧栏可拖到 180:比簇右缘(mac 非全屏 78 + 124 = 202)窄,超出的一段要补挖。
          sidebarWidth={180}
          rightSidebarAvailable={false}
          hidden={false}
        />
      </FeatureSidebarSlotProvider>,
    );

    const hitHole = screen.getByTestId('content-header-rail-chrome-actions-hit-hole');
    expect(hitHole.style.width).toBe(
      `${CHROME_ACTIONS_GEOMETRY.macTrafficLightLeft + CHROME_ACTIONS_GEOMETRY.clusterWidth - 180}px`,
    );
  });

  it('leaves the header drag area alone when the sidebar covers the whole cluster', () => {
    render(
      <FeatureSidebarSlotProvider isCollapsed>
        <ContentHeader
          sidebarVisible
          showCollapsedActions={false}
          isSidebarRail={false}
          sidebarWidth={260}
          rightSidebarAvailable={false}
          hidden={false}
        />
      </FeatureSidebarSlotProvider>,
    );

    expect(screen.queryByTestId('content-header-rail-chrome-actions-hit-hole')).toBeNull();
  });
});
