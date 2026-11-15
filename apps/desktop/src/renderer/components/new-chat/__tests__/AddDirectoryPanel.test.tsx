// @vitest-environment jsdom
/**
 * 「+」面板「添加目录」二级页：经真实组件入口验证最近目录列表的去留、返回主面板的键盘约定，
 * 以及 Main 拒绝授权时留在本页并提示(不能静默失败或把面板关掉)。
 * Tier: unit(jsdom，最近目录数据源以 hook mock 注入)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MorphPopover } from '@/components/ui/morph-popover';
import type { FolderPickerOption } from '../FolderPickerPopover';

const h = vi.hoisted(() => ({ options: [] as FolderPickerOption[] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useProjectPickerOptions', () => ({ useProjectPickerOptions: () => h.options }));

import { AddDirectoryPanel } from '../AddDirectoryPanel';

const dir = (name: string, extra: Partial<FolderPickerOption> = {}): FolderPickerOption => ({
  path: `/work/${name}`,
  name,
  description: `/work/${name}`,
  ...extra,
});

function renderPanel(overrides: Partial<Parameters<typeof AddDirectoryPanel>[0]> = {}) {
  const props = {
    addedDirs: ['/work/refs'],
    workingDir: '/work/app',
    onBack: vi.fn(),
    onSelectRecent: vi.fn(async () => {}),
    onBrowse: vi.fn(async () => {}),
    ...overrides,
  };
  render(<AddDirectoryPanel {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe('AddDirectoryPanel', () => {
  it('lists only directories that can still be added', () => {
    h.options = [
      dir('app'),
      dir('app/src'),
      dir('refs'),
      dir('gone', { missing: true }),
      dir('ai-gateway'),
    ];
    renderPanel();
    expect(screen.getByText('ai-gateway')).toBeTruthy();
    for (const hidden of ['app', 'app/src', 'refs', 'gone']) {
      expect(screen.queryByText(hidden)).toBeNull();
    }
  });

  it('goes back to the main panel on Backspace only when the search box is empty', () => {
    h.options = ['a', 'b', 'c', 'd', 'e'].map((name) => dir(name));
    const { onBack } = renderPanel();
    const search = screen.getByLabelText('extraDirs.searchRecent');
    fireEvent.change(search, { target: { value: 'c' } });
    fireEvent.keyDown(search, { key: 'Backspace' });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.keyDown(search, { key: 'Backspace' });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // PR #8602 review：Tab 聚焦某行后按方向键，真实焦点要跟着高亮走，回车才加高亮的那一行。
  it('moves real focus with the arrow keys once a row has focus', () => {
    h.options = [dir('ai-gateway'), dir('work-docs')];
    renderPanel();
    const first = screen.getByText('ai-gateway').closest('button')!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('work-docs').closest('button'));
  });

  it('stays on the page with an error when the directory cannot be authorized', async () => {
    h.options = [dir('ai-gateway')];
    const onSelectRecent = vi.fn(async () => {
      throw new Error('[WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED] not recent');
    });
    const { onBack } = renderPanel({ onSelectRecent });
    await act(async () => {
      fireEvent.click(screen.getByText('ai-gateway'));
    });
    expect(onSelectRecent).toHaveBeenCalledWith(h.options[0]);
    expect(screen.getByRole('alert').textContent).toContain('extraDirs.addFailed');
    expect(screen.getByText('ai-gateway')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();
  });

  // #9536 / #9573：目录很多时，外壳不滚，列表必须接过外壳的确定高度，否则底部被裁掉。
  // 生产入口：AddDirectoryPanel 嵌进 MorphPopover。旧断言只看 class 字面量，裁切也会过。
  // 最小输入：外壳上限 240，内容自然高 400。外壳 overflow 为 hidden，内滚根高度等于 240，
  // 目录列表是内滚根里唯一的滚动区，标题和「选择其他文件夹」不在这个滚动区里。Tier: unit。
  it('目录很多时外壳不滚，列表接过外壳的确定高度', async () => {
    h.options = Array.from({ length: 20 }, (_, index) => dir(`dir-${index}`));
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'group' ? 400 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 800, 120, 30));
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      })),
    });

    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <MorphPopover
          open={open}
          onOpenChange={setOpen}
          panelWidth={480}
          maxContentHeight={240}
          panelAriaLabel="Add directory"
          trigger={<span />}
        >
          <AddDirectoryPanel
            addedDirs={[]}
            workingDir="/work/app"
            onBack={() => {}}
            onSelectRecent={async () => {}}
            onBrowse={async () => {}}
          />
        </MorphPopover>
      );
    }

    render(<Host />);
    const panel = await screen.findByRole('group', { name: 'Add directory' });
    const shell = panel.firstElementChild as HTMLElement;
    await waitFor(() => {
      expect(panel.style.height).toBe('240px');
      expect(shell.style.overflowY).toBe('hidden');
    });
    const inner = shell.querySelector('[data-morph-scroll="inner"]') as HTMLElement;
    expect(inner.style.height).toBe('240px');
    const list = screen.getByRole('list', { name: 'newChat.folderPicker.recent' });
    expect(inner.contains(list)).toBe(true);
    expect(list.contains(screen.getByText('extraDirs.addTitle'))).toBe(false);
    expect(list.contains(screen.getByText('newChat.folderPicker.browseFolder'))).toBe(false);
    expect(screen.getByText('dir-19').closest('button')?.className).toContain('shrink-0');
  });
});
