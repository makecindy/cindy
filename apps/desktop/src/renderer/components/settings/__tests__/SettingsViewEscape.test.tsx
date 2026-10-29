/**
 * 设置页 Esc 的页面级接线（#5845）：PI 扩展子页先回到「通用」、帮助面板先关，
 * 再按一次才退出设置。各分区内容与本测试无关，统一替换为空壳。
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffPanelShell } from '@/components/diff-panel/DiffPanelShell';
import { SettingsView } from '../SettingsView';
import { MainViewHistoryProvider } from '@/contexts/MainViewHistoryContext';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { toast } from '@/lib/toast';

vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: (id: string) => id === 'remote-task' ? 'remembered-device' : undefined,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/features/bots/useRemoteBots', () => ({
  useRemoteBots: () => [
    { id: 'bot-a', deviceId: 'other-device', sessionId: 'wrong-chat', online: true },
    { id: 'bot-a', deviceId: 'remote-a', sessionId: 'remote-chat', online: true },
    { id: 'bot-a', deviceId: 'offline-device', sessionId: 'cached-chat', online: false },
  ],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'local', dataOwnerId: null, user: null }),
}));
vi.mock('@/lib/useCindyVersions', () => ({
  useCindyVersions: () => ({ state: 'idle' }),
}));

const { Stub } = vi.hoisted(() => ({ Stub: () => null }));
vi.mock('../UserProfileCard', () => ({ UserProfileCard: Stub }));
vi.mock('../VoiceInputSection', () => ({ VoiceInputSection: Stub }));
vi.mock('../AppearanceSection', () => ({ AppearanceSection: Stub }));
vi.mock('../SubagentModelSection', () => ({ SubagentModelSection: Stub }));
vi.mock('../AuxiliaryModelSection', () => ({ AuxiliaryModelSection: Stub }));
vi.mock('../VisionBridgeSection', () => ({ VisionBridgeSection: Stub }));
vi.mock('../ProvidersSection', () => ({ ProvidersSection: Stub }));
vi.mock('../McpServersSection', () => ({ McpServersSection: Stub }));
vi.mock('../RemoteControlSection', () => ({ RemoteControlSection: Stub }));
vi.mock('@/features/device-link/SharedTaskDialog', () => ({ SharedTaskDialog: Stub }));
vi.mock('../NotificationSection', () => ({ NotificationSection: Stub }));
vi.mock('../WindowBehaviorSection', () => ({ WindowBehaviorSection: Stub }));
vi.mock('../ComposerSendShortcutSection', () => ({ ComposerSendShortcutSection: Stub }));
vi.mock('../KeyboardShortcutsSection', () => ({ KeyboardShortcutsSection: Stub }));
vi.mock('../AgentIslandSection', () => ({ AgentIslandSection: Stub }));
vi.mock('../LanguageSection', () => ({ LanguageSection: Stub }));
vi.mock('../LogoutSection', () => ({ LogoutSection: Stub }));
vi.mock('../AboutSection', () => ({ AboutSection: Stub }));
vi.mock('../WorktreeRecycleCard', () => ({ WorktreeRecycleCard: Stub }));
vi.mock('../StorageManagementCard', () => ({ StorageManagementCard: Stub }));
vi.mock('../UserPromptSection', () => ({ UserPromptSection: Stub }));
vi.mock('../MemorySection', () => ({ MemorySection: Stub }));
vi.mock('../CompactionSection', () => ({ CompactionSection: Stub }));
vi.mock('../TerminalShellSection', () => ({ TerminalShellSection: Stub }));
vi.mock('../LinkOpenSection', () => ({ LinkOpenSection: Stub }));
vi.mock('../StreamFadeSection', () => ({ StreamFadeSection: Stub }));
vi.mock('../TipsSection', () => ({ TipsSection: Stub }));
vi.mock('../ExperimentalSection', () => ({ ExperimentalSection: Stub }));
vi.mock('../GitSafetySection', () => ({ GitSafetySection: Stub }));
vi.mock('../SessionImportSection', () => ({ SessionImportSection: Stub }));
vi.mock('../AgentResourceSection', () => ({ AgentResourceSection: Stub }));
vi.mock('../CollaborationSection', () => ({ CollaborationSection: Stub }));
vi.mock('../BuiltinToolsSection', () => ({ BuiltinToolsSection: Stub }));
vi.mock('../contacts/ContactsSection', () => ({ ContactsSection: Stub }));
vi.mock('../ComputerUseSection', () => ({ ComputerUseSection: Stub }));
vi.mock('../CindyMakeSection', () => ({ CindyMakeSection: Stub }));
vi.mock('../SettingsCatalogPanel', () => ({ SettingsCatalogPanel: Stub }));
vi.mock('@/features/billing/BillingPage', () => ({ BillingSettingsSection: Stub }));
vi.mock('@/features/bots/BotsGlobalSettingsSection', () => ({ BotsGlobalSettingsSection: Stub }));
vi.mock('../usage/UsageHistorySection', () => ({ UsageHistorySection: Stub }));
vi.mock('../SettingsSidebarNav', () => ({ SettingsSidebarNav: Stub }));
vi.mock('../ImBotSection', () => ({
  ImBotSection: Stub,
  isImBotSettingsGroup: (value: unknown) => value === 'cindy' || value === 'personal',
}));
vi.mock('../PiPackagesSection', () => ({
  PiPackagesSection: () => <p>PI packages</p>,
}));
vi.mock('../HelpSection', () => ({
  HelpSection: ({ onAskHelp }: { onAskHelp: () => void }) => (
    <button type="button" onClick={onAskHelp}>
      Ask help
    </button>
  ),
}));
// 帮助面板保留真实的 DiffPanelShell：它自己在 window 上处理 Esc，正是要验证的另一位 owner。
vi.mock('../HelpAssistantPanel', () => ({
  HelpAssistantPanel: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <DiffPanelShell open={open} onClose={onClose} ariaLabel="Help assistant" title="Help">
      <p>Help thread</p>
    </DiffPanelShell>
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderSettings(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/settings" element={<SettingsView />} />
        <Route path="/" element={<p>Home</p>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function pressEscape() {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
}

const location = () => screen.getByTestId('location').textContent;

beforeEach(() => {
  vi.stubGlobal('electronAPI', { platform: 'darwin', appVersion: '1.0.0' });
  // jsdom 没有元素滚动；设置页切分区时会把内容列滚回顶部。
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsView Escape', () => {
  it('returns from the Pi extensions page to General before leaving Settings', () => {
    renderSettings('/settings?openPanel=pi-extensions');
    expect(screen.getByText('PI packages')).toBeTruthy();

    pressEscape();
    expect(location()).toBe('/settings');
    expect(screen.queryByText('PI packages')).toBeNull();

    pressEscape();
    expect(location()).toBe('/');
    expect(screen.getByText('Home')).toBeTruthy();
  });

  it('closes the Help panel before leaving Settings', () => {
    renderSettings('/settings?tab=help');
    fireEvent.click(screen.getByRole('button', { name: 'Ask help' }));
    expect(
      screen.getByRole('complementary', { name: 'Help assistant' }).getAttribute('aria-hidden'),
    ).not.toBe('true');

    pressEscape();
    expect(location()).toBe('/settings?tab=help');

    pressEscape();
    expect(location()).toBe('/');
  });
});

// Regression: opening Settings used to leave no way to consult the originating
// chat without abandoning the form. Exercise real navigation history + SettingsView;
// only the native-window boundary is faked. Existing Escape cases did not cover it.
// Minimal input: task -> settings -> open chat. Tier: unit (no Electron required).
function ReferenceLayout() {
  useActiveMainView();
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate('/settings?tab=help')}>Configure</button>
    <Outlet />
    <LocationProbe />
  </>;
}

function renderReference(entry: string, owner = 'account-a') {
  const tree = (ownerKey: string) => (
    <MainViewHistoryProvider ownerKey={ownerKey}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route element={<ReferenceLayout />}>
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<p>Conversation</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </MainViewHistoryProvider>
  );
  const result = render(tree(owner));
  if (!entry.startsWith('/settings')) fireEvent.click(screen.getByText('Configure'));
  return { changeOwner: () => result.rerender(tree('account-b')) };
}

describe('SettingsView conversation reference', () => {
  const label = 'settings.conversation.open';

  it.each([
    ['/cc-agent/task-a', 'task-a', undefined],
    ['/cc-agent/task-a?device=remote-a', 'task-a', 'remote-a'],
    ['/cc-agent/remote-task', 'remote-task', 'remembered-device'],
    ['/bots/bot-a/session/chat-a', 'chat-a', undefined],
    // PR #7274: normal sidebar routes omit the session; match both bot and device.
    ['/bots/remote/remote-a/bot-a', 'remote-chat', 'remote-a'],
    ['/bots/remote/remote-a/bot-a/session/chat-a', 'chat-a', 'remote-a'],
  ])('opens the originating conversation and keeps the settings route: %s', async (entry, sessionId, deviceId) => {
    const open = vi.fn().mockResolvedValue(undefined);
    window.electronAPI.maker = { openSessionInNewWindow: open } as unknown as typeof window.electronAPI.maker;
    renderReference(entry!);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(sessionId, deviceId));
    expect(location()).toBe('/settings?tab=help');
    expect(screen.getByRole('button', { name: 'Ask help' })).toBeTruthy();
  });

  it.each(['/settings', '/cc-agent/new', '/cc-agent/scheduled', '/bots/roster', '/bots/remote/unknown-device/bot-a'])('does not offer a non-conversation target: %s', (entry) => {
    window.electronAPI.maker = { openSessionInNewWindow: vi.fn() } as unknown as typeof window.electronAPI.maker;
    renderReference(entry);
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  });

  it('clears the reference when the account changes', () => {
    window.electronAPI.maker = { openSessionInNewWindow: vi.fn() } as unknown as typeof window.electronAPI.maker;
    const app = renderReference('/cc-agent/private-task');
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
    app.changeOwner();
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  });

  // PR #7274 review: an offline cloud chat retains a cached session ID, but a
  // new device-link session window cannot display that cloud conversation.
  it('does not offer an offline cached companion session as a window target', () => {
    const open = vi.fn();
    window.electronAPI.maker = { openSessionInNewWindow: open } as unknown as typeof window.electronAPI.maker;
    renderReference('/bots/remote/offline-device/bot-a');
    expect(screen.queryByRole('button', { name: label })).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(location()).toBe('/settings?tab=help');
  });

  it('prevents duplicate opens and allows retry after failure without leaving settings', async () => {
    let rejectOpen!: (reason: Error) => void;
    const open = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOpen = reject; }))
      .mockResolvedValue(undefined);
    window.electronAPI.maker = { openSessionInNewWindow: open } as unknown as typeof window.electronAPI.maker;
    renderReference('/cc-agent/task-a');
    const button = screen.getByRole('button', { name: label });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => rejectOpen(new Error('window unavailable')));
    expect(toast.error).toHaveBeenCalledWith('settings.conversation.openFailed');
    expect(location()).toBe('/settings?tab=help');
    fireEvent.click(button);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
});
