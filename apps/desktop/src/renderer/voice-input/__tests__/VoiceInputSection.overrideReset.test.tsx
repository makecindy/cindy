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
// Service credentials are a separate card; keep the reset controls and settings hook real.
vi.mock('@/hooks/useVoiceInputModelSelection', () => ({
  useVoiceInputModelSelection: () => ({ ready: false, selection: null, asrProfiles: [] }),
}));

const defaults = getDefaultVoiceInputSettings('win32');
const restoreLabel = 'settings.defaults.restore';
let settings: VoiceInputSettings;
const updateSettings = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
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

const cases = [
  { field: 'composerLongPressEnabled', override: 'composerLongPressEnabledOverride',
    label: 'settings.voiceInput.composerLongPress.ariaLabel' },
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
 * VoiceInputSection component harness exists to extend. Both controls share this single fixture.
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

    const other = cases.find(candidate => candidate.field !== field)!;
    const otherToggle = screen.getByRole('switch', { name: other.label });
    expect(otherToggle.getAttribute('aria-checked')).toBe(String(!defaults[other.field]));
    expect(within(otherToggle.parentElement!.parentElement!).getByRole('button', { name: restoreLabel })).toBeTruthy();
  });
});
