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

  it('keeps fading the list itself while it scrolls independently in the ample state', () => {
    // 与上一条用例互补:那里全局 mock 让上半区溢出(渐隐落在外层容器);这里让上半区
    // 放得下(scrollHeight 300 < clientHeight 400)而列表自身可滚(392 > 252),
    // 渐隐应挂在列表上 —— 覆盖「充足态列表独立滚动渐隐」路径。
    const height = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-folder-picker-list') ? 392 : 300;
      });
    const client = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-folder-picker-list') ? 252 : 400;
      });
    try {
      renderPicker(manyProjects);
      const list = document.querySelector('[data-folder-picker-list]') as HTMLElement;
      // 上半区放得下:列表保留独立滚动标记与自滚动契约。
      expect(list.hasAttribute('data-folder-picker-scroll')).toBe(true);
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

  it('bounds the panel by the Radix available height and pins footer actions below one scroll region', () => {
    // jsdom 无法做真实布局,这里断的是契约:弹层整体受 --radix-popover-content-available-height
    // 约束且纵向 flex;顶部固定项(标题、「对话」、「项目」标签)与列表同在一个可收缩滚动区,
    // 放不下时一起向上滚走,搜索框 sticky 钉在滚动区顶部始终可见;底部「选择其他项目文件夹」
    // 「添加远程项目」在滚动区之外且不收缩 —— 窗口不够高时始终钉在弹层底部。
    const onAddRemoteProject = vi.fn();
    render(
      <FolderPickerPopover
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
        projectOptions={manyProjects}
        onAddRemoteProject={onAddRemoteProject}
      >
        <button type="button">trigger</button>
      </FolderPickerPopover>,
    );
    const content = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(content).toBeTruthy();
    expect(content.className).toContain('max-h-[var(--radix-popover-content-available-height)]');
    expect(content.className).toContain('flex-col');
    expect(content.className).toContain('overflow-hidden');

    // 上半区是唯一滚动容器:flex-1 吃富裕空间、min-h-0 允许收缩、overflow-y-auto 接管滚动。
    const upper = document.querySelector(
      '[data-folder-picker-scroll]:not([data-folder-picker-list])',
    ) as HTMLElement;
    expect(upper).toBeTruthy();
    expect(upper.className).toContain('flex-1');
    expect(upper.className).toContain('min-h-0');
    expect(upper.className).toContain('overflow-y-auto');
    // 键盘聚焦的 scroll-into-view 要让出 sticky 搜索框的高度,否则向上聚焦的行
    // 被它的不透明底遮住。
    expect(upper.className).toContain('scroll-pt-9');

    // 顶部固定项在滚动区内:空间不足时随列表一起向上滚走,不被裁在视口外。
    const dialogue = screen.getByText('newChat.folderPicker.dialogue').closest('button');
    expect(dialogue).toBeTruthy();
    expect(upper.contains(dialogue)).toBe(true);

    // 搜索框在滚动区内但 sticky 钉在容器顶:溢出态始终可见;不透明底与弹层同色,
    // 滚过的内容从它下面经过不透字。充足态容器不滚动,sticky 无效果。
    const search = screen.getByPlaceholderText(SEARCH);
    const searchWrap = search.closest('[data-folder-picker-search]') as HTMLElement;
    expect(searchWrap).toBeTruthy();
    expect(upper.contains(search)).toBe(true);
    expect(searchWrap.className).toContain('sticky');
    expect(searchWrap.className).toContain('top-0');
    expect(searchWrap.className).toContain('bg-[var(--folder-picker-bg)]');
    expect(searchWrap.className).toContain('z-10');

    // 列表在滚动区内,默认(空间充足)保持 252px 上限内的独立滚动外观。
    const list = document.querySelector('[data-folder-picker-list]') as HTMLElement;
    expect(list).toBeTruthy();
    expect(upper.contains(list)).toBe(true);
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('max-h-[252px]');
    expect(list.className).toContain('min-h-0');

    // 底部操作项在滚动区外且不收缩:可用高度再小也完整钉在弹层底部。
    const browse = screen.getByText('newChat.folderPicker.browseProjectFolder').closest('button');
    const addRemote = screen.getByText('newChat.projectPicker.addRemoteProject').closest('button');
    for (const item of [browse, addRemote]) {
      expect(item).toBeTruthy();
      expect(item?.className).toContain('shrink-0');
      expect(upper.contains(item)).toBe(false);
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
