// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLAUDE_QUOTA_STATE_READ } from '../../../../shared/claudeQuotaState';
import { CloudXdQuota } from '../CloudXdQuota';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));
afterEach(cleanup);

function setup(answer: unknown) {
  const invoke = vi.fn(async () => answer);
  Object.assign(window, { electronAPI: { deviceLink: { invoke } } });
  render(<CloudXdQuota deviceId="cloud-device-1" online />);
  return invoke;
}

describe('cloud Cindy AI quota', () => {
  it('reads the instance quota and shows what is left and used', async () => {
    const invoke = setup({ spend: 25, maxBudget: 100, currency: 'CNY', todaySpend: null });
    expect(await screen.findByText('settings.providers.xd.asset.quotaTitle')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/75/)).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith('cloud-device-1', 'maker:usage:account', [
      'claude-code',
      CLAUDE_QUOTA_STATE_READ,
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.xd.asset.refresh' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  it('says the quota is unavailable instead of showing zero', async () => {
    setup(null);
    expect(await screen.findByText('settings.providers.xd.asset.unavailable')).toBeTruthy();
  });
});
