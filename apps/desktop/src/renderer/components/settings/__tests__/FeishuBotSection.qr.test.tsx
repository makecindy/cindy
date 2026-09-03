// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const beginRegistration = vi.fn(async () => undefined);
const useFeishuBotRegistration = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useFeishuBot', () => ({
  useFeishuBot: () => ({
    service: 'feishu',
    setService: vi.fn(),
    appId: '',
    status: 'idle',
    errorMessage: null,
    hasSavedCreds: false,
    ownerOpenId: null,
    isClearing: false,
    isReconnecting: false,
    reconnect: vi.fn(),
    clear: vi.fn(),
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../ImChannelSettingsCard', () => ({
  ImChannelSettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useImChannelSettingsSummary: () => [null, vi.fn()],
}));
vi.mock('../ImDefaultSettingsSection', () => ({
  ImDefaultSettingsSection: () => null,
}));
vi.mock('../FeishuBotNotificationSection', () => ({
  FeishuBotNotificationSection: () => null,
}));
vi.mock('@/hooks/useFeishuBotRegistration', () => ({
  useFeishuBotRegistration: (...args: unknown[]) => useFeishuBotRegistration(...args),
}));

import { FeishuBotSection } from '../FeishuBotSection';

type FeishuBotRegistrationState = ReturnType<
  typeof import('@/hooks/useFeishuBotRegistration').useFeishuBotRegistration
>;

function mockRegistration(state: Partial<FeishuBotRegistrationState>) {
  useFeishuBotRegistration.mockReturnValue({
    phase: 'idle',
    verificationUrl: null,
    userCode: null,
    expiresAt: null,
    qrDataUrl: null,
    errorMessage: null,
    secondsLeft: null,
    beginRegistration,
    cancelRegistration: vi.fn(),
    ...state,
  });
}

describe('FeishuBotSection QR setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    beginRegistration.mockClear();
  });

  it('uses QR authorization instead of a manual key form', () => {
    mockRegistration({});
    render(<FeishuBotSection expanded onToggle={vi.fn()} showLark />);

    expect(screen.getByRole('button', { name: 'settings.feishuBot.qr.generate' })).toBeTruthy();
    expect(screen.queryByLabelText('settings.feishuBot.appIdLabel')).toBeNull();
    expect(screen.queryByLabelText('settings.feishuBot.appSecretLabel')).toBeNull();
  });

  it('starts authorization from the primary action', () => {
    mockRegistration({});
    render(<FeishuBotSection expanded onToggle={vi.fn()} showLark />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.feishuBot.qr.generate' }));
    expect(beginRegistration).toHaveBeenCalledOnce();
  });

  it('shows the generated authorization QR code and one-time code', () => {
    mockRegistration({
      phase: 'qr',
      qrDataUrl: 'data:image/png;base64,qr',
      userCode: 'ABCD-1234',
      secondsLeft: 240,
    });
    render(<FeishuBotSection expanded onToggle={vi.fn()} showLark />);

    expect(screen.getByAltText('settings.feishuBot.qr.qrAlt')).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === 'settings.feishuBot.qr.userCode: ABCD-1234',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.feishuBot.qr.cancel' })).toBeTruthy();
  });
});
