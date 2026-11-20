// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runBotLifecycleAction: vi.fn(async () => ({ status: 'deleted' })),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../botStore', () => ({ runBotLifecycleAction: mocks.runBotLifecycleAction }));

import { BotDeleteDialog } from '../BotDeleteDialog';

afterEach(() => {
  cleanup();
  mocks.runBotLifecycleAction.mockClear();
});

describe('BotDeleteDialog', () => {
  it('deletes from the roster confirmation and preserves task history', async () => {
    const onOpenChange = vi.fn();
    const onDeleted = vi.fn();
    render(
      <BotDeleteDialog
        bot={{ id: 'bot-1', name: 'Filo' } as never}
        onOpenChange={onOpenChange}
        onDeleted={onDeleted}
      />,
    );

    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.delete' }));

    await waitFor(() =>
      expect(mocks.runBotLifecycleAction).toHaveBeenCalledWith({
        botId: 'bot-1',
        action: 'delete',
        confirmName: 'Filo',
        keepTaskHistory: true,
        worktreeDisposition: 'retain',
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDeleted).toHaveBeenCalledWith('bot-1');
  });

  // Shared ConfirmDialog closes on its confirm action; a failed delete must keep
  // the dialog open with the error instead of silently dismissing it.
  it('stays open and reports a failed delete', async () => {
    mocks.runBotLifecycleAction.mockRejectedValueOnce(new Error('boom'));
    const onOpenChange = vi.fn();
    const onDeleted = vi.fn();
    render(
      <BotDeleteDialog
        bot={{ id: 'bot-1', name: 'Filo' } as never}
        onOpenChange={onOpenChange}
        onDeleted={onDeleted}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.delete' }));

    expect((await screen.findByRole('alert')).textContent).toBe('bots.lifecycle.deleteFailed');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
