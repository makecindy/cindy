// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
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

function renderPicker(projectOptions: readonly FolderPickerOption[], allowRemove = true) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FolderPickerPopover
      open
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      projectOptions={projectOptions}
      allowRemove={allowRemove}
    >
      <button type="button">trigger</button>
    </FolderPickerPopover>,
  );
  return { onSelect, onOpenChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

  it('filters projects, picks the first match on Enter, and shows an empty result', async () => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'cindy' } });
    expect(screen.queryByText('filoai-frontend')).toBeNull();
    expect(screen.getByText('cindy-server')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'nothing-here' } });
    expect(screen.getByText('newChat.folderPicker.noMatchingProjects')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'slg' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
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

  // 测试价值（engineering-conventions.md §3.2）
  // - 生产入口与可观察结果：真实渲染 FolderPickerPopover 并驱动搜索框键盘事件,
  //   断言 onSelect 收到的项目 —— 用户可观察到的是「回车选中了哪一个项目」。
  // - Bug／规则依据：#11653。方向键此前完全未绑定,回车写死取过滤结果首项,
  //   目标不排第一时只能改用鼠标点击。
  // - 现有覆盖缺口：原有用例只覆盖「回车取第一个匹配」,没有多结果下的选择路径。
  // - 最小失败输入：搜索 'cindy' 命中三项后按 ArrowDown 再按 Enter,修复前仍选中第一项。
  // - tier：unit（jsdom + testing-library,进程内组件入口,无真实资源）。
  it('moves the highlight with ArrowDown and picks it on Enter', async () => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);
    const rowOf = (name: string) =>
      screen.getByText(name).closest('[data-folder-picker-index]') as HTMLElement;
    // 高亮用语义状态断言:样式随时可以改,aria-selected 才是读屏和键盘共用的契约。
    const isSelected = (name: string) => rowOf(name).getAttribute('aria-selected') === 'true';

    fireEvent.change(input, { target: { value: 'cindy' } });
    // 'cindy' 命中 cindy / cindy-server / cindy-official-plugins:输入后默认指向首项。
    expect(isSelected('cindy')).toBe(true);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // 下移后选中状态跟到第二项,首项不再选中。
    expect(isSelected('cindy-server')).toBe(true);
    expect(isSelected('cindy')).toBe(false);

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onSelect).toHaveBeenCalledWith(manyProjects[1].path, 'project', manyProjects[1]);
  });

  it('moves the highlight back up with ArrowUp', async () => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);

    fireEvent.change(input, { target: { value: 'cindy' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(onSelect).toHaveBeenCalledWith(manyProjects[1].path, 'project', manyProjects[1]);
  });

  it.each([
    // 'cindy' 命中 3 项;越界按键不应把高亮推出可见范围。
    { name: 'stops above the first result', key: 'ArrowUp', presses: 1, expected: 0 },
    { name: 'stops at the last filtered result', key: 'ArrowDown', presses: 5, expected: 2 },
  ])('$name', async ({ key, presses, expected }) => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);

    fireEvent.change(input, { target: { value: 'cindy' } });
    for (let i = 0; i < presses; i += 1) {
      fireEvent.keyDown(input, { key });
    }
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    const target = manyProjects[expected];
    expect(onSelect).toHaveBeenCalledWith(target.path, 'project', target);
  });

  it('resets the highlight to the first result when the query changes', async () => {
    const { onSelect } = renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);

    fireEvent.change(input, { target: { value: 'cindy' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'c' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    // 换查询后高亮回到第一项,不应延续上一次的位置。
    expect(onSelect).toHaveBeenCalledWith(manyProjects[0].path, 'project', manyProjects[0]);
  });

  // 读屏用户看不到背景色:高亮必须同时通过 aria-activedescendant 暴露给辅助技术。
  // 每行包含独立操作,通过 grid 暴露选择与删除,不能放进会压平后代语义的 option。
  it('exposes the highlighted project through the combobox', () => {
    renderPicker(manyProjects);
    const input = screen.getByPlaceholderText(SEARCH);
    const rowOf = (name: string) =>
      screen.getByText(name).closest('[data-folder-picker-index]') as HTMLElement;

    fireEvent.change(input, { target: { value: 'cindy' } });

    const grid = screen.getByRole('grid', { name: 'newChat.folderPicker.projects' });
    expect(input.getAttribute('aria-controls')).toBe(grid.id);
    expect(input.getAttribute('aria-haspopup')).toBe('grid');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(rowOf('cindy').getAttribute('role')).toBe('row');

    // 默认指向首项。
    expect(input.getAttribute('aria-activedescendant')).toBe(
      within(rowOf('cindy')).getAllByRole('gridcell')[0].id,
    );
    expect(rowOf('cindy').getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(
      within(rowOf('cindy-server')).getAllByRole('gridcell')[0].id,
    );
    expect(rowOf('cindy-server').getAttribute('aria-selected')).toBe('true');
    expect(rowOf('cindy').getAttribute('aria-selected')).toBe('false');
  });

  // 测试价值：PR #11675 review r4639609510 指出 option 会压平行内按钮语义。
  // 旧测试只检查选中属性,未覆盖独立删除操作；最小输入为一行项目及默认允许的删除按钮。
  // unit：渲染真实组件,检查对外 ARIA 契约与删除效果,无真实持久化。
  it('exposes selection and removal as independent actions in grid cells', () => {
    const { onSelect, onOpenChange } = renderPicker(manyProjects);
    const row = screen.getByText('cindy').closest('[data-folder-picker-index]') as HTMLElement;
    const cells = within(row).getAllByRole('gridcell');
    expect(cells).toHaveLength(2);
    expect(within(cells[0]).getByRole('button', { name: /cindy/ })).toBeTruthy();
    const remove = within(cells[1]).getByRole('button', {
      name: 'newChat.folderPicker.removeFromList',
    });
    expect(remove.closest('[role="option"]')).toBeNull();

    fireEvent.click(remove);
    expect(recentWorkdirsStore.remove).toHaveBeenCalledWith(manyProjects[0].path);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('navigates row actions with arrows and returns to search with Escape', () => {
    renderPicker(manyProjects);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'cindy' } });
    const rows = screen.getAllByRole('row');
    const firstSelect = within(rows[0]).getByRole('button', { name: /cindy/ });
    const secondSelect = within(rows[1]).getByRole('button', { name: /cindy-server/ });
    const firstRemove = within(rows[0]).getByRole('button', {
      name: 'newChat.folderPicker.removeFromList',
    });
    const secondRemove = within(rows[1]).getByRole('button', {
      name: 'newChat.folderPicker.removeFromList',
    });
    act(() => firstSelect.focus());
    fireEvent.keyDown(firstSelect, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(firstRemove);
    expect(firstRemove.tabIndex).toBe(0);
    expect(firstSelect.tabIndex).toBe(-1);
    fireEvent.keyDown(firstRemove, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(secondRemove);
    fireEvent.keyDown(secondRemove, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(secondSelect);
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(rows[0].getAttribute('aria-selected')).toBe('false');
    fireEvent.keyDown(secondSelect, { key: 'Escape' });
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe('cindy');
  });

  it('keeps navigation within available cells when removal is disabled', () => {
    renderPicker(manyProjects, false);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'cindy' } });
    const rows = screen.getAllByRole('row');
    expect(within(rows[0]).getAllByRole('gridcell')).toHaveLength(1);
    const buttons = rows.map((row) => within(row).getByRole('button'));
    act(() => buttons[0].focus());
    fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'End', ctrlKey: true });
    expect(document.activeElement).toBe(buttons[2]);
    fireEvent.keyDown(buttons[2], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[2]);
    fireEvent.keyDown(buttons[2], { key: 'Home', ctrlKey: true });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'ArrowDown', isComposing: true });
    expect(document.activeElement).toBe(buttons[0]);
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
