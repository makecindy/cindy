// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Sidebar } from '@/components/sidebar/Sidebar';
import {
  setHeaderProjectMenu, setProjectSettings, useProjectSettings,
} from '@/state/headerProjectMenu';
import type { ProjectNode } from '@/features/cc-agent/lib/projectGrouping';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useSidebarMaterial', () => ({ useSidebarMaterial: () => {} }));
vi.mock('@/hooks/useMacFullscreen', () => ({ useMacFullscreen: () => ({ isMac: true, isFullscreen: false }) }));
vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => true }));
vi.mock('@/features/feature-context', () => ({
  useFeatureSidebarUpper: () => <SettingsOwner />,
  useOwnsTopNavScrollableRows: () => true,
}));
vi.mock('@/features/cc-agent/sidebar/conversationSearchContext', () => ({
  ConversationSearchProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/sidebar/SidebarTopNav', () => ({ SidebarTopNav: () => null }));
vi.mock('@/components/sidebar/TaskListModeToggle', () => ({ TaskListModeToggle: () => null }));
vi.mock('@/components/sidebar/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('@/components/sidebar/DatabaseSizeWarningBanner', () => ({ DatabaseSizeWarningBanner: () => null }));
vi.mock('@/components/sidebar/NativeBuildBanner', () => ({ NativeBuildBanner: () => null }));
vi.mock('@/components/sidebar/UserInfoSection', () => ({ UserInfoSection: () => null }));
vi.mock('@/cindy-brain/PluginUiContributions', () => ({ PluginUiSidebarSections: () => null }));

const project = { projectKey: 'local:/project' } as ProjectNode;
function SettingsOwner() {
  const settings = useProjectSettings();
  return <div data-testid="feature-owner">
    <button onClick={() => {
      setProjectSettings(project);
      setHeaderProjectMenu(null);
    }}>Open settings</button>
    {settings && <div role="dialog">
      <button onClick={() => setProjectSettings(null)}>Close settings</button>
    </div>}
  </div>;
}
afterEach(() => {
  cleanup();
  setHeaderProjectMenu(null);
  setProjectSettings(null);
});
it('keeps the hidden secondary-window owner through the menu-to-settings transition and releases it on close', () => {
  render(<Sidebar isCollapsed />);
  expect(screen.queryByTestId('feature-owner')).toBeNull();
  act(() => setHeaderProjectMenu({ project, anchor: document.createElement('button') }));
  fireEvent.click(screen.getByText('Open settings'));
  expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy();
  fireEvent.click(screen.getByText('Close settings'));
  expect(screen.queryByTestId('feature-owner')).toBeNull();
});
