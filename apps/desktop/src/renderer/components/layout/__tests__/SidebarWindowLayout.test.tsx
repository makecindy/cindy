// @vitest-environment jsdom
// PR #9496: real detached layout covered global pages whenever no task existed.
// No prior root-layout test exercised that overlay; lower routing tests cannot.
// Native window APIs and the heavy Shell are boundaries. Exercise the existing
// Shell selection callback and native visibility event; tier: unit.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  selection: undefined as ((id: string | null) => void) | undefined,
  visibility: undefined as ((value: { visible: boolean }) => void) | undefined,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/right-sidebar/RightSidebarShell', () => ({ RightSidebarShell: (props: { onActiveTabChange?: typeof h.selection }) => {
  h.selection = props.onActiveTabChange; return <div>Plugin page</div>;
} }));
vi.mock('@/features/right-sidebar/globalTabs', () => ({ getGlobalTabs: () => [
  { id: 'legacy-panel', kind: 'plugin-view', state: { instanceId: 'legacy', view: 'panel' } },
  { id: 'legacy-main', kind: 'plugin-view', state: { instanceId: 'legacy', view: 'main' } },
  { id: 'g_plugin_view_board', kind: 'plugin-view', state: { instanceId: 'board', resourceViewId: 'board' } },
] }));
vi.mock('@/features/device-link/useDeviceLinkRemoteProjects', () => ({ useDeviceLinkRemoteProjects() {} }));
vi.mock('@/cindy-brain/ghostPanels', () => ({ ensureGhostPanelsRegistered() {}, useGhostPanelsSync() {} }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { initGlobalListeners() {} } }));
vi.mock('@/hooks/useAppShortcut', () => ({ useAppShortcut() {} }));
vi.mock('@/hooks/useCloseWindowShortcut', () => ({ useCloseShortcutShellOwner() {} }));
vi.mock('@/hooks/useLocale', () => ({ useLocale: () => ({ effectiveLocale: 'en', setLocale() {} }) }));
vi.mock('@/components/ui/toast', () => ({ ToastContainer: () => null }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/cindy-brain/GhostMediaLightboxHost', () => ({ GhostMediaLightboxHost: () => null }));
vi.mock('@/features/right-sidebar/lib/executeSidebarCommand', () => ({ executeSidebarCommand: vi.fn() }));
import { SidebarWindowLayout } from '../SidebarWindowLayout';

afterEach(cleanup);
it('shows a global page without a task and retains the hidden-window placeholder', async () => {
  const subscribe = () => () => {};
  window.electronAPI = { platform: 'darwin', rightSidebarWindow: {
    getContext: async () => null, onContextChanged: subscribe, onTabHandoff: subscribe,
    rendererReady: async () => {}, presentationReady: async () => {}, onCommand: subscribe,
    onVisibilityChanged: (listener: typeof h.visibility) => { h.visibility = listener; return () => {}; },
  } } as unknown as Window['electronAPI'];
  render(<SidebarWindowLayout />);
  await act(async () => { h.visibility?.({ visible: true }); });
  expect(screen.queryByText('rightSidebar.window.followPlaceholder')).not.toBeNull();
  // #9496 must not exempt legacy main/panel pages from the original no-task overlay.
  for (const id of ['legacy-main', 'legacy-panel']) {
    await act(async () => { h.selection?.(id); });
    expect(screen.queryByText('rightSidebar.window.followPlaceholder')).not.toBeNull();
  }
  await act(async () => { h.selection?.('g_plugin_view_board'); });
  expect(screen.queryByText('rightSidebar.window.followPlaceholder')).toBeNull();
  await act(async () => { h.visibility?.({ visible: false }); });
  expect(screen.queryByText('rightSidebar.window.followPlaceholder')).not.toBeNull();
  await act(async () => { h.visibility?.({ visible: true }); });
  expect(screen.queryByText('rightSidebar.window.followPlaceholder')).toBeNull();
  await act(async () => { h.selection?.(null); });
  expect(screen.queryByText('rightSidebar.window.followPlaceholder')).not.toBeNull();
});
