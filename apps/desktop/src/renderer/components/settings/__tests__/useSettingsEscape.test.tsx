/**
 * 设置页 Esc 逐层返回（#5845）：无人认领的 Esc 退出设置；搜索清空、快捷键录制、
 * 弹窗 / 菜单、插件详情、帮助面板与输入法组字先认领，输入框第一下只失焦。
 * @vitest-environment jsdom
 */
import * as Dialog from '@radix-ui/react-dialog';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TAB_IDS } from '@/lib/tabLabels';
import { PluginDetailTopBar } from '@/features/plugin/PluginDetailTopBar';
import { PluginManagementLayout } from '@/features/plugin/PluginManagementLayout';
import { SettingsSidebarNav } from '../SettingsSidebarNav';
import { useSettingsEscape } from '../useSettingsEscape';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({ 'settings.search.ariaLabel': 'Search settings' })[key] ?? key,
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function Harness({
  onEscape,
  enabled = true,
  children,
}: {
  onEscape: () => void;
  enabled?: boolean;
  children?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useSettingsEscape(rootRef, enabled, onEscape);
  return (
    <div ref={rootRef} role="main">
      <button type="button">Tab</button>
      <input aria-label="Field" />
      {children}
    </div>
  );
}

function pressEscape(target: EventTarget = document.body, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('useSettingsEscape', () => {
  it('exits settings when Escape is unclaimed with nothing or a settings control focused', () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);

    expect(pressEscape().defaultPrevented).toBe(true);
    pressEscape(screen.getByRole('button', { name: 'Tab' }));

    expect(onEscape).toHaveBeenCalledTimes(2);
  });

  it('leaves a focused settings field on the first Escape and exits on the second', () => {
    const onEscape = vi.fn();
    const onBlur = vi.fn();
    render(
      <Harness onEscape={onEscape}>
        <input aria-label="Saved on blur" onBlur={onBlur} />
      </Harness>,
    );
    const field = screen.getByRole('textbox', { name: 'Saved on blur' });
    field.focus();

    expect(pressEscape(field).defaultPrevented).toBe(true);
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
    expect(onEscape).not.toHaveBeenCalled();

    pressEscape();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('clears a non-empty settings search first, then leaves the field, then exits', () => {
    const onEscape = vi.fn();
    render(
      <Harness onEscape={onEscape}>
        <SettingsSidebarNav tabIds={TAB_IDS} activeTab="general" onSelectTab={vi.fn()} />
      </Harness>,
    );
    const search = screen.getByRole('combobox', { name: 'Search settings' }) as HTMLInputElement;
    search.focus();
    fireEvent.change(search, { target: { value: 'theme' } });

    pressEscape(search);
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);

    pressEscape(search);
    expect(document.activeElement).toBe(document.body);
    expect(onEscape).not.toHaveBeenCalled();

    pressEscape();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('clears a non-empty plugin search first, then leaves the field, then exits', () => {
    const onEscape = vi.fn();
    function PluginSearch() {
      const [query, setQuery] = useState('calendar');
      return (
        <PluginManagementLayout
          activeTab="plugins"
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Search plugins"
          clearSearchLabel="Clear plugin search"
        >
          <span>Plugins</span>
        </PluginManagementLayout>
      );
    }
    render(
      <MemoryRouter>
        <Harness onEscape={onEscape}>
          <PluginSearch />
        </Harness>
      </MemoryRouter>,
    );
    const search = screen.getByRole('textbox', { name: 'Search plugins' }) as HTMLInputElement;
    search.focus();

    pressEscape(search);
    expect(search.value).toBe('');
    expect(document.activeElement).toBe(search);
    // 按住不放：连发既不失焦也不退出。
    pressEscape(search, { repeat: true });
    expect(document.activeElement).toBe(search);

    pressEscape(search);
    expect(document.activeElement).not.toBe(search);
    expect(onEscape).not.toHaveBeenCalled();

    pressEscape();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('lets an open dialog close before settings handles Escape', () => {
    const onEscape = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <Harness onEscape={onEscape}>
        <Dialog.Root open onOpenChange={onOpenChange}>
          <Dialog.Portal>
            <Dialog.Content aria-describedby={undefined}>
              <Dialog.Title>Nested</Dialog.Title>
              <button type="button">Inside dialog</button>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </Harness>,
    );

    pressEscape(screen.getByRole('button', { name: 'Inside dialog' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('lets an open plugin detail page go back to its list first', () => {
    vi.stubGlobal('electronAPI', {
      platform: 'darwin',
      getFullscreenState: () => Promise.resolve(false),
      onFullscreenChange: () => () => {},
    });
    const onEscape = vi.fn();
    const onBack = vi.fn();
    // 详情页晚于设置页挂载（真实路径：先进设置，再点开插件），监听注册顺序不能决定归属。
    const { rerender } = render(<Harness onEscape={onEscape} />);
    rerender(
      <Harness onEscape={onEscape}>
        <PluginDetailTopBar label="Plugins" onBack={onBack} scrolled={false} />
      </Harness>,
    );

    pressEscape();

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('does not let a held Escape auto-repeat past the layer its first press closed', () => {
    vi.stubGlobal('electronAPI', {
      platform: 'darwin',
      getFullscreenState: () => Promise.resolve(false),
      onFullscreenChange: () => () => {},
    });
    const onEscape = vi.fn();
    const onBack = vi.fn();
    const { rerender } = render(<Harness onEscape={onEscape} />);
    rerender(
      <Harness onEscape={onEscape}>
        <PluginDetailTopBar label="Plugins" onBack={onBack} scrolled={false} />
      </Harness>,
    );

    pressEscape();
    expect(onBack).toHaveBeenCalledTimes(1);
    rerender(<Harness onEscape={onEscape} />);

    pressEscape(document.body, { repeat: true });
    pressEscape(document.body, { repeat: true });
    expect(onEscape).not.toHaveBeenCalled();

    pressEscape();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('yields to a layer outside settings, an open morph popover and the help panel', () => {
    const onEscape = vi.fn();
    const { rerender } = render(<Harness onEscape={onEscape} />);

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    pressEscape(outside);
    outside.remove();

    const morphPanel = document.createElement('div');
    morphPanel.setAttribute('data-morph-side', 'bottom');
    document.body.appendChild(morphPanel);
    pressEscape();
    morphPanel.remove();

    rerender(<Harness onEscape={onEscape} enabled={false} />);
    pressEscape();

    expect(onEscape).not.toHaveBeenCalled();
  });

  it.each([
    ['isComposing', { isComposing: true }],
    ['IME keyCode 229', { keyCode: 229 }],
    ['auto-repeat', { repeat: true }],
    ['altKey', { altKey: true }],
    ['ctrlKey', { ctrlKey: true }],
    ['metaKey', { metaKey: true }],
    ['shiftKey', { shiftKey: true }],
  ] as const)('ignores Escape carrying %s', (_label, init) => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    const field = screen.getByRole('textbox', { name: 'Field' });
    field.focus();

    pressEscape(field, init);
    pressEscape(document.body, init);

    expect(document.activeElement).toBe(field);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('ignores Escape already consumed by an inner handler', () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    const consumed = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    consumed.preventDefault();

    act(() => {
      document.body.dispatchEvent(consumed);
    });

    expect(onEscape).not.toHaveBeenCalled();
  });
});
