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

// #9695: exercise the real portal and DOM event cancellation, which the old
// source-string wheel check missed. jsdom cannot perform native scrolling;
// real wheel displacement and scroll chaining still require browser validation.
// Unit tier: one cancelable wheel outside the list exposes the passive-listener
// failure; an icon target and a close/reopen cover native routing and lifetime.
describe('FolderPickerPopover wheel routing', () => {
  function scrollList() {
    const list = document.querySelector<HTMLElement>('[data-folder-picker-scroll]')!;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 252 },
    });
    return list;
  }

  it.each([
    [WheelEvent.DOM_DELTA_PIXEL, 24],
    [WheelEvent.DOM_DELTA_LINE, 24 * 16],
    [WheelEvent.DOM_DELTA_PAGE, 24 * window.innerHeight],
  ])('cancels native default before forwarding delta mode %s from the search box', (deltaMode, delta) => {
    renderPicker(manyProjects);
    const list = scrollList();
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 24,
      deltaMode,
    });

    fireEvent(screen.getByPlaceholderText(SEARCH), wheel);

    expect(wheel.defaultPrevented).toBe(true);
    expect(list.scrollTop).toBe(delta);
  });

  it('leaves a wheel over a project icon to native scrolling without adding another delta', () => {
    renderPicker(manyProjects);
    const list = scrollList();
    list.scrollTop = 40;
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 24 });

    fireEvent(list.querySelector('svg')!, wheel);

    expect(wheel.defaultPrevented).toBe(false);
    expect(list.scrollTop).toBe(40);
  });

  it('routes recent-folder header wheels to its separate list without intercepting its rows', () => {
    // The legacy picker has a separate scroll node and no project-search ref.
    // One cancelable header event must still cancel before manual forwarding.
    localStorage.setItem('cc-agent-recent-folders', JSON.stringify(manyProjects));
    try {
      render(
        <FolderPickerPopover open onOpenChange={vi.fn()} onSelect={vi.fn()}>
          <button type="button">trigger</button>
        </FolderPickerPopover>,
      );
      const list = scrollList();
      const headerWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 24 });
      fireEvent(screen.getByText('newChat.folderPicker.recent'), headerWheel);
      expect(headerWheel.defaultPrevented).toBe(true);
      expect(list.scrollTop).toBe(24);

      const rowWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 24 });
      fireEvent(list.querySelector('svg')!, rowWheel);
      expect(rowWheel.defaultPrevented).toBe(false);
      expect(list.scrollTop).toBe(24);
    } finally {
      localStorage.removeItem('cc-agent-recent-folders');
    }
  });

  it('attaches to a late portal, detaches on close, and forwards only once after reopening', () => {
    const props = { onOpenChange: vi.fn(), onSelect: vi.fn(), projectOptions: manyProjects };
    const picker = (open: boolean) => (
      <FolderPickerPopover {...props} open={open}>
        <button type="button">trigger</button>
      </FolderPickerPopover>
    );
    const { rerender } = render(picker(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(picker(true));
    const oldList = scrollList();
    const oldHeading = screen.getByText('newChat.folderPicker.projects');
    rerender(picker(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.wheel(oldHeading, { deltaY: 24, cancelable: true });
    expect(oldList.scrollTop).toBe(0);

    rerender(picker(true));
    const list = scrollList();
    const heading = screen.getByText('newChat.folderPicker.projects');
    fireEvent.wheel(heading, { deltaY: 24, cancelable: true });
    expect(list.scrollTop).toBe(24);
    // If the browser does not allow cancellation, do not add manual scrolling.
    fireEvent.wheel(heading, { deltaY: 24, cancelable: false });
    expect(list.scrollTop).toBe(24);
  });
});
