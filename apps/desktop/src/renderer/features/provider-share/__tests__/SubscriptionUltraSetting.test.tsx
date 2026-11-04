// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { toast } from '@/lib/toast';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { providerShareManagementCommand } from '../../provider-group/providerManagement';
import { SubscriptionUltraSetting } from '../SubscriptionUltraSetting';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../provider-group/providerManagement', () => ({
  providerShareManagementCommand: vi.fn(),
}));

const subscription = (allowUltra = false) =>
  ({
    id: 'openai',
    subscriptionUltraPolicy: { allowUltra },
  }) as ProviderView;

beforeEach(() => {
  setDataOwnerGeneration('ultra-owner');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SubscriptionUltraSetting', () => {
  it('is off by default and saves the opt-in', async () => {
    vi.mocked(providerShareManagementCommand).mockResolvedValue({
      supported: true,
      allowUltra: true,
    });
    render(<SubscriptionUltraSetting provider={subscription()} />);

    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('switch'));
    expect(providerShareManagementCommand).toHaveBeenCalledWith(
      { action: 'set-ultra-policy', providerId: 'openai', allowUltra: true },
      undefined,
    );

    await waitFor(() =>
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'),
    );
  });

  it('keeps the current value and reports a failed save', async () => {
    vi.mocked(providerShareManagementCommand).mockRejectedValue(new Error('disk unavailable'));
    render(<SubscriptionUltraSetting provider={subscription()} />);

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith(
        'subscriptionUltraPolicy.saveFailed',
      ),
    );
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('does not render for providers without the policy', () => {
    render(<SubscriptionUltraSetting provider={{ id: 'custom' } as ProviderView} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
