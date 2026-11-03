// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceInputSection } from '../../components/settings/VoiceInputSection';
import { toast } from '@/lib/toast';
import { getDefaultVoiceInputSettings, type VoiceInputSettings } from '../../../shared/voiceInputData';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/i18n', () => ({ SUPPORTED_LOCALES: ['en'] }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ mode: 'remote' }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../components/settings/VoiceSpeakerFilterCard', () => ({ VoiceSpeakerFilterCard: () => null }));
const serviceModel = vi.hoisted(() => ({ current: {
  ready: false, selection: null, asrProfiles: [],
} as Record<string, unknown> }));
// Keep the page and settings hook real; supply only the service-selection snapshot.
vi.mock('@/hooks/useVoiceInputModelSelection', () => ({
  useVoiceInputModelSelection: () => serviceModel.current,
}));

const defaults = getDefaultVoiceInputSettings('win32');
const restoreLabel = 'settings.defaults.restore';
let settings: VoiceInputSettings;
const updateSettings = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  serviceModel.current = { ready: false, selection: null, asrProfiles: [] };
  settings = {
    ...defaults,
    composerLongPressEnabled: !defaults.composerLongPressEnabled,
    composerLongPressEnabledOverride: !defaults.composerLongPressEnabled,
    dictionarySyncEnabled: !defaults.dictionarySyncEnabled,
    dictionarySyncEnabledOverride: !defaults.dictionarySyncEnabled,
  };
  const permissions = { microphone: { ok: true, status: 'granted' } };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    platform: 'win32',
    voiceInput: {
      getDataSnapshot: () => ({ settings }),
      updateSettings,
      setGlobalShortcut: vi.fn(async () => ({ ok: true })),
      onDataChanged: () => () => {},
      getHistory: () => [],
      getSystemPermissionsCached: () => permissions,
      getSystemPermissions: async () => permissions,
    },
  } });
});
afterEach(cleanup);

/**
 * Review #6347/r4303186814 and DESIGN ErrorNotice exclusions: field validation must remain
 * associated with the input on desktop as well as mobile. Invalid → valid → invalid catches
 * the desktop half missed by the earlier mobile-only fix, including stale accessibility links.
 * Extend the existing component harness; this is a unit interaction, not a voice-service E2E.
 */
it('keeps custom ASR URL validation inline and associated through repeated edits', async () => {
  serviceModel.current = {
    ready: true,
    asrProfiles: [],
    selection: {
      serviceMode: 'byok', asrProvider: 'custom-realtime-asr',
      customAsr: { protocol: 'openai-realtime', websocketUrl: 'wss://voice.example/realtime', model: 'test' },
    },
  };
  render(<MemoryRouter><VoiceInputSection /></MemoryRouter>);
  const input = screen.getByPlaceholderText('settings.voiceInput.serviceSource.customAsr.websocketUrl.placeholder');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('wss://voice.example/realtime'));
  const errorText = 'settings.voiceInput.serviceSource.customAsr.websocketUrl.invalid';
  for (const invalidUrl of ['https://voice.example', 'not a URL']) {
    fireEvent.change(input, { target: { value: invalidUrl } });
    const error = screen.getByRole('alert');
    expect(error.textContent).toBe(errorText);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)).toBe(error);
    fireEvent.change(input, { target: { value: 'wss://voice.example/realtime' } });
    expect(screen.queryByText(errorText)).toBeNull();
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  }
});

const cases = [
  { field: 'dictionarySyncEnabled', override: 'dictionarySyncEnabledOverride',
    label: 'settings.voiceInput.refinement.dictionary.deviceSync.ariaLabel' },
] as const;

/**
 * Test value: the real settings page must expose each override's restore action, send its null
 * patch through the real hook, and show the returned default with no customized badge/action.
 * configuration-and-overrides.md §4; the deleted source check and hook-only reset tests never
 * clicked this component, so removing its controls or disconnecting their props escaped coverage.
 * Minimal input: one explicit override opposite to its default (including false for dictionary sync).
 * Unit/jsdom: a separate file is needed because recordingGate is a node-only source guard; no
 * VoiceInputSection component harness exists to extend. The 2026-10-24 product decision hides
 * long-press dictation even with an explicit override; dictionary sync keeps its restore control.
 * Measured alone: 3.25s wall / 2.19s Vitest (1.11s collect, 550ms jsdom, 281ms tests).
 */
describe('VoiceInputSection restore defaults', () => {
  it.each(cases)('restores $field from its visible reset control', async ({ field, override, label }) => {
    const restored = { ...settings, [field]: defaults[field] };
    delete restored[override];
    updateSettings.mockImplementation(async () => { settings = restored; return settings; });
    render(<MemoryRouter><VoiceInputSection /></MemoryRouter>);

    const dictionaryHeading = screen.getByText('settings.voiceInput.refinement.dictionary.label');
    fireEvent.click(within(dictionaryHeading.parentElement!.parentElement!).getByRole('button', {
      name: 'settings.voiceInput.refinement.instructions.edit',
    }));

    const toggle = () => screen.getByRole('switch', { name: label });
    const row = () => within(toggle().parentElement!.parentElement!);
    expect(toggle().getAttribute('aria-checked')).toBe(String(!defaults[field]));
    expect(row().getByText('settings.defaults.customizedBadge')).toBeTruthy();
    fireEvent.click(row().getByRole('button', { name: restoreLabel }));

    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe(String(defaults[field])));
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ [field]: null });
    expect(row().queryByRole('button', { name: restoreLabel })).toBeNull();
    expect(row().queryByText('settings.defaults.customizedBadge')).toBeNull();
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('settings.defaults.restored');

    // Long-press dictation is now a hidden override, even when explicitly configured.
    expect(screen.queryByRole('switch', { name: 'settings.voiceInput.composerLongPress.ariaLabel' })).toBeNull();
    expect(settings.composerLongPressEnabledOverride).toBe(false);
  });
});
