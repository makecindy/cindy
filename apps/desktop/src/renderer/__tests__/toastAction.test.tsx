// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Toast } from '../components/ui/toast/Toast';
import { getToastSnapshot, toast } from '../lib/toast';

afterEach(() => {
  cleanup();
  toast.dismissAll();
  vi.clearAllMocks();
});

describe('Toast action', () => {
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
