/**
 * Confirm dialog pendingWork: keep the card open and swap the confirm button
 * for the design-system Spinner until the async work settles.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  ConfirmDialogProvider,
  useConfirmDialog,
} from '../confirm-dialog-provider';

function Trigger({
  pendingWork,
  onSettled,
}: {
  pendingWork: () => Promise<void>;
  onSettled: (ok: boolean) => void;
}) {
  const { confirm } = useConfirmDialog();
  return (
    <button
      type="button"
      onClick={() => {
        void confirm({
          title: 'Install plugin?',
          confirmText: 'Install',
          cancelText: 'Cancel',
          pendingWork,
        }).then(onSettled);
      }}
    >
      Open
    </button>
  );
}

describe('ConfirmDialogProvider pendingWork', () => {
  it('shows a spinner on the confirm button until pending work finishes', async () => {
    let finish!: () => void;
    const pendingWork = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onSettled = vi.fn();
    render(
      <ConfirmDialogProvider>
        <Trigger pendingWork={pendingWork} onSettled={onSettled} />
      </ConfirmDialogProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const confirm = await screen.findByRole('button', { name: 'Install' });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Install' }).getAttribute('aria-busy')).toBe(
        'true',
      );
    });
    expect(screen.getByRole('button', { name: 'Install' }).querySelector('.animate-spin')).toBeTruthy();
    expect(screen.getByText('Install plugin?')).toBeTruthy();
    expect(onSettled).not.toHaveBeenCalled();

    finish();
    await waitFor(() => {
      expect(onSettled).toHaveBeenCalledWith(true);
    });
  });
});
