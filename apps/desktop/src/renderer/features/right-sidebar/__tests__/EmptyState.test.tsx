// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderTree } from 'lucide-react';
import { EmptyState } from '../EmptyState';
import type { TabCreationMenu } from '../lib/useTabCreationMenu';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe('EmptyState shared actions', () => {
  it('renders a non-interactive hint for the existing top add button', () => {
    render(<EmptyState menu={{ items: [], select: vi.fn() }} />);
    const hint = screen.getByText('rightSidebar.tabs.empty.addMoreHint');
    expect(hint.tagName).toBe('P');
    expect(hint.closest('button')).toBeNull();
  });

  it('retains the supplied purpose description and action, and honors disabled state', () => {
    const menu: TabCreationMenu = { items: [{ kind: 'file-browser', labelKey: 'Files',
      descriptionKey: 'Browse files in the working folder',
      icon: FolderTree, enabled: true, order: 1, disabled: false, busy: false }], select: vi.fn() };
    const view = render(<EmptyState menu={menu} />);
    fireEvent.click(screen.getByRole('button', { name: 'Files', description: 'Browse files in the working folder' }));
    expect(menu.select).toHaveBeenCalledExactlyOnceWith('file-browser');
    view.rerender(<EmptyState menu={{ ...menu, items: menu.items.map(item => ({ ...item, disabled: true })) }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(menu.select).toHaveBeenCalledTimes(1);
  });
});
