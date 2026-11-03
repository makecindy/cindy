// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/recentWorkdirsStore', () => ({ recentWorkdirsStore: { remove: vi.fn() } }));

import {
  FolderPickerPopover,
  filterFolderPickerOptions,
  type FolderPickerOption,
} from '../FolderPickerPopover';

const project = (name: string, dir = 'makecindy'): FolderPickerOption => ({
  path: `/Users/me/Projects/${dir}/${name}`,
  name,
  description: `/Users/me/Projects/${dir}/${name}`,
});

const manyProjects = [
  project('cindy'),
  project('cindy-server', 'xindong'),
  project('cindy-official-plugins'),
  project('filoai-frontend', 'filoai'),
  project('cli-slg', 'filoai'),
];

const SEARCH = 'newChat.folderPicker.searchProjects';

function renderPicker(projectOptions: readonly FolderPickerOption[]) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FolderPickerPopover
      open
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      projectOptions={projectOptions}
    >
      <button type="button">trigger</button>
    </FolderPickerPopover>,
  );
  return { onSelect, onOpenChange };
}

afterEach(() => {
  cleanup();
});

describe('filterFolderPickerOptions', () => {
  it('matches name or path case-insensitively and keeps order', () => {
    expect(filterFolderPickerOptions(manyProjects, '  SERVER ').map((p) => p.name)).toEqual([
      'cindy-server',
    ]);
    expect(filterFolderPickerOptions(manyProjects, 'filoai').map((p) => p.name)).toEqual([
      'filoai-frontend',
      'cli-slg',
    ]);
    expect(filterFolderPickerOptions(manyProjects, '')).toBe(manyProjects);
  });

  it('folds case the same way regardless of the system locale', () => {
    // 模拟土耳其语区域:按区域折叠时 I → ı,ASCII 项目名会搜不到。
    const turkish = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
    ) {
      return this.replace(/I/g, 'ı').toLowerCase();
    });
    try {
      expect(filterFolderPickerOptions([project('INVOICE')], 'invoice').map((p) => p.name)).toEqual(
        ['INVOICE'],
      );
    } finally {
      turkish.mockRestore();
    }
  });
});

describe('FolderPickerPopover project search', () => {
  it('stays hidden while every project fits in view', () => {
    renderPicker(manyProjects.slice(0, 4));
    expect(screen.queryByPlaceholderText(SEARCH)).toBeNull();
  });

  it('focuses the search box when projects arrive after the menu opened', () => {
    const props = { open: true, onOpenChange: vi.fn(), onSelect: vi.fn() };
    const { rerender } = render(
      <FolderPickerPopover {...props} projectOptions={[]}>
        <button type="button">trigger</button>
      </FolderPickerPopover>,
    );
    expect(screen.queryByPlaceholderText(SEARCH)).toBeNull();

    rerender(
      <FolderPickerPopover {...props} projectOptions={manyProjects}>
        <button type="button">trigger</button>
      </FolderPickerPopover>,
    );
    expect(document.activeElement).toBe(screen.getByPlaceholderText(SEARCH));
  });

  it('filters projects, picks the first match on Enter, and shows an empty result', () => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'cindy' } });
    expect(screen.queryByText('filoai-frontend')).toBeNull();
    expect(screen.getByText('cindy-server')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'nothing-here' } });
    expect(screen.getByText('newChat.folderPicker.noMatchingProjects')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'slg' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(manyProjects[4].path, 'project', manyProjects[4]);
  });

  it('fades whichever edge can still scroll once the portal content mounts', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(392);
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(252);
    try {
      renderPicker(manyProjects);
      const list = document.querySelector('[data-folder-picker-scroll]') as HTMLElement;
      expect(list.className).toContain('folder-picker-fade-bottom');
      expect(list.className).not.toContain('folder-picker-fade-top');

      list.scrollTop = 140;
      fireEvent.scroll(list);
      expect(list.className).toContain('folder-picker-fade-top');
      expect(list.className).not.toContain('folder-picker-fade-bottom');
    } finally {
      height.mockRestore();
      client.mockRestore();
    }
  });

  it('clears the query on Escape before closing', () => {
    const { onOpenChange } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'slg' } });

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
