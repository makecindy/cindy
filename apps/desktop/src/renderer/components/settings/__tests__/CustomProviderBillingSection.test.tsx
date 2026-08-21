// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hookValue: {
    showSdkCostForCustomProviders: true,
    isCustomized: true,
    setShowSdkCostForCustomProviders: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
  },
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useCustomProviderBillingSettings', () => ({
  useCustomProviderBillingSettings: () => mocks.hookValue,
}));

vi.mock('@/lib/toast', () => ({ toast: mocks.toast }));

vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: ({
    isCustomized,
    disabled,
    onReset,
  }: {
    isCustomized: boolean;
    disabled?: boolean;
    onReset: () => void;
  }) =>
    isCustomized ? (
      <button
        type="button"
        disabled={disabled}
        aria-label="settings.defaults.restore"
        onClick={onReset}
      />
    ) : null,
}));

import { CustomProviderBillingSection } from '../CustomProviderBillingSection';

describe('CustomProviderBillingSection', () => {
  beforeEach(() => {
    mocks.hookValue.showSdkCostForCustomProviders = true;
    mocks.hookValue.isCustomized = true;
    mocks.hookValue.setShowSdkCostForCustomProviders = vi.fn(async () => undefined);
    mocks.hookValue.reset = vi.fn(async () => undefined);
    vi.clearAllMocks();
  });

  it('exposes restore default only while the setting has an override', () => {
    const view = render(<CustomProviderBillingSection />);

    expect(screen.getByRole('button', { name: 'settings.defaults.restore' })).toBeTruthy();

    mocks.hookValue.isCustomized = false;
    view.rerender(<CustomProviderBillingSection />);

    expect(screen.queryByRole('button', { name: 'settings.defaults.restore' })).toBeNull();
  });

  it('removes the override through the hook and confirms the restored default', async () => {
    render(<CustomProviderBillingSection />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));

    await waitFor(() => expect(mocks.hookValue.reset).toHaveBeenCalledOnce());
    expect(mocks.toast.success).toHaveBeenCalledWith('settings.defaults.restored');
  });

  it('disables both controls while restoring and reports a failed reset', async () => {
    let rejectReset!: (reason: unknown) => void;
    mocks.hookValue.reset = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectReset = reject;
        }),
    );
    render(<CustomProviderBillingSection />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));

    expect(
      (screen.getByRole('button', { name: 'settings.defaults.restore' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);

    rejectReset(new Error('disk unavailable'));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('settings.defaults.restoreFailed'),
    );
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
  });
});
