// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => ({ isMac: true, isFullscreen: false }),
}));

import { FeatureSidebarSlotProvider } from '@/features/feature-context';
import { CHROME_ACTIONS_GEOMETRY } from '../chromeActionsGeometry';
import { ContentHeader, ContentHeaderSlot } from '../ContentHeader';

describe('ContentHeader rail ChromeActions hit hole', () => {
  // Unit: a contributed trailing action is visible on routes with no title;
  // removing it restores the original hidden chrome. Old drag-hole cases have
  // hidden=false and cannot exercise this empty-route lifecycle.
  it('retains an otherwise empty header for trailing actions and hides it again after removal', () => {
    const click = vi.fn();
    const draw = (withAction: boolean) => <FeatureSidebarSlotProvider isCollapsed={false}>
      <ContentHeaderSlot sidebarVisible showCollapsedActions={false} isSidebarRail={false} rightSidebarAvailable={false}
        trailing={withAction ? <button onClick={click}>Plugin action</button> : undefined}>Original content</ContentHeaderSlot>
    </FeatureSidebarSlotProvider>;
    const view = render(draw(true));
    screen.getByRole('button', { name: 'Plugin action' }).click();
    expect(click).toHaveBeenCalledOnce();
    view.rerender(draw(false));
    expect(screen.queryByRole('button', { name: 'Plugin action' })).toBeNull();
    expect(view.container.querySelector('header')).toBeNull();
    expect(screen.getByText('Original content')).toBeTruthy();
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
