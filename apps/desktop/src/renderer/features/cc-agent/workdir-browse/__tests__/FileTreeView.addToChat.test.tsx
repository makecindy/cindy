// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeView } from '../FileTreeView';
import type { DirEntry, UseFileTreeReturn } from '../hooks/useFileTree';

const entries: DirEntry[] = [
  { name: 'docs', relPath: 'docs', type: 'directory', size: 0, mtimeMs: 1 },
  { name: 'main.ts', relPath: 'src/main.ts', type: 'file', size: 10, mtimeMs: 2 },
  { name: 'README.md', relPath: 'README.md', type: 'file', size: 30, mtimeMs: 3 },
];

function makeTree(): UseFileTreeReturn {
  return {
    entries: new Map([['', entries]]),
    expanded: new Set(['']),
    loadingPaths: new Set(),
    initialLoading: false,
    loadError: null,
    toggleFolder: vi.fn(),
    collapseAll: vi.fn(),
    refresh: vi.fn(async () => undefined),
    expandToPath: vi.fn(async () => undefined),
  };
}

afterEach(() => cleanup());

describe('FileTreeView add-to-chat action', () => {
  it('shows add-to-chat in the file context menu when the handler is provided', async () => {
    const onAddToChat = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onAddToChat={onAddToChat}
      />,
    );

    const row = container.querySelector<HTMLElement>('[data-relpath="README.md"]')!;
    fireEvent.contextMenu(row);

    const item = await screen.findByRole('menuitem', { name: 'chat.quote.addToChat' });
    fireEvent.click(item);

    expect(onAddToChat).toHaveBeenCalledTimes(1);
    expect(onAddToChat).toHaveBeenCalledWith(entries[2]);
  });

  it('targets the right-clicked file, not the previously selected file', async () => {
    const onAddToChat = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        selectedPath="README.md"
        onSelectFile={vi.fn()}
        onAddToChat={onAddToChat}
      />,
    );

    const row = container.querySelector<HTMLElement>('[data-relpath="src/main.ts"]')!;
    fireEvent.contextMenu(row);

    const item = await screen.findByRole('menuitem', { name: 'chat.quote.addToChat' });
    fireEvent.click(item);

    expect(onAddToChat).toHaveBeenCalledWith(entries[1]);
  });

  it('does not show add-to-chat for directories', () => {
    const onAddToChat = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onAddToChat={onAddToChat}
      />,
    );

    const row = container.querySelector<HTMLElement>('[data-relpath="docs"]')!;
    fireEvent.contextMenu(row);

    expect(screen.queryByRole('menuitem', { name: 'chat.quote.addToChat' })).toBeNull();
  });

  it('keeps the context menu available on files when only add-to-chat is provided', async () => {
    const onAddToChat = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onAddToChat={onAddToChat}
      />,
    );

    const row = container.querySelector<HTMLElement>('[data-relpath="README.md"]')!;
    fireEvent.contextMenu(row);

    expect(await screen.findByRole('menu')).toBeTruthy();
  });
});
