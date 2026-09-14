// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useAutoUpdateSettings', () => ({
  useAutoUpdateSettings: () => ({
    state: {
      autoRelaunchOnIdle: true,
      isCustomized: false,
      defaultAutoRelaunchOnIdle: true,
      loading: false,
    },
    setAutoRelaunchOnIdle: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock('@/hooks/useExperimentalFeatures', () => ({
  EXPERIMENTAL_FEATURES: [],
  useExperimentalFlag: () => ({ enabled: false, setEnabled: vi.fn() }),
}));

vi.mock('../LspBetaCell', () => ({
  LspBetaCell: () => <div>lsp-beta-cell</div>,
}));

vi.mock('../BetaChannelCell', () => ({
  BetaChannelCell: () => <div>beta-channel-cell</div>,
}));

import { AutoUpdateToggleRow } from '../AboutSection';
import { ExperimentalSection } from '../ExperimentalSection';
import { HelpSection } from '../HelpSection';

describe('Linux update settings', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    (
      window as unknown as {
        electronAPI: { platform: string; supportsBetaUpdateChannel?: boolean };
      }
    ).electronAPI = {
      platform: 'linux',
      supportsBetaUpdateChannel: true,
    };
  });

  it('explains in-app .deb updates instead of showing the idle-install switch', () => {
    render(<AutoUpdateToggleRow />);

    expect(screen.getByText('settings.about.autoUpdateLabel')).toBeTruthy();
    expect(screen.getByText('settings.about.linuxUpdateDescription')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('keeps the idle-install switch on macOS', () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: 'darwin',
    };
    render(<AutoUpdateToggleRow />);

    expect(screen.getByRole('switch', { name: 'settings.about.autoUpdateLabel' })).toBeTruthy();
    expect(screen.queryByText('settings.about.linuxUpdateDescription')).toBeNull();
  });

  it('shows the beta channel card on Linux x64', () => {
    render(<ExperimentalSection />);

    expect(screen.getByText('lsp-beta-cell')).toBeTruthy();
    expect(screen.getByText('beta-channel-cell')).toBeTruthy();
  });

  it('hides the beta channel card on Linux arm64', () => {
    (
      window as unknown as {
        electronAPI: { platform: string; supportsBetaUpdateChannel?: boolean };
      }
    ).electronAPI = {
      platform: 'linux',
      supportsBetaUpdateChannel: false,
    };
    render(<ExperimentalSection />);

    expect(screen.getByText('lsp-beta-cell')).toBeTruthy();
    expect(screen.queryByText('beta-channel-cell')).toBeNull();
  });

  it('keeps the beta channel card on Windows', () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: 'win32',
    };
    render(<ExperimentalSection />);

    expect(screen.getByText('beta-channel-cell')).toBeTruthy();
  });

  it('shows Linux install and update help on Linux', () => {
    render(<HelpSection onAskHelp={() => undefined} />);

    expect(screen.getByText('settings.help.linuxUpdates.title')).toBeTruthy();
    expect(screen.getByText('settings.help.linuxUpdates.item1')).toBeTruthy();
  });

  it('hides Linux install and update help on macOS', () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: 'darwin',
    };
    render(<HelpSection onAskHelp={() => undefined} />);

    expect(screen.queryByText('settings.help.linuxUpdates.title')).toBeNull();
  });
});
