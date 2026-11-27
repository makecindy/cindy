// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supportsBetaUpdateChannel } from '../../../../shared/updateChannelCapability';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

  // The row follows main's `unattendedInstallSupported` through the real
  // settings hook: a system .deb needs a password and gets the explanation,
  // Cindy's user-directory install gets the same switch as macOS.
  // In-memory electronAPI fake; tier: unit.
  function withAutoUpdateSettings(platform: string, unattendedInstallSupported?: boolean) {
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      platform,
      getAutoUpdateSettings: vi.fn(async () => ({
        autoRelaunchOnIdle: false,
        isCustomized: false,
        defaultAutoRelaunchOnIdle: false,
        ...(unattendedInstallSupported === undefined ? {} : { unattendedInstallSupported }),
      })),
    };
  }

  it('explains system .deb updates instead of showing the idle-install switch', async () => {
    withAutoUpdateSettings('linux', false);
    render(<AutoUpdateToggleRow />);

    expect(await screen.findByText('settings.about.linuxUpdateDescription')).toBeTruthy();
    expect(screen.getByText('settings.about.autoUpdateLabel')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it.each([
    { platform: 'linux', unattended: true },
    { platform: 'darwin', unattended: undefined },
  ])('shows the idle-install switch on $platform when main allows it', async ({ platform, unattended }) => {
    withAutoUpdateSettings(platform, unattended);
    render(<AutoUpdateToggleRow />);

    expect(await screen.findByRole('switch', { name: 'settings.about.autoUpdateLabel' })).toBeTruthy();
    expect(screen.queryByText('settings.about.linuxUpdateDescription')).toBeNull();
  });

  // Exercise the shared capability consumed by preload and the real settings
  // section: ARM64 used to hide this row. In-memory renderer mocks; tier: unit.
  it.each(['x64', 'arm64'])('shows the beta channel card on Linux %s', (arch) => {
    window.electronAPI.supportsBetaUpdateChannel = supportsBetaUpdateChannel('linux', arch);
    render(<ExperimentalSection />);

    expect(screen.getByText('lsp-beta-cell')).toBeTruthy();
    expect(screen.getByText('beta-channel-cell')).toBeTruthy();
  });

  it('hides the beta channel card on unsupported Linux architectures', () => {
    (
      window as unknown as {
        electronAPI: { platform: string; supportsBetaUpdateChannel?: boolean };
      }
    ).electronAPI = {
      platform: 'linux',
      supportsBetaUpdateChannel: supportsBetaUpdateChannel('linux', 'ia32'),
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
