// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeView } from '../FileTreeView';
import type { DirEntry, UseFileTreeReturn } from '../hooks/useFileTree';

const entries: DirEntry[] = [
  { name: 'cat.png', relPath: 'cat.png', type: 'file', size: 10, mtimeMs: 1 },
  { name: 'logo.svg', relPath: 'logo.svg', type: 'file', size: 20, mtimeMs: 2 },
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

describe('FileTreeView image preview action', () => {
  it('shows the eye action only for lightbox-compatible images', () => {
    const onPreviewImage = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        selectedPath={null}
        onSelectFile={vi.fn()}
        onPreviewImage={onPreviewImage}
      />,
    );

    expect(
      screen.getAllByRole('button', {
        name: 'ccAgent.workdirBrowse.imagePreview.viewLarge',
      }),
    ).toHaveLength(2);
    const previewButton = screen.getAllByRole('button', {
      name: 'ccAgent.workdirBrowse.imagePreview.viewLarge',
    })[0];
    expect(previewButton.tabIndex).toBe(0);
    expect(previewButton.className).not.toContain('invisible');
    expect(previewButton.className).toContain('focus-visible:opacity-100');
    expect(
      within(container.querySelector<HTMLElement>('[data-relpath="README.md"]')!).queryByRole(
        'button',
        {
          name: 'ccAgent.workdirBrowse.imagePreview.viewLarge',
        },
      ),
    ).toBeNull();
  });

  it('opens the image action without selecting the file row', () => {
    const onSelectFile = vi.fn();
    const onPreviewImage = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        selectedPath={null}
        onSelectFile={onSelectFile}
        onPreviewImage={onPreviewImage}
      />,
    );
    const row = container.querySelector<HTMLElement>('[data-relpath="cat.png"]')!;

    fireEvent.click(
      within(row).getByRole('button', {
        name: 'ccAgent.workdirBrowse.imagePreview.viewLarge',
      }),
    );

    expect(onPreviewImage).toHaveBeenCalledWith(entries[0]);
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it('keeps the file name as the row selection action', () => {
    const onSelectFile = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        selectedPath={null}
        onSelectFile={onSelectFile}
        onPreviewImage={vi.fn()}
      />,
    );
    const row = container.querySelector<HTMLElement>('[data-relpath="cat.png"]')!;

    fireEvent.click(within(row).getByRole('button', { name: 'cat.png' }));

    expect(onSelectFile).toHaveBeenCalledWith('cat.png');
  });

  it('keeps the outer row padding as part of the row selection action', () => {
    const onSelectFile = vi.fn();
    const { container } = render(
      <FileTreeView
        tree={makeTree()}
        selectedPath={null}
        onSelectFile={onSelectFile}
        onPreviewImage={vi.fn()}
      />,
    );
    const row = container.querySelector<HTMLElement>('[data-relpath="cat.png"]')!;

    fireEvent.click(row);

    expect(onSelectFile).toHaveBeenCalledWith('cat.png');
  });
});
