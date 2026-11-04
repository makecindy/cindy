// @vitest-environment jsdom
/**
 * 「+」面板「添加目录」二级页：经真实组件入口验证最近目录列表的去留、返回主面板的键盘约定，
 * 以及 Main 拒绝授权时留在本页并提示(不能静默失败或把面板关掉)。
 * Tier: unit(jsdom，最近目录数据源以 hook mock 注入)。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
