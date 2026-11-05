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
import type { VoiceSpeakerFilterStatus } from '../../../../shared/voiceSpeakerFilter';
import { getAgentIslandSoundSettings, setAgentIslandEnabled, setAgentIslandSoundSettings } from '@/hooks/useAgentIslandSettings';
import { LocaleProvider, useLocale } from '@/hooks/useLocale';
import { WallpaperSettingsProvider } from '@/hooks/useWallpaperSettings';
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from '../../../../shared/appearanceSettings';
import { getDefaultVoiceInputSettings } from '../../../../shared/voiceInputData';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => ({
    'settings.voiceInput.serviceSource.customAsr.websocketUrl.label': 'WebSocket URL',
    'settings.voiceInput.refinement.instructions.label': 'Refinement instructions',
    'settings.voiceInput.speakerFilter.hint': 'Recognize only your voice',
    'settings.voiceInput.speakerFilter.unsupported': 'Speaker filter unavailable',
    'settings.voiceInput.speakerFilter.strictness.label': 'Voice match strictness',
    'settings.agentIsland.skins.whitesnow.name': 'Apple Girl',
    'settings.agentIsland.soundOptions.startup-chime': 'Startup chime',
    'settings.language.classical.label': 'Classical script and style',
    'settings.appearance.wallpaper.motionDynamic': 'Dynamic wallpaper',
  }[key] ?? key) }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'local', dataOwnerId: null, user: null }),
}));
vi.mock('@/lib/useCindyVersions', () => ({
  useCindyVersions: () => ({ state: 'idle' }),
}));

const { Stub, voicePage } = vi.hoisted(() => ({ Stub: () => null, voicePage: { real: false } }));
vi.mock('../VoiceSpeakerFilterCard', () => ({ VoiceSpeakerFilterCard: Stub }));
vi.mock('@/cindy-brain/PluginUiControls', () => ({ PluginUiContributionControls: Stub }));
vi.mock('../UserProfileCard', () => ({ UserProfileCard: Stub }));
vi.mock('../VoiceInputSection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../VoiceInputSection')>();
  return {
    VoiceInputSection: ({ modelSelection }: { modelSelection: ReturnType<typeof useVoiceInputModelSelection> }) => (
      voicePage.real ? <actual.VoiceInputSection modelSelection={modelSelection} /> : (
        <>
          <button onClick={() => void modelSelection.setAsrProvider('openai')}>Use preset ASR</button>
          <button onClick={() => void modelSelection.setAsrProvider('custom-realtime-asr')}>Use custom ASR</button>
        </>
      )
    ),
  };
});
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
    <LocaleProvider>
      <WallpaperSettingsProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/settings" element={<SettingsView />} />
            <Route path="/" element={<p>Home</p>} />
          </Routes>
          <LocationProbe />
          <LocaleControls />
        </MemoryRouter>
      </WallpaperSettingsProvider>
    </LocaleProvider>,
  );
}

function LocaleControls() {
  const { setLocale } = useLocale();
  return (
    <>
      <button onClick={() => setLocale('zh-Hans-x-lzh')}>Use classical locale</button>
      <button onClick={() => setLocale('en')}>Use English locale</button>
    </>
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
  voicePage.real = false;
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('electronAPI', { platform: 'darwin', osRelease: '23.0.0', appVersion: '1.0.0',
    agentIsland: { setEnabled: vi.fn(async () => ({ ok: true })), setSoundSettings: vi.fn(async () => ({ ok: true })) }, voiceInput: {
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
  // PR #8481/r4476577125, unit: earlier tests covered only initial loading and
  // setters. Keep SettingsView, the selection hook and voice page real; change
  // the IPC snapshot while away and verify both stale notices disappear on return.
  it('refreshes voice credentials and refinement after returning from their settings tabs', async () => {
    voicePage.real = true;
    const snapshot = {
      selection: { serviceMode: 'byok', asrProvider: 'openai',
        refinerProviderChainSource: 'configured', refinerProviderChain: [] as string[] },
      asrProfiles: [], refinerProfiles: [],
      readiness: { ok: false, provider: 'openai', auth: 'api-key' },
    };
    const permissions = { microphone: { ok: true, status: 'granted' } };
    Object.assign(window.electronAPI.voiceInput, {
      getModelSelection: vi.fn(async () => structuredClone(snapshot)),
      getDataSnapshot: () => ({ settings: getDefaultVoiceInputSettings('darwin') }),
      getHistory: () => [],
      setGlobalShortcut: vi.fn(async () => ({ ok: true })),
      getSystemPermissionsCached: () => permissions,
      getSystemPermissions: async () => permissions,
    });
    await act(async () => { renderSettings('/settings?tab=voice-input'); });
    const missingCredential = 'settings.voiceInput.serviceSource.credentialError.gatewayMissing';
    const cannotRefine = 'settings.voiceInput.serviceSource.refiner.cannotRefine';
    expect(screen.getByText(missingCredential)).toBeTruthy();
    expect(screen.getByText(cannotRefine)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'settings.voiceInput.serviceSource.manageProviders' }));
    expect(location()).toContain('tab=providers');
    snapshot.readiness.ok = true;
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.voiceInput' }));
    await waitFor(() => expect(screen.queryByText(missingCredential)).toBeNull());
    expect(screen.getByText(cannotRefine)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'settings.voiceInput.serviceSource.refiner.openAuxiliary' }));
    expect(location()).toContain('tab=personalization');
    snapshot.selection.refinerProviderChain = ['configured-refiner'];
    fireEvent.click(screen.getByRole('tab', { name: 'settings.tabs.voiceInput' }));
    await waitFor(() => expect(screen.queryByText(cannotRefine)).toBeNull());
    expect(screen.getByText('settings.voiceInput.serviceSource.refiner.followHint')).toBeTruthy();
    expect(screen.queryByText(missingCredential)).toBeNull();
  });
  // Unit wiring regression (#8481): static context tests cannot prove status
  // pushes update search before the voice page is mounted.
  it('updates speaker-filter search after capability and enrollment status pushes', async () => {
    let publish!: (status: VoiceSpeakerFilterStatus) => void;
    const status: VoiceSpeakerFilterStatus = {
      supported: false, enrolled: false, modelState: 'missing', downloadedBytes: 0, totalBytes: 0,
    };
    Object.assign(window.electronAPI.voiceInput, { speakerFilter: {
      getStatus: vi.fn(async () => status),
      onStatusChanged: (notify: typeof publish) => { publish = notify; return () => {}; },
    } });
    await act(async () => { renderSettings('/settings'); });
    for (const [supported, enrolled] of [[false, false], [true, false], [true, true], [true, false]] as const) {
      act(() => publish({ ...status, supported, enrolled }));
      for (const [query, visible] of [
        ['Recognize only your voice', supported],
        ['Speaker filter unavailable', !supported],
        ['Voice match strictness', supported && enrolled],
      ] as const) {
        fireEvent.change(screen.getByRole('combobox', { name: 'settings.search.ariaLabel' }), {
          target: { value: query },
        });
        expect(screen.queryAllByRole('option'), query).toHaveLength(visible ? 1 : 0);
      }
    }
  });
  // Unit wiring regression (#8481): generic island visibility coverage misses
  // sound-only toggles. Use the real preference setter to verify live search.
  it('updates sound search results when the sound rows are enabled and disabled', async () => {
    await act(async () => { expect(await setAgentIslandEnabled(true)).toBe(true); });
    await act(async () => { renderSettings('/settings'); });
    fireEvent.change(screen.getByRole('combobox', { name: 'settings.search.ariaLabel' }), {
      target: { value: 'Startup chime' },
    });
    for (const enabled of [false, true, false]) {
      await act(async () => {
        expect(await setAgentIslandSoundSettings({ ...getAgentIslandSoundSettings(), enabled })).toBe(true);
      });
      expect(screen.queryAllByRole('option')).toHaveLength(enabled ? 1 : 0);
    }
  });
  // Unit wiring regression (#8481): real provider broadcasts must update search
  // before Appearance is mounted, including transitions between custom media types.
  it('updates wallpaper motion search as the selected wallpaper changes', async () => {
    let publish!: (settings: AppearanceSettings) => void;
    Object.assign(window.electronAPI, { appearanceSettings: {
      getSync: () => ({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperVisibility: 0 }),
      onChanged: (notify: typeof publish) => { publish = notify; return () => {}; },
    } });
    await act(async () => { renderSettings('/settings'); });
    fireEvent.change(screen.getByRole('combobox', { name: 'settings.search.ariaLabel' }), {
      target: { value: 'Dynamic wallpaper' },
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    for (const [wallpaperId, customWallpaperUrl, visible] of [
      ['cindy-window', '', true],
      ['night-launch', '', false],
      ['custom', `cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`, true],
      ['custom', `cindy-media://client-wallpaper/${'b'.repeat(64)}.webp`, false],
      ['none', `cindy-media://client-wallpaper/${'a'.repeat(64)}.mp4`, false],
    ] as const) {
      act(() => publish({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperVisibility: 0, wallpaperId, customWallpaperUrl }));
      expect(screen.queryAllByRole('option')).toHaveLength(visible ? 1 : 0);
    }
  });
  // Unit wiring regression (#8481): use the real locale provider/setter so search
  // follows the same live preference as LanguageSection without remounting settings.
  it('updates classical search results after changing the display language', async () => {
    await act(async () => { renderSettings('/settings'); });
    fireEvent.change(screen.getByRole('combobox', { name: 'settings.search.ariaLabel' }), {
      target: { value: 'Classical script and style' },
    });
    const result = () => screen.queryByRole('option', { name: /^Classical script and style/ });
    expect(result()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use classical locale' }));
    expect(result()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use English locale' }));
    expect(result()).toBeNull();
  });
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
    // PR #8481/r4476725738: return-to-tab GET finishes after the user's SET.
    // Its old custom-ASR snapshot must not restore the hidden search result.
    await act(async () => resolveSelection({ selection: { serviceMode: 'cindy', asrProvider: 'custom-realtime-asr' } }));
    expect(result()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use custom ASR' }));
    await waitFor(() => expect(result()).not.toBeNull());
    // One initial read plus one on entry; edits still share the same hook.
    expect(getSelection).toHaveBeenCalledTimes(2);
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
