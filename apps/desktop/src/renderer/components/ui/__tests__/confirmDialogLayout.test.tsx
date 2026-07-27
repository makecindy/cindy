// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../confirm-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function renderDialog({ description, content }: { description?: string; content?: ReactNode }) {
  render(
    <ConfirmDialog
      open
      onOpenChange={vi.fn()}
      title="Update plugin"
      description={description}
      content={content}
      confirmText="Update"
      cancelText="Cancel"
    />,
  );

  const dialog = screen.getByRole('alertdialog');
  const header = dialog.querySelector<HTMLElement>('[data-confirm-dialog-section="header"]');
  const body = dialog.querySelector<HTMLElement>('[data-confirm-dialog-section="body"]');
  const footer = dialog.querySelector<HTMLElement>('[data-confirm-dialog-section="footer"]');
  if (!header || !body || !footer) throw new Error('ConfirmDialog sections were not rendered');
  return { dialog, header, body, footer };
}

/**
 * 长说明/权限清单不得把确认框撑出视口。Title 与 Footer 留在固定 flex
 * 区域,description 与富内容共用唯一正文 scrollport。
 */
describe('ConfirmDialog bounded layout', () => {
  it('keeps a long description in the scrollable body and the footer outside it', () => {
    const description = 'Permission required. '.repeat(100);
    const { dialog, header, body, footer } = renderDialog({ description });
    const descriptionElement = body.querySelector('p');
    if (!descriptionElement) throw new Error('ConfirmDialog description was not rendered');

    expect(header.textContent).toBe('Update plugin');
    expect(header.contains(descriptionElement)).toBe(false);
    expect(body.contains(descriptionElement)).toBe(true);
    expect(descriptionElement.textContent).toBe(description);
    expect(body.classList.contains('min-h-0')).toBe(true);
    expect(body.classList.contains('flex-1')).toBe(true);
    expect(body.classList.contains('overflow-y-auto')).toBe(true);
    expect(footer.parentElement).toBe(dialog);
    expect(body.contains(footer)).toBe(false);
  });

  it('renders rich content inside the same single scrollport', () => {
    const { dialog, body } = renderDialog({
      description: 'Review permission changes.',
      content: <div data-testid="permission-list">Permission list</div>,
    });

    expect(body.contains(screen.getByTestId('permission-list'))).toBe(true);
    expect(dialog.querySelectorAll('.overflow-y-auto')).toHaveLength(1);
    expect(dialog.classList.contains('max-h-[80vh]')).toBe(true);
    expect(dialog.classList.contains('flex-col')).toBe(true);
    expect(dialog.classList.contains('overflow-hidden')).toBe(true);
  });
});
