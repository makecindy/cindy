// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CindyMakeCommandDialog } from '../CindyMakeCommandDialog';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/cindyMakeDoctor', () => ({ cancelMakeDoctor: vi.fn(async () => {}) }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => null),
    removeMessageByClientId: vi.fn(),
  },
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Cindy Make command dialog', () => {
  it('focuses the dialog instead of Close and ignores clicks on the backdrop', async () => {
    const onOpenChange = vi.fn();
    render(<CindyMakeCommandDialog sessionId={null} open onOpenChange={onOpenChange} />);

    const dialog = screen.getByRole('dialog');
    const closeButton = screen.getByRole('button', { name: 'common.dismiss' });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(document.activeElement).not.toBe(closeButton);

    const overlay = screen.getByTestId('cindy-make-dialog-overlay');
    fireEvent.pointerDown(overlay, { button: 0, pointerType: 'mouse' });
    fireEvent.click(overlay);
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(closeButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
