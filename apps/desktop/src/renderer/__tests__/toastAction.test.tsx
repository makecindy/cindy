// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Toast } from '../components/ui/toast/Toast';
import { getToastSnapshot, toast } from '../lib/toast';

afterEach(() => {
  cleanup();
  toast.dismissAll();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Toast action', () => {
  it.each(['mouse-first', 'focus-first'])('waits for both pause reasons to clear (%s)', (order) => {
    vi.useFakeTimers();
    const id = toast.error('Connection lost', { action: { label: 'Recover', onClick: vi.fn() } });
    const item = getToastSnapshot().find(candidate => candidate.id === id)!;
    render(<Toast item={item} />);
    const panel = screen.getByRole('alert');
    const action = screen.getByRole('button', { name: 'Recover' });
    if (order === 'mouse-first') { fireEvent.mouseEnter(panel); fireEvent.focus(action); }
    else { fireEvent.focus(action); fireEvent.mouseEnter(panel); }
    vi.advanceTimersByTime(9000);
    expect(getToastSnapshot().find(candidate => candidate.id === id)?.exiting).toBe(false);
    if (order === 'mouse-first') fireEvent.mouseLeave(panel);
    else fireEvent.blur(action, { relatedTarget: document.body });
    vi.advanceTimersByTime(9000);
    expect(getToastSnapshot().find(candidate => candidate.id === id)?.exiting).toBe(false);
    if (order === 'mouse-first') fireEvent.blur(action, { relatedTarget: document.body });
    else fireEvent.mouseLeave(panel);
    vi.advanceTimersByTime(8000);
    expect(getToastSnapshot().find(candidate => candidate.id === id)?.exiting).toBe(true);
  });
  it('renders one action, runs it, and dismisses the toast', () => {
    const onClick = vi.fn();
    const id = toast.error('Model not switched', {
      action: { label: 'Open Settings', onClick },
    });
    const item = getToastSnapshot().find((candidate) => candidate.id === id);
    expect(item?.action?.label).toBe('Open Settings');

    render(<Toast item={item!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(getToastSnapshot().find((candidate) => candidate.id === id)?.exiting).toBe(true);
  });
});
