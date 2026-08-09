// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function Harness({
  controller,
  onResult,
}: {
  controller: AbortController;
  onResult: (ok: boolean) => void;
}) {
  const { confirm } = useConfirmDialog();
  return (
    <button
      type="button"
      onClick={() => {
        void confirm({
          title: 'Owner-scoped recovery',
          confirmText: 'Restore',
          cancelText: 'Keep',
          requireExplicitChoice: true,
          signal: controller.signal,
        }).then(onResult);
      }}
    >
      Open
    </button>
  );
}

describe('ConfirmDialogProvider abort signal', () => {
  afterEach(() => {
    cleanup();
  });

  it('blocks Escape but closes and resolves false when its owner scope is aborted', async () => {
    const controller = new AbortController();
    const onResult = vi.fn();
    render(
      <ConfirmDialogProvider>
        <Harness controller={controller} onResult={onResult} />
      </ConfirmDialogProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByText('Owner-scoped recovery')).toBeTruthy();

    act(() => controller.abort());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.queryByText('Owner-scoped recovery')).toBeNull());
  });
});
