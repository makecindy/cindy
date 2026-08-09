// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast, type ToastItem } from '@/lib/toast';

import { Toast } from '../toast/Toast';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function item(): ToastItem {
  return {
    id: 'toast-1',
    variant: 'warning',
    message: 'Provider needs attention',
    duration: 1200,
    createdAt: 0,
    exiting: false,
    actions: [
      { label: 'Open logs', onClick: () => {} },
      { label: 'Copy diagnostics', onClick: () => {} },
    ],
  };
}

describe('Toast action focus', () => {
  it('pauses dismissal while an action has keyboard focus and resumes after focus leaves', () => {
    const pause = vi.spyOn(toast, 'pauseAutoDismiss');
    const resume = vi.spyOn(toast, 'resumeAutoDismiss');
    render(<Toast item={item()} />);

    const openLogs = screen.getByRole('button', { name: 'Open logs' });
    const copyDiagnostics = screen.getByRole('button', { name: 'Copy diagnostics' });

    fireEvent.focus(openLogs);
    expect(pause).toHaveBeenCalledWith('toast-1');

    fireEvent.blur(openLogs, { relatedTarget: copyDiagnostics });
    expect(resume).not.toHaveBeenCalled();

    fireEvent.focus(copyDiagnostics);
    fireEvent.blur(copyDiagnostics, { relatedTarget: document.body });
    expect(resume).toHaveBeenCalledWith('toast-1');
  });

  it('keeps dismissal paused until both hover and focus leave', () => {
    const pause = vi.spyOn(toast, 'pauseAutoDismiss');
    const resume = vi.spyOn(toast, 'resumeAutoDismiss');
    const { container } = render(<Toast item={item()} />);
    const action = screen.getByRole('button', { name: 'Open logs' });
    const toastElement = container.firstElementChild as HTMLDivElement;

    fireEvent.mouseEnter(toastElement);
    action.focus();
    fireEvent.mouseLeave(toastElement);
    expect(pause).toHaveBeenCalledWith('toast-1');
    expect(resume).not.toHaveBeenCalled();

    fireEvent.blur(action, { relatedTarget: document.body });
    expect(resume).toHaveBeenCalledWith('toast-1');
  });
});
