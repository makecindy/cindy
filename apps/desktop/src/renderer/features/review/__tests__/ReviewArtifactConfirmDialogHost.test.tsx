/** @vitest-environment jsdom */

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  resolve: vi.fn(),
  unsubscribe: vi.fn(),
  unsubscribeDismiss: vi.fn(),
  listener: null as ((payload: unknown) => void) | null,
  dismissListener: null as ((payload: unknown) => void) | null,
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

import { ReviewArtifactConfirmDialogHost } from '../ReviewArtifactConfirmDialogHost';

const REQUEST = {
  requestId: 'request-1',
  title: 'Allow review?',
  message: 'One item is outside the workspace.',
  detail: 'Review the item before allowing access.',
  items: [
    { kind: 'external-path' as const, label: 'report.pdf', path: 'D:\\outside\\report.pdf' },
    { kind: 'inline' as const, label: 'notes.txt', inlineLabel: 'inline attachment' },
  ],
  allowText: 'Allow',
  cancelText: 'Cancel',
};

beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.resolve.mockReset().mockResolvedValue({ handled: true });
  mocks.unsubscribe.mockReset();
  mocks.unsubscribeDismiss.mockReset();
  mocks.listener = null;
  mocks.dismissListener = null;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        onReviewArtifactConfirmRequest: (listener: (payload: unknown) => void) => {
          mocks.listener = listener;
          return mocks.unsubscribe;
        },
        onReviewArtifactConfirmDismiss: (listener: (payload: unknown) => void) => {
          mocks.dismissListener = listener;
          return mocks.unsubscribeDismiss;
        },
        resolveReviewArtifactConfirm: mocks.resolve,
      },
    },
  });
});

describe('ReviewArtifactConfirmDialogHost', () => {
  it('shows every item in Cindy confirm UI and returns the explicit choice', async () => {
    mocks.confirm.mockResolvedValue(true);
    render(<ReviewArtifactConfirmDialogHost />);

    await act(async () => {
      mocks.listener?.(REQUEST);
      await Promise.resolve();
    });

    const options = mocks.confirm.mock.calls[0][0];
    expect(options).toMatchObject({
      title: REQUEST.title,
      description: REQUEST.message,
      confirmText: 'Allow',
      cancelText: 'Cancel',
      describeContent: true,
    });
    render(options.content);
    expect(screen.getByText('D:\\outside\\report.pdf')).toBeTruthy();
    expect(screen.getByText('notes.txt (inline attachment)')).toBeTruthy();
    expect(mocks.resolve).toHaveBeenCalledWith('request-1', true);
  });

  it('denies a malformed payload with a usable request id', async () => {
    render(<ReviewArtifactConfirmDialogHost />);

    await act(async () => {
      mocks.listener?.({ requestId: 'request-2', title: 123 });
      await Promise.resolve();
    });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.resolve).toHaveBeenCalledWith('request-2', false);
  });

  it('unsubscribes from the window-scoped request channel on unmount', () => {
    const view = render(<ReviewArtifactConfirmDialogHost />);
    view.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeDismiss).toHaveBeenCalledOnce();
  });

  it('dismisses an open or queued confirmation when Main expires the request', async () => {
    mocks.confirm.mockImplementation((_options: unknown, signal: AbortSignal) => {
      return new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(false), { once: true });
      });
    });
    render(<ReviewArtifactConfirmDialogHost />);

    await act(async () => {
      mocks.listener?.(REQUEST);
      await Promise.resolve();
    });
    const signal = mocks.confirm.mock.calls[0][1] as AbortSignal;

    await act(async () => {
      mocks.dismissListener?.({ requestId: REQUEST.requestId });
      await Promise.resolve();
    });

    expect(signal.aborted).toBe(true);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
