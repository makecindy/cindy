// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
