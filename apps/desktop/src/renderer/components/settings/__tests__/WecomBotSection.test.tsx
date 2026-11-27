// @vitest-environment jsdom
// Unit: the native WeCom card through its production entry. ImBotSection.test mocks this card
// away, so collapse/expand of its body is covered only here.
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { WecomBotSection } from '../WecomBotSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../ImDefaultSettingsSection', () => ({ ImDefaultSettingsSection: () => null }));
vi.mock('../ImChannelSettingsCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ImChannelSettingsCard')>()),
  useImChannelSettingsSummary: () => [null, vi.fn()],
}));
vi.mock('@/hooks/useWecomBot', () => ({
  useWecomBot: () => ({
    botId: '', setBotId: vi.fn(), secret: '', setSecret: vi.fn(), ownerUserId: null,
    status: { kind: 'idle' }, validationError: null, isSaving: false, isDisconnecting: false,
    canConnect: false, canReconnect: false, connect: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn(),
  }),
}));

it('keeps the unsaved group webhook URL and the read state across collapse and expand', () => {
  const getState = vi.fn(async () => ({ configured: false, enabled: false }));
  vi.stubGlobal('electronAPI', { wecomGroupNotification: { getState } });
  const card = (expanded: boolean) => <WecomBotSection expanded={expanded} onToggle={vi.fn()} />;
  const view = render(card(true));
  const field = () => screen.queryByLabelText('settings.notifications.wecomGroupLabel') as HTMLInputElement | null;
  fireEvent.change(field()!, { target: { value: 'https://example.invalid/hook' } });

  view.rerender(card(false));
  expect(field()).toBeNull();
  view.rerender(card(true));

  expect(field()!.value).toBe('https://example.invalid/hook');
  expect(getState).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});
