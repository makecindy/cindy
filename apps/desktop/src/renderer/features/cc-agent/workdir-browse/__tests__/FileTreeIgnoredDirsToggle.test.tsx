// @vitest-environment jsdom

/**
 * FileTreeIgnoredDirsToggle — 文件树标题行的「显示被忽略的目录」开关。
 *
 * 锁的不变量:
 *   - 默认关:aria-pressed=false,文案说**下一步动作**(显示),与 DESIGN.md §14.6
 *     "stateful controls describe the action that will happen next" 一致;
 *   - 点击翻转偏好,并把 override 落进 localStorage(规则 20:改回默认即清除);
 *   - 按下状态有持久底色(不是只在 hover 时可见),否则用户无法判断当前是开是关;
 *   - 有 Tip(tooltip)与 aria-label 两个标签(§14.6 图标控件的交付合同)。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FileTreeIgnoredDirsToggle } from '../FileTreeIgnoredDirsToggle';
import { _resetFileBrowserPreferenceForTests } from '@/hooks/useFileBrowserPreference';

const KEY = 'fileBrowser.showIgnoredDirs';
const SHOW_LABEL = 'ccAgent.workdirBrowse.treeAction.showIgnoredDirs';
const HIDE_LABEL = 'ccAgent.workdirBrowse.treeAction.hideIgnoredDirs';

function button(): HTMLElement {
  return screen.getByRole('button', { name: SHOW_LABEL });
}

describe('FileTreeIgnoredDirsToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetFileBrowserPreferenceForTests();
  });

  afterEach(() => cleanup());

  it('默认关:aria-pressed=false,label 是「显示被忽略的目录」', () => {
    render(<FileTreeIgnoredDirsToggle />);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().getAttribute('aria-label')).toBe(SHOW_LABEL);
  });

  it('点击打开:写 override、翻成 pressed、label 换成「隐藏」', () => {
    render(<FileTreeIgnoredDirsToggle />);
    fireEvent.click(button());

    expect(localStorage.getItem(KEY)).toBe('true');
    const pressed = screen.getByRole('button', { name: HIDE_LABEL });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
  });

  it('再点一次回到默认:清除 override(不写默认值快照)', () => {
    localStorage.setItem(KEY, 'true');
    render(<FileTreeIgnoredDirsToggle />);
    fireEvent.click(screen.getByRole('button', { name: HIDE_LABEL }));

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('按下态有持久底色;未按下只有 hover 底色', () => {
    const { unmount } = render(<FileTreeIgnoredDirsToggle />);
    expect(button().className).toContain('hover:bg-sidebar-item-active');
    expect(button().className).not.toMatch(/(?:^|\s)bg-sidebar-item-active/);
    unmount();

    localStorage.setItem(KEY, 'true');
    _resetFileBrowserPreferenceForTests();
    render(<FileTreeIgnoredDirsToggle />);
    expect(screen.getByRole('button', { name: HIDE_LABEL }).className).toMatch(
      /(?:^|\s)bg-sidebar-item-active/,
    );
  });
});

/**
 * 接线守卫:开关必须出现在**每个**文件树宿主的标题行里,且与
 * 「搜索 / 收起 / 刷新」并列(文本顺序在搜索之后、收起之前) —— 用户就是在这
 * 里发现目录被隐藏的,偏好不能只能从设置页改。
 *
 * 只断言「每个宿主文件内存在」与相对位置,不断言总调用点个数(计数式断言会把
 * 「必须重复」写成不变量,见 DESIGN.md §14 的守卫元规则)。
 */
describe('FileTreeIgnoredDirsToggle 接线', () => {
  const hosts = [
    ['RSB 文件浏览器', ['features', 'right-sidebar', 'plugins', 'file-browser', 'FileBrowserBody.tsx']],
    ['doc 模式侧栏', ['features', 'cc-agent', 'workdir-browse', 'WorkdirBrowseSidebar.tsx']],
  ] as const;

  it.each(hosts)('%s 的标题行挂着开关,位置紧跟搜索按钮', (_name, segments) => {
    const source = readFileSync(resolve(__dirname, '..', '..', '..', '..', ...segments), 'utf8');
    const toggleAt = source.indexOf('<FileTreeIgnoredDirsToggle />');
    const searchAt = source.indexOf("'ccAgent.workdirBrowse.searchPanel.searchFiles'");
    const collapseAt = source.indexOf("'ccAgent.workdirBrowse.treeAction.collapseAll'");

    expect(toggleAt).toBeGreaterThan(-1);
    expect(searchAt).toBeGreaterThan(-1);
    expect(collapseAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeGreaterThan(searchAt);
    expect(toggleAt).toBeLessThan(collapseAt);
  });

  /**
   * 几何守卫:这行里的每个图标钮都拿共享常量,不各自写圆角。
   *
   * 起因:开关最初只给自己写了 pill,三个存量按钮各自写 `rounded-md`(6px),
   * 同一行就出现两种圆角。以后无论谁在这行加按钮,只能拿到同一个值。
   */
  it.each(hosts)('%s 的标题行图标钮全部走共享类名常量', (_name, segments) => {
    const source = readFileSync(resolve(__dirname, '..', '..', '..', '..', ...segments), 'utf8');
    expect(source).toContain('FILE_TREE_HEADER_ICON_BUTTON_CLASS');
    // 这行不再自己写圆角(只剩标题触发器与下拉项等非本行成员)。
    expect(source).not.toMatch(/className="flex size-5 items-center justify-center rounded-/);
  });
});
