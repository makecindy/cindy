import { describe, expect, it } from 'vitest';

import { rightSidebarOwnsRailChromeActions } from '../railChromeActions';

const baseInput = {
  hasRailChromeActions: true,
  rightSidebarSide: 'left' as const,
  rightSidebarAvailable: true,
  rightSidebarLoaded: true,
  isRightSidebarCollapsed: false,
  isRightSidebarMaximized: false,
  rsbDetached: false,
};

describe('rightSidebarOwnsRailChromeActions', () => {
  it('assigns the hit hole to a rendered, expanded left-side right sidebar', () => {
    expect(rightSidebarOwnsRailChromeActions(baseInput)).toBe(true);
  });

  it.each([
    ['the route has not declared the sidebar', { rightSidebarAvailable: false }],
    ['the embedded sidebar has not loaded', { rightSidebarLoaded: false }],
    ['the sidebar is collapsed', { isRightSidebarCollapsed: true }],
    ['the sidebar is detached', { rsbDetached: true }],
    ['the sidebar is docked right', { rightSidebarSide: 'right' as const }],
  ])('keeps the ContentHeader as owner when %s', (_reason, overrides) => {
    expect(rightSidebarOwnsRailChromeActions({ ...baseInput, ...overrides })).toBe(false);
  });

  it('assigns the hit hole to a rendered maximized right-docked sidebar', () => {
    expect(
      rightSidebarOwnsRailChromeActions({
        ...baseInput,
        rightSidebarSide: 'right',
        isRightSidebarMaximized: true,
      }),
    ).toBe(true);
  });

  it.each([
    ['the route has not declared the sidebar', { rightSidebarAvailable: false }],
    ['the embedded sidebar has not loaded', { rightSidebarLoaded: false }],
    ['the sidebar is collapsed', { isRightSidebarCollapsed: true }],
    ['the sidebar is detached', { rsbDetached: true }],
  ])('keeps the ContentHeader as owner for a maximized right sidebar when %s', (_reason, overrides) => {
    expect(
      rightSidebarOwnsRailChromeActions({
        ...baseInput,
        rightSidebarSide: 'right',
        isRightSidebarMaximized: true,
        ...overrides,
      }),
    ).toBe(false);
  });
});
