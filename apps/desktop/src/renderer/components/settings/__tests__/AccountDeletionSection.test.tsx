// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  value: {
    user: { id: 'membership-id' },
    isAuthenticated: true,
    getAccountDeletionAvailability: vi.fn(),
    requestAccountDeletionChallenge: vi.fn(),
    confirmAccountDeletion: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => auth.value,
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: {
    open: boolean;
    title: string;
    content?: React.ReactNode;
    confirmText: string;
    confirmDisabled?: boolean;
    loading?: boolean;
    onConfirm?: () => void;
  }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        {props.content}
        <button
          type="button"
          disabled={props.loading || props.confirmDisabled}
          onClick={props.onConfirm}
        >
          {props.confirmText}
        </button>
      </div>
    ) : null,
}));

import { AccountDeletionSection } from '../AccountDeletionSection';

describe('AccountDeletionSection', () => {
  beforeEach(() => {
    auth.value.user = { id: 'membership-id' };
    auth.value.isAuthenticated = true;
    auth.value.getAccountDeletionAvailability = vi.fn().mockResolvedValue({
      success: true,
      value: {
        available: true,
        verification: { channel: 'email', maskedTarget: 'u***@example.com' },
        manualAppleRevocationRequired: false,
      },
    });
    auth.value.requestAccountDeletionChallenge = vi.fn().mockResolvedValue({
      success: true,
      value: {
        challengeId: 'challenge-id',
        channel: 'email',
        maskedTarget: 'u***@example.com',
        expiresAt: '2026-07-22T00:10:00.000Z',
      },
    });
    auth.value.confirmAccountDeletion = vi.fn().mockResolvedValue({
      success: true,
      value: {
        status: 'pending',
        requestedAt: '2026-07-22T00:00:00.000Z',
        deleteAfter: '2026-08-21T00:00:00.000Z',
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps the secondary entry hidden for an ineligible account', async () => {
    auth.value.getAccountDeletionAvailability.mockResolvedValue({
      success: true,
      value: {
        available: false,
        manualAppleRevocationRequired: false,
      },
    });

    render(<AccountDeletionSection />);
    await waitFor(() => expect(auth.value.getAccountDeletionAvailability).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'accountDeletion.entryAria' })).toBeNull();
  });

  it('drops stale availability immediately when the signed-in identity changes', async () => {
    const view = render(<AccountDeletionSection />);
    expect(await screen.findByRole('button', { name: 'accountDeletion.entryAria' })).toBeTruthy();

    auth.value.user = { id: 'other-membership-id' };
    auth.value.getAccountDeletionAvailability.mockResolvedValue({
      success: true,
      value: {
        available: false,
        manualAppleRevocationRequired: false,
      },
    });
    view.rerender(<AccountDeletionSection />);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'accountDeletion.entryAria' })).toBeNull(),
    );
    expect(auth.value.getAccountDeletionAvailability).toHaveBeenCalledTimes(2);
  });

  it('requires OTP plus explicit acknowledgement before confirming deletion', async () => {
    render(<AccountDeletionSection />);
    const entry = await screen.findByRole('button', { name: 'accountDeletion.entryAria' });
    expect(entry.className).toContain('text-[var(--text-secondary)]');
    expect(entry.className).not.toContain('var(--destructive)');
    fireEvent.click(entry);

    fireEvent.click(screen.getByRole('button', { name: 'accountDeletion.sendCodeButton' }));
    const input = await screen.findByRole('textbox', {
      name: 'accountDeletion.codeInputAria',
    });
    const confirmButton = screen.getByRole('button', {
      name: 'accountDeletion.confirmButton',
    });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(auth.value.confirmAccountDeletion).toHaveBeenCalledWith({
        challengeId: 'challenge-id',
        code: '123456',
      }),
    );
  });
});
