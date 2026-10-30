/**
 * 设置页 Esc 的页面级接线（#5845）：PI 扩展子页先回到「通用」、帮助面板先关，
 * 再按一次才退出设置。各分区内容与本测试无关，统一替换为空壳。
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffPanelShell } from '@/components/diff-panel/DiffPanelShell';
import { SettingsView } from '../SettingsView';

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
// Permission confirmation is covered in NewChatDefaultPermissionSection.test.tsx;
// this page-level test isolates section contents and exercises only Escape routing.
vi.mock('../NewChatDefaultPermissionSection', () => ({ NewChatDefaultPermissionSection: Stub }));
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
