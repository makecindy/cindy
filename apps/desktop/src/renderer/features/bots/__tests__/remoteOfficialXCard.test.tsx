// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteOfficialXCard } from '../RemoteOfficialXCard';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

afterEach(cleanup);

const bot = { id: 'bot-1', name: 'Mia' };
const render_ = (summary: Record<string, unknown>) => {
  const api = { get: vi.fn(async () => ({ enabled: false, connected: false, companionBotId: null, ...summary })), setCompanion: vi.fn() };
  render(<RemoteOfficialXCard bot={bot} api={api as never} deviceName="Desk" />);
  return api;
};

it('lists the X account when the other computer lists it, even before it is usable there', async () => {
  const api = render_({ available: false, visible: true });
  expect(await screen.findByLabelText('settings.tina.prefs.providerX')).toBeTruthy();
  expect(screen.getByText('bots.remoteSettings.finishOnHost')).toBeTruthy();
  expect(api.get).toHaveBeenCalledOnce();
});

it('shows a usable account from a computer that does not say whether it lists it, and nothing otherwise', async () => {
  render_({ available: true });
  expect(await screen.findByLabelText('settings.tina.prefs.providerX')).toBeTruthy();
  cleanup();
  const api = render_({ available: false });
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByLabelText('settings.tina.prefs.providerX')).toBeNull());
});
