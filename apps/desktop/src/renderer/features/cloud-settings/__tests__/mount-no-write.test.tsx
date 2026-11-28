// @vitest-environment jsdom
// Remounting the cloud settings page must not turn memory.maker or
// subagentModel.codexSmartSubagentRouting into explicit overrides equal to their defaults.
// Opening the page, every category and a remount must never write. Unlike panel.test, the
// model sections here are the real ones (only the target's model catalog read is a fixture).
// Unit tier; ~2 s.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSettingsPanel } from '../CloudSettingsView';
import { createTrialCloudSettingsClient } from '../trialClient';
import {
  CLOUD_SETTINGS_ALL_SECTIONS,
  CLOUD_SETTINGS_VISIBILITY,
  type CloudSettingsVisibility,
} from '../cloudSettingsVisibility';
import { TAB_LABEL_KEY } from '@/lib/tabLabels';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue === '' ? `text ${key}` : key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn(() => ({ mode: 'cloud' })) }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', async (original) => ({
  ...(await original<typeof import('@/features/device-link/useDeviceLinkDeviceList')>()),
  useDeviceLinkDeviceList: vi.fn(() => []),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));
// The target's model catalog is read over DeviceLink; the pickers get an empty one.
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: [], loading: false, error: null, unsupported: false }),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(cleanup);

async function openEveryCategory(
  client: ReturnType<typeof createTrialCloudSettingsClient>,
  visibility: CloudSettingsVisibility,
) {
  render(
    <CloudSettingsPanel
      name="Cloud trial"
      client={client}
      online
      trial
      onBack={vi.fn()}
      visibility={visibility}
    />,
  );
  for (const tab of visibility.tabs) {
    fireEvent.click(await screen.findByRole('tab', { name: TAB_LABEL_KEY[tab] }));
    await waitFor(() => expect(screen.queryByText('cloudSettings.loading')).toBeNull());
    // Let mount effects and any follow-up reads settle.
    await act(async () => {});
  }
}

describe('opening cloud settings', () => {
  it.each([
    ['every supported category', CLOUD_SETTINGS_ALL_SECTIONS],
    ['the released page', CLOUD_SETTINGS_VISIBILITY],
  ] as const)('writes nothing when %s is opened, and nothing after a remount', async (_name, visibility) => {
    // Channels the page reads over DeviceLink answer "not offered"; nothing local is reached.
    const invoke = vi.fn(async () => {
      throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] not offered');
    });
    // Subscriptions return an unsubscribe; any other host call is refused, so nothing is written.
    const deviceLink = new Proxy(
      { invoke },
      {
        get: (target, key) =>
          key in target
            ? target[key as keyof typeof target]
            : String(key).startsWith('on')
              ? () => () => undefined
              : async () => {
                  throw new Error('UNAVAILABLE');
                },
      },
    );
    Object.assign(window, { electronAPI: { deviceLink } });
    const client = createTrialCloudSettingsClient();
    const save = vi.spyOn(client, 'save');
    await openEveryCategory(client, visibility);
    // Personalization holds memory and the subagent and model sections.
    fireEvent.click(screen.getByRole('tab', { name: TAB_LABEL_KEY.personalization }));
    await screen.findByText('settings.memory.title');
    await act(async () => {});
    expect(save).not.toHaveBeenCalled();
    cleanup();
    await openEveryCategory(client, visibility);
    expect(save).not.toHaveBeenCalled();
    // Renders every category twice: about 3 s alone, more beside other files.
  }, 15_000);
});
