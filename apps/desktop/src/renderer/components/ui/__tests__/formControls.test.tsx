// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Button } from '../button';
import { Input } from '../input';
import { ConfirmDialog } from '../confirm-dialog';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));
afterEach(cleanup);

it('retains the busy button name, blocks activation and restores it on failure', () => {
  const click = vi.fn();
  const { rerender } = render(
    <Button loading onClick={click}>
      Save changes
    </Button>,
  );
  const button = screen.getByRole('button', { name: 'Save changes' });
  fireEvent.click(button);
  expect(click).not.toHaveBeenCalled();
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.querySelector('.motion-reduce\\:animate-none')).not.toBeNull();
  rerender(<Button onClick={click}>Save changes</Button>);
  fireEvent.click(button);
  expect(click).toHaveBeenCalledOnce();
});

it('keeps disabled secret values masked and the reveal control unavailable', () => {
  render(<Input secret disabled aria-label="Token" value="fictional" onChange={() => {}} />);
  const input = screen.getByLabelText('Token') as HTMLInputElement;
  const reveal = screen.getByRole('button') as HTMLButtonElement;
  expect(reveal.disabled).toBe(true);
  fireEvent.click(reveal);
  expect(input.type).toBe('password');
  expect(reveal.getAttribute('aria-pressed')).toBe('false');
});

it.each([undefined, 'standard'] as const)(
  'preserves ordinary confirm ordering and Cancel focus (%s)',
  async (presentation) => {
    const onTertiary = vi.fn();
    render(
      <ConfirmDialog
        presentation={presentation}
        open
        title="Save changes?"
        confirmText="Save"
        tertiaryText="Discard"
        cancelText="Cancel"
        onTertiary={onTertiary}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Save',
      'Discard',
      'Cancel',
    ]);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onTertiary).toHaveBeenCalledOnce();
  },
);

it('prioritizes typed confirmation over explicit main focus and blocks busy closure', async () => {
  const close = vi.fn();
  const props = {
    presentation: 'standard' as const,
    open: true,
    title: 'Delete?',
    confirmText: 'Delete',
    autoFocusConfirm: true,
    requireTypedConfirmation: { expected: 'DELETE', label: 'Type DELETE' },
    onOpenChange: close,
  };
  const { rerender } = render(<ConfirmDialog {...props} />);
  const input = screen.getByRole('textbox');
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'DELETE' } });
  expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  rerender(<ConfirmDialog {...props} loading />);
  fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(close).not.toHaveBeenCalled();
});
