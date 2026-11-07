// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { toast } from '@/lib/toast';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { providerShareManagementCommand } from '../../provider-group/providerManagement';
import { SubscriptionCreditsSetting } from '../SubscriptionCreditsSetting';

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

const subscription = (autoUseCredits = true) =>
  ({
    id: 'openai',
    subscriptionCreditsPolicy: { autoUseCredits },
  }) as ProviderView;

beforeEach(() => {
  setDataOwnerGeneration('credits-owner');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setDataOwnerGeneration('credits-owner');
});

describe('SubscriptionCreditsSetting', () => {
  it('saves the opt-out and reflects the committed value', async () => {
    vi.mocked(providerShareManagementCommand).mockResolvedValue({
      supported: true,
      autoUseCredits: false,
    });
    render(<SubscriptionCreditsSetting provider={subscription()} />);

    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('switch'));
    expect(providerShareManagementCommand).toHaveBeenCalledWith(
      {
        action: 'set-credits-policy',
        providerId: 'openai',
        autoUseCredits: false,
      },
      undefined,
    );

    await waitFor(() =>
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'),
    );
  });

  it('keeps the current value and reports a failed save', async () => {
    vi.mocked(providerShareManagementCommand).mockRejectedValue(new Error('disk unavailable'));
    render(<SubscriptionCreditsSetting provider={subscription()} />);

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledExactlyOnceWith(
        'subscriptionCreditsPolicy.saveFailed',
      ),
    );
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('does not render for providers without the policy', () => {
    render(<SubscriptionCreditsSetting provider={{ id: 'custom' } as ProviderView} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
