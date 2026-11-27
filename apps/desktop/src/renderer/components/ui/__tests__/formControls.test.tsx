// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Button } from '../button';
import { Input } from '../input';
import { ConfirmDialog } from '../confirm-dialog';
import { CountBadge } from '../badge';

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

it('orders Cancel, tertiary, primary while keeping Cancel focus', async () => {
  const onTertiary = vi.fn();
  render(
    <ConfirmDialog
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
    'Cancel',
    'Discard',
    'Save',
  ]);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(onTertiary).toHaveBeenCalledOnce();
});

it('prioritizes typed confirmation over explicit main focus and blocks busy closure', async () => {
  const close = vi.fn();
  const props = {
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

// CountBadge replaced the sidebar-only NavigationCountBadge (DESIGN.md §4 Badges). Screen readers
// must hear the full count label as part of the row's name, not the clipped "99+", and an empty
// count must leave no badge behind.
it('reads a count badge by its label, caps the visible count and hides it at zero', () => {
  const { rerender } = render(
    <button type="button">
      Teammates
      <CountBadge count={120} label="120 unread messages" />
    </button>,
  );
  expect(screen.getByRole('button', { name: /^Teammates\s*120 unread messages$/ })).toBeTruthy();
  expect(screen.getByText('99+').getAttribute('aria-hidden')).toBe('true');
  rerender(
    <button type="button">
      Teammates
      <CountBadge count={0} label="0 unread messages" />
    </button>,
  );
  expect(screen.getByRole('button').textContent).toBe('Teammates');
});
