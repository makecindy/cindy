// @vitest-environment jsdom

import { useMemo, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FeatureSidebarSlotProvider, useRegisterSidebarUpper } from '@/features/feature-context';
import type { SidebarPeekState } from '@/hooks/useSidebarPeek';
import { Sidebar } from '../Sidebar';

const mocks = vi.hoisted(() => ({
  isSecondaryWindow: true,
}));

vi.mock('@/lib/secondaryWindow', () => ({
  isSecondaryWindow: () => mocks.isSecondaryWindow,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => ({ isMac: true, isFullscreen: false }),
}));

vi.mock('@/features/cc-agent/sidebar/conversationSearchContext', () => ({
  ConversationSearchProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="conversation-search-provider">{children}</div>
  ),
}));

vi.mock('../SidebarTopNav', () => ({
  SidebarTopNav: () => <div data-testid="sidebar-top-nav" />,
}));

vi.mock('../UpdateBanner', () => ({
  UpdateBanner: () => null,
}));

vi.mock('../UserInfoSection', () => ({
  UserInfoSection: () => null,
}));

function UpperProbe() {
  return <div data-testid="sidebar-upper" />;
}

function RegisterUpper() {
  const upper = useMemo(() => <UpperProbe />, []);
  useRegisterSidebarUpper(upper);
  return null;
}

interface HarnessProps {
  isCollapsed: boolean;
  isRail?: boolean;
  peekState?: SidebarPeekState | null;
}

function Harness({ isCollapsed, isRail = false, peekState = null }: HarnessProps) {
  return (
    <FeatureSidebarSlotProvider isCollapsed={peekState != null ? false : isCollapsed || isRail}>
      <RegisterUpper />
      <Sidebar isCollapsed={isCollapsed} isRail={isRail} peekState={peekState} />
    </FeatureSidebarSlotProvider>
  );
}

describe('Sidebar secondary-window lazy feature content', () => {
  beforeEach(() => {
    mocks.isSecondaryWindow = true;
  });

  it('does not mount hidden task-list content until a secondary sidebar expands', () => {
    const view = render(<Harness isCollapsed />);

    expect(screen.queryByTestId('conversation-search-provider')).toBeNull();
    expect(screen.queryByTestId('sidebar-upper')).toBeNull();

    view.rerender(<Harness isCollapsed={false} />);

    expect(screen.getByTestId('conversation-search-provider')).toBeTruthy();
    expect(screen.getByTestId('sidebar-upper')).toBeTruthy();
  });

  it('unmounts the task-list content when the secondary sidebar is hidden again', () => {
    const view = render(<Harness isCollapsed={false} />);
    expect(screen.getByTestId('sidebar-upper')).toBeTruthy();

    view.rerender(<Harness isCollapsed />);
    expect(screen.queryByTestId('sidebar-upper')).toBeNull();

    view.rerender(<Harness isCollapsed={false} />);
    expect(screen.getByTestId('sidebar-upper')).toBeTruthy();
  });

  it('keeps feature content mounted in a secondary rail sidebar', () => {
    render(<Harness isCollapsed={false} isRail />);

    expect(screen.getByTestId('conversation-search-provider')).toBeTruthy();
    expect(screen.getByTestId('sidebar-upper')).toBeTruthy();
  });

  it.each<SidebarPeekState>(['peeking', 'peekClosing', 'pinning'])(
    'keeps feature content mounted while the secondary sidebar is %s',
    (peekState) => {
      render(<Harness isCollapsed peekState={peekState} />);

      expect(screen.getByTestId('conversation-search-provider')).toBeTruthy();
      expect(screen.getByTestId('sidebar-upper')).toBeTruthy();
    },
  );

  it("preserves the primary window's collapsed mounting behavior", () => {
    mocks.isSecondaryWindow = false;

    render(<Harness isCollapsed />);

    expect(screen.getByTestId('conversation-search-provider')).toBeTruthy();
    expect(screen.getByTestId('sidebar-upper')).toBeTruthy();
  });
});
