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
const UNSUPPORTED_LABEL = 'ccAgent.workdirBrowse.treeAction.showIgnoredDirsUnsupported';

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

  /**
   * 被控端不支持(device-link 连到老 Desktop,它的 listDir 会静默忽略
   * showIgnoredDirs):开关不能装成"按下去就生效"。禁用 + 说明原因,并且点击
   * 不改全局偏好。
   */
  describe('unsupported', () => {
    it('压不下去:aria-disabled + pressed=false + 原因文案,点击不改偏好', () => {
      render(<FileTreeIgnoredDirsToggle unsupported />);
      const el = screen.getByRole('button', { name: UNSUPPORTED_LABEL });

      expect(el.getAttribute('aria-disabled')).toBe('true');
      expect(el.getAttribute('aria-pressed')).toBe('false');
      expect(el.className).toContain('cursor-not-allowed');

      fireEvent.click(el);
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('偏好已开启也按「关」展示(这个视图确实不会显示被忽略目录)', () => {
      localStorage.setItem(KEY, 'true');
      _resetFileBrowserPreferenceForTests();
      render(<FileTreeIgnoredDirsToggle unsupported />);

      const el = screen.getByRole('button', { name: UNSUPPORTED_LABEL });
      expect(el.getAttribute('aria-pressed')).toBe('false');
      // 全局偏好本身不被改写 —— 切回本地会话仍然是开着的。
      expect(localStorage.getItem(KEY)).toBe('true');
    });
  });
});

/**
 * 接线守卫:开关必须出现在**每个**文件树宿主的标题行里,且与
 * 「搜索 / 收起 / 刷新」并列(文本顺序在搜索之后、收起之前) —— 用户就是在这
 * 里发现目录被隐藏的,偏好不能只能从设置页改。
 *
 * 只断言「每个宿主文件内存在」与相对位置，不断言总调用点个数（计数式断言会把
 * 「必须重复」写成不变量，见 DESIGN.md §14 的守卫元规则）。
 *
 * 2026-09 重构后两个宿主共用 FileTreeHeaderActions（此前各自复制一份，加开关时
 * 出现了两种圆角）。守卫因此分两层：
 *   1. 每个宿主确实挂了共享动作组；
 *   2. 共享动作组里开关存在、位置正确，且几何与可访问名只有一份实现。
 */
describe('FileTreeIgnoredDirsToggle 接线', () => {
  const hosts = [
    ['RSB 文件浏览器', ['features', 'right-sidebar', 'plugins', 'file-browser', 'FileBrowserBody.tsx']],
    ['doc 模式侧栏', ['features', 'cc-agent', 'workdir-browse', 'WorkdirBrowseSidebar.tsx']],
  ] as const;
  const sharedActions = [
    'features',
    'cc-agent',
    'workdir-browse',
    'FileTreeHeaderActions.tsx',
  ] as const;

  function readSource(segments: readonly string[]): string {
    return readFileSync(resolve(__dirname, '..', '..', '..', '..', ...segments), 'utf8');
  }

  it.each(hosts)('%s 的标题行挂着共享动作组', (_name, segments) => {
    expect(readSource(segments)).toContain('<FileTreeHeaderActions');
  });

  it('共享动作组里开关紧跟搜索按钮、先于收起按钮', () => {
    const source = readSource(sharedActions);
    const toggleAt = source.indexOf('<FileTreeIgnoredDirsToggle');
    const searchAt = source.indexOf("'ccAgent.workdirBrowse.searchPanel.searchFiles'");
    const collapseAt = source.indexOf("'ccAgent.workdirBrowse.treeAction.collapseAll'");

    expect(toggleAt).toBeGreaterThan(-1);
    expect(searchAt).toBeGreaterThan(-1);
    expect(collapseAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeGreaterThan(searchAt);
    expect(toggleAt).toBeLessThan(collapseAt);
  });

  /**
   * 几何守卫：这行里的每个图标钮都拿共享常量，不各自写圆角。
   *
   * 起因：开关最初只给自己写了 pill，三个存量按钮各自写 `rounded-md`(6px)，
   * 同一行就出现两种圆角。抽成共享动作组后，宿主里不应再出现自写的图标钮。
   */
  it('共享动作组的图标钮全部走共享类名常量', () => {
    expect(readSource(sharedActions)).toContain('FILE_TREE_HEADER_ICON_BUTTON_CLASS');
  });

  it.each(hosts)('%s 不再自己写标题行图标钮', (_name, segments) => {
    expect(readSource(segments)).not.toMatch(
      /className="flex size-5 items-center justify-center rounded-/,
    );
  });

  /**
   * 可访问名守卫（DESIGN.md §14.6）：纯图标控件的交付合同是**可见 Tip + 本地化
   * 可访问名**。共享动作组的按钮由 HeaderIconButton 统一产出，两个标签同源。
   */
  it('共享动作组的图标钮都带本地化 aria-label', () => {
    const source = readSource(sharedActions);
    const buttons = source
      .split('<button')
      .slice(1)
      .filter((block) => block.includes('FILE_TREE_HEADER_ICON_BUTTON_CLASS'));

    expect(buttons.length).toBeGreaterThan(0);
    for (const block of buttons) {
      expect(block.slice(0, block.indexOf('className'))).toContain('aria-label');
    }
  });
});
