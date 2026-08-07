import { describe, expect, it } from 'vitest';

import { shouldReserveLeftChromeActions } from '../chromeActionsLayout';

describe('shouldReserveLeftChromeActions', () => {
  it.each([
    [
      'collapsed left-docked panel',
      {
        isSidebarCollapsed: true,
        rightSidebarSide: 'left' as const,
        isRightSidebarMaximized: false,
      },
    ],
    [
      'collapsed maximized panel',
      {
        isSidebarCollapsed: true,
        rightSidebarSide: 'right' as const,
        isRightSidebarMaximized: true,
      },
    ],
  ])('reserves the topbar chrome area for %s', (_name, input) => {
    expect(shouldReserveLeftChromeActions(input)).toBe(true);
  });

  it.each([
    [
      'expanded left-docked panel',
      {
        isSidebarCollapsed: false,
        rightSidebarSide: 'left' as const,
        isRightSidebarMaximized: false,
      },
    ],
    [
      'expanded maximized panel',
      {
        isSidebarCollapsed: false,
        rightSidebarSide: 'right' as const,
        isRightSidebarMaximized: true,
      },
    ],
    [
      'collapsed right-docked panel',
      {
        isSidebarCollapsed: true,
        rightSidebarSide: 'right' as const,
        isRightSidebarMaximized: false,
      },
    ],
  ])('does not reserve the area for %s', (_name, input) => {
    expect(shouldReserveLeftChromeActions(input)).toBe(false);
  });
});
