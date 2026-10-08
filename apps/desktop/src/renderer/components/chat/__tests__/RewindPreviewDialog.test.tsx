// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rewindPreview: vi.fn(),
  rewindCommit: vi.fn(),
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock('@radix-ui/react-alert-dialog', () => ({
  Root: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Overlay: () => <div data-testid="overlay" />,
  Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Title: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Description: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Cancel: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/sessionService', () => ({
  rewindPreview: mocks.rewindPreview,
  rewindCommit: mocks.rewindCommit,
}));

vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: {
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => <>{children}</>,
  },
}));

vi.mock('@/lib/httpClient', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { ApiError } from '@/lib/httpClient';
import { RewindPreviewDialog } from '../RewindPreviewDialog';

describe('RewindPreviewDialog running-session flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rewindPreview.mockResolvedValue({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });
    mocks.rewindCommit.mockResolvedValue({ id: 'session-1' });
  });

  it('confirms stop-then-rewind without requesting a stale running preview', async () => {
    const onCommitted = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <RewindPreviewDialog
        open
        sessionId="session-1"
        clientId="message-1"
        sessionRunning
        onCommitted={onCommitted}
        onOpenChange={onOpenChange}
      />,
    );

    expect(mocks.rewindPreview).not.toHaveBeenCalled();
    expect(screen.getByText('chat.rewind.dialog.summaryRunning')).toBeTruthy();
    expect(screen.getByText('chat.rewind.dialog.runningQueueNotice')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'chat.rewind.dialog.confirmRunning' }));

    await waitFor(() =>
      expect(mocks.rewindCommit).toHaveBeenCalledWith('session-1', 'message-1', {
        stopIfRunning: true,
      }),
    );
    expect(onCommitted).toHaveBeenCalledWith({ id: 'session-1' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not stop the task before the user confirms', () => {
    render(
      <RewindPreviewDialog
        open
        sessionId="session-1"
        clientId="message-1"
        sessionRunning
        onCommitted={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'chat.rewind.dialog.cancel' }));

    expect(mocks.rewindCommit).not.toHaveBeenCalled();
  });

  it('switches to an exact preview if the turn finishes while the dialog is open', async () => {
    const props = {
      open: true,
      sessionId: 'session-1',
      clientId: 'message-1',
      onCommitted: vi.fn(),
      onOpenChange: vi.fn(),
    };
    const view = render(<RewindPreviewDialog {...props} sessionRunning />);

    expect(mocks.rewindPreview).not.toHaveBeenCalled();

    view.rerender(<RewindPreviewDialog {...props} sessionRunning={false} />);

    await waitFor(() => expect(mocks.rewindPreview).toHaveBeenCalledWith('session-1', 'message-1'));
    expect(screen.getByText('chat.rewind.dialog.summaryEmpty')).toBeTruthy();
  });

  it('upgrades an authoritative running preview race to stop-then-rewind', async () => {
    mocks.rewindPreview.mockRejectedValueOnce(
      new ApiError('SESSION_RUNNING', 0, 'session running'),
    );

    render(
      <RewindPreviewDialog
        open
        sessionId="session-1"
        clientId="message-1"
        sessionRunning={false}
        onCommitted={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('chat.rewind.dialog.summaryRunning')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'chat.rewind.dialog.confirmRunning' })).toBeTruthy();
  });

  it('binds conversation-only preview so commit cannot restore files', async () => {
    mocks.rewindPreview.mockResolvedValueOnce({
      canRewind: true,
      conversationOnly: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });

    render(
      <RewindPreviewDialog
        open
        sessionId="session-1"
        clientId="message-1"
        sessionRunning={false}
        onCommitted={vi.fn()}
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('chat.rewind.conversationOnlyNotice')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'chat.rewind.dialog.confirm' }));

    await waitFor(() =>
      expect(mocks.rewindCommit).toHaveBeenCalledWith('session-1', 'message-1', {
        stopIfRunning: true,
        allowFileRestore: false,
      }),
    );
  });
});
