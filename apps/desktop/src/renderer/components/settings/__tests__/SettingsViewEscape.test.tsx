/**
 * 设置页 Esc 的页面级接线（#5845）：PI 扩展子页先回到「通用」、帮助面板先关，
 * 再按一次才退出设置。各分区内容与本测试无关，统一替换为空壳。
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DiffPanelShell } from '@/components/diff-panel/DiffPanelShell';
import { SettingsView } from '../SettingsView';
import type { useVoiceInputModelSelection } from '@/hooks/useVoiceInputModelSelection';
import { setAgentIslandEnabled } from '@/hooks/useAgentIslandSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => ({
    'settings.voiceInput.serviceSource.customAsr.websocketUrl.label': 'WebSocket URL',
    'settings.voiceInput.refinement.instructions.label': 'Refinement instructions',
    'settings.agentIsland.skins.whitesnow.name': 'Apple Girl',
  }[key] ?? key) }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'local', dataOwnerId: null, user: null }),
}));
vi.mock('@/lib/useCindyVersions', () => ({
  useCindyVersions: () => ({ state: 'idle' }),
}));

const { Stub } = vi.hoisted(() => ({ Stub: () => null }));
vi.mock('../UserProfileCard', () => ({ UserProfileCard: Stub }));
vi.mock('../VoiceInputSection', () => ({
  VoiceInputSection: ({ modelSelection }: { modelSelection: ReturnType<typeof useVoiceInputModelSelection> }) => (
    <>
      <button onClick={() => void modelSelection.setAsrProvider('openai')}>Use preset ASR</button>
      <button onClick={() => void modelSelection.setAsrProvider('custom-realtime-asr')}>Use custom ASR</button>
    </>
  ),
}));
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
vi.mock('../ComputerUseSection', () => ({ ComputerUseSection: Stub }));
vi.mock('../CindyMakeSection', () => ({ CindyMakeSection: Stub }));
vi.mock('../SettingsCatalogPanel', () => ({ SettingsCatalogPanel: Stub }));
vi.mock('@/features/billing/BillingPage', () => ({ BillingSettingsSection: Stub }));
vi.mock('@/features/bots/BotsGlobalSettingsSection', () => ({ BotsGlobalSettingsSection: Stub }));
vi.mock('../usage/UsageHistorySection', () => ({ UsageHistorySection: Stub }));
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
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('electronAPI', { platform: 'darwin', osRelease: '23.0.0', appVersion: '1.0.0',
    agentIsland: { setEnabled: vi.fn(async () => ({ ok: true })) }, voiceInput: {
    getModelSelection: vi.fn(async () => ({ selection: { serviceMode: 'cindy', asrProvider: 'openai' } })),
    onDataChanged: () => () => {},
  } });
  // jsdom 没有元素滚动；设置页切分区时会把内容列滚回顶部。
  Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('SettingsView Escape', () => {
  // Unit regression (#8481): the real preference setter must update search before
  // opening Agent Island, without a native side effect just from searching.
  it('updates mascot search results when Agent Island is enabled and disabled', async () => {
    await act(async () => { renderSettings('/settings'); });
    fireEvent.change(screen.getByRole('combobox', { name: 'settings.search.ariaLabel' }), {
      target: { value: 'Apple Girl' },
    });
    const results = () => screen.queryAllByRole('option');
    expect(results()).toHaveLength(0);
    expect(window.electronAPI.agentIsland.setEnabled).not.toHaveBeenCalled();
    await act(async () => { expect(await setAgentIslandEnabled(true)).toBe(true); });
    expect(results()).toHaveLength(1);
    await act(async () => { expect(await setAgentIslandEnabled(false)).toBe(true); });
    expect(results()).toHaveLength(0);
  });

  // Unit regression (#8481): search must follow the same main-owned refinement
  // snapshot/broadcast as the voice controls, even before opening that page.
  it('updates refinement search results when the saved toggle changes', async () => {
    let refinementEnabled = false;
    let notifySettings!: () => void;
    Object.assign(window.electronAPI.voiceInput, {
      getDataSnapshot: () => ({ settings: { refinementEnabled } }),
      onDataChanged: (notify: () => void) => { notifySettings = notify; return () => {}; },
    });
    await act(async () => { renderSettings('/settings'); });
    fireEvent.change(screen.getByRole('combobox', { name: 'settings.search.ariaLabel' }), {
      target: { value: 'Refinement instructions' },
    });
    const result = () => screen.queryByRole('option', { name: /^Refinement instructions/ });
    expect(result()).toBeNull();
    act(() => { refinementEnabled = true; notifySettings(); });
    expect(result()).not.toBeNull();
    act(() => { refinementEnabled = false; notifySettings(); });
    expect(result()).toBeNull();
  });

  // Unit wiring regression (#8481): search must load voice selection before the
  // voice page mounts and immediately follow edits from that same page instance.
  // Keep the real selection hook/search/router; only IPC and section controls are fixtures.
  it('updates custom ASR search results after loading and changing the voice selection', async () => {
    let resolveSelection!: (value: unknown) => void;
    const getSelection = vi.fn(() => new Promise((resolve) => { resolveSelection = resolve; }));
    const setSelection = vi.fn(async ({ asrProvider }: { asrProvider: string }) => ({
      selection: { serviceMode: 'cindy', asrProvider },
    }));
    Object.assign(window.electronAPI.voiceInput, { getModelSelection: getSelection, setModelSelection: setSelection });
    renderSettings('/settings');
    const search = screen.getByRole('combobox', { name: 'settings.search.ariaLabel' });
    const query = 'WebSocket URL';
    const result = () => screen.queryByRole('option', { name: /^WebSocket URL/ });
    fireEvent.change(search, { target: { value: query } });
    expect(result()).toBeNull();
    await act(async () => resolveSelection({ selection: { serviceMode: 'cindy', asrProvider: 'custom-realtime-asr' } }));
    expect(result()).not.toBeNull();
    fireEvent.click(result()!);
    expect(location()).toContain('tab=voice-input');
    expect(location()).toContain('section=voiceInput.customAsrWebsocketUrl');
    fireEvent.change(search, { target: { value: query } });
    fireEvent.click(screen.getByRole('button', { name: 'Use preset ASR' }));
    await waitFor(() => expect(result()).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Use custom ASR' }));
    await waitFor(() => expect(result()).not.toBeNull());
    expect(getSelection).toHaveBeenCalledTimes(1);
    expect(setSelection).toHaveBeenCalledTimes(2);
  });

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
