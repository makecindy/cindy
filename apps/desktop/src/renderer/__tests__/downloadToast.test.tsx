// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadToast } from '../components/ui/toast/DownloadToast';
import type { FileTransferToast } from '../lib/fileTransferToasts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, values: { count: number }) => `Downloads (${values.count})`,
  }),
}));
afterEach(cleanup);

const transfer = (id: string): FileTransferToast => ({
  id,
  name: `${id}.zip`,
  message: 'Downloading… 25%',
  variant: 'loading',
  duration: 0,
  createdAt: 0,
  exiting: false,
  action: { label: 'Cancel', onClick: vi.fn() },
});

describe('grouped download toast', () => {
  it('shows a text cancel button for one file and a disclosure for multiple files', () => {
    const items = ['a', 'b', 'c', 'd'].map(transfer);
    const view = render(<DownloadToast items={[items[0]]} />);
    expect(screen.getByText(items[0].message)).toBeTruthy();
    expect(screen.queryByText(items[0].name)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(items[0].action!.onClick).toHaveBeenCalledOnce();
    view.rerender(<DownloadToast items={items} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByRole('list')).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Downloads (4)' });
    fireEvent.click(trigger);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel b.zip' }));
    expect(items[1].action!.onClick).toHaveBeenCalledOnce();
    expect(items[2].action!.onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    view.rerender(<DownloadToast items={[items[3]]} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(items[3].message)).toBeTruthy();
    expect(screen.queryByText(items[3].name)).toBeNull();
    view.rerender(<DownloadToast items={[]} />);
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<DownloadToast items={items.slice(0, 2)} />);
    expect(
      screen.getByRole('button', { name: 'Downloads (2)' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });
});
