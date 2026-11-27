// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/cc-agent/sidebar/ProjectIcon', () => ({ ProjectIcon: () => null }));
vi.mock('@/features/cc-agent/hooks/useProjectInfo', () => ({ useProjectInfo: () => undefined }));

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

// #11653: Enter used to select visibleProjectOptions[0] no matter which match the
// user wanted, and the arrow keys did nothing. These cases go through the real search
// box and assert which project the selection callback receives. Unit tier (jsdom):
// native scrolling still needs the desktop black-box check recorded in the PR.
describe('FolderPickerPopover keyboard highlight', () => {
  const rowOf = (name: string) =>
    screen.getByText(name).closest('[data-folder-picker-index]') as HTMLElement;

  it('moves the Enter target with arrow keys, stops at both ends and scrolls the row into view', () => {
    const scrolled: Element[] = [];
    // jsdom has no layout, so record which row the picker asks the browser to reveal.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: Element) {
        scrolled.push(this);
      },
    });
    try {
      const { onSelect } = renderPicker(manyProjects);
      const input = screen.getByPlaceholderText(SEARCH);
      // Matches cindy, cindy-server, cindy-official-plugins (the first by its makecindy path).
      fireEvent.change(input, { target: { value: 'cindy' } });
      for (const key of ['ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp']) {
        fireEvent.keyDown(input, { key });
      }
      expect(document.activeElement).toBe(input);
      expect(scrolled.at(-1)).toBe(rowOf('cindy-server'));

      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onSelect).toHaveBeenCalledWith(manyProjects[1].path, 'project', manyProjects[1]);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('returns to the first match when the query changes and ignores keys while composing', () => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);
    fireEvent.change(input, { target: { value: 'cindy' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Two matches remain; a stale index 1 would pick cindy-official-plugins.
    fireEvent.change(input, { target: { value: 'cindy-' } });
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(manyProjects[1].path, 'project', manyProjects[1]);
  });

  // PR #12492 review: the highlight was keyed by query text, so returning to an
  // earlier query revived the index moved under it instead of the default.
  it.each([
    {
      name: 'typing back to an earlier query targets its first match again',
      queries: [['cindy', 1], ['cindy-', 0], ['cindy', 0]] as const,
      expected: manyProjects[0],
    },
    {
      name: 'clearing the query with Escape drops an earlier empty-query highlight',
      queries: [['', 1], ['slg', 0], ['Escape', 0]] as const,
      expected: undefined,
    },
  ])('$name', ({ queries, expected }) => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);
    for (const [query, downs] of queries) {
      if (query === 'Escape') fireEvent.keyDown(input, { key: 'Escape' });
      else fireEvent.change(input, { target: { value: query } });
      for (let i = 0; i < downs; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    }
    fireEvent.keyDown(input, { key: 'Enter' });
    if (expected) expect(onSelect).toHaveBeenCalledWith(expected.path, 'project', expected);
    else expect(onSelect).not.toHaveBeenCalled();
  });

  // Chromium reports how far the pointer travelled; the move it synthesises when rows
  // scroll or appear beneath a still pointer has none. jsdom lacks movementX, so set it.
  const pointerMove = (target: HTMLElement, movementX: number) => {
    const event = new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 40 });
    Object.defineProperties(event, {
      movementX: { value: movementX },
      movementY: { value: 0 },
    });
    fireEvent(target, event);
  };

  it.each([
    {
      name: 'a real pointer move makes the hovered row the Enter target',
      interact: () => pointerMove(rowOf('cindy-official-plugins'), 3),
      expected: manyProjects[2],
    },
    {
      name: 'a motionless move after a keyboard scroll keeps the keyboard row, even before any real move',
      interact: (input: HTMLElement) => {
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        pointerMove(rowOf('filoai-frontend'), 0);
      },
      expected: manyProjects[1],
    },
    {
      name: 'leaving the list without a query clears the hover highlight',
      interact: () => {
        pointerMove(rowOf('cindy-official-plugins'), 3);
        fireEvent.mouseLeave(document.querySelector('[data-folder-picker-scroll]')!);
      },
      expected: undefined,
    },
  ])('$name', ({ interact, expected }) => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);
    // No query: Enter selects nothing until a row is highlighted.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();

    interact(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    if (expected) {
      expect(onSelect).toHaveBeenCalledWith(expected.path, 'project', expected);
    } else {
      expect(onSelect).not.toHaveBeenCalled();
    }
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

  // Short windows: the menu is capped to the space beside the trigger and the
  // section above the pinned "new project / add remote project" actions scrolls.
  // Minimal failing input: list already at its end, section still scrollable —
  // before the cap there was no such section and the rest was unreachable.
  // The pointer may sit on the heading or stay on a project row: the list's own
  // overscroll-contain stops the browser passing the wheel outward, so a row
  // wheel at the list's end must be handed over too (review on #13341).
  it.each([
    ['the projects heading', () => screen.getByText('newChat.folderPicker.projects')],
    ['a project row', () => document.querySelector<HTMLElement>('[data-folder-picker-scroll] svg')!],
  ])('scrolls the section above the pinned actions from %s once the list reaches its end', (_, at) => {
    renderPicker(manyProjects);
    const list = scrollList();
    list.scrollTop = 748;
    const section = document.querySelector<HTMLElement>('[data-folder-picker-section]')!;
    Object.defineProperties(section, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 300 },
    });
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 24 });

    fireEvent(at(), wheel);

    expect(wheel.defaultPrevented).toBe(true);
    expect(list.scrollTop).toBe(748);
    expect(section.scrollTop).toBe(24);
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
