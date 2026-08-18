// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';

import tailwindConfig from '../../../../../../../tailwind.config';
import { BrowserChrome, type BrowserChromeHandle } from '../BrowserChrome';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Radix DropdownMenu 在 jsdom 下的 pointer 交互不可靠(hasPointerCapture 等未实现),
// 沿用仓库既定测试模式:mock 成始终展开的直通组件,Item 渲染成普通 <button>,
// 把 Radix 的 onSelect 映射到 onClick、透传 disabled —— 这样能直接断言菜单项的
// 可用性与回调,不依赖真实菜单开合。
vi.mock('@/components/ui/dropdown-menu', () => {
  const react = require('react') as typeof import('react');
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      react.createElement('div', null, children),
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled,
    }: {
      children: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) =>
      react.createElement(
        'button',
        { type: 'button', disabled, onClick: () => onSelect?.() },
        children,
      ),
  };
});

function renderChrome(
  url = 'https://www.taptap.cn/',
  extra: {
    commentSupported?: boolean;
    canOpenInSystemBrowser?: boolean;
    isLoading?: boolean;
    canGoBack?: boolean;
    canGoForward?: boolean;
    commentActive?: boolean;
    onReload?: () => void;
    onStop?: () => void;
  } = {},
) {
  const onNavigate = vi.fn();
  const onOpenInSystemBrowser = vi.fn();
  const onCopyLink = vi.fn();
  const ref = createRef<BrowserChromeHandle>();
  render(
    createElement(BrowserChrome, {
      ref,
      url,
      isLoading: extra.isLoading ?? false,
      canGoBack: extra.canGoBack ?? false,
      canGoForward: extra.canGoForward ?? false,
      onNavigate,
      onReload: extra.onReload ?? vi.fn(),
      onStop: extra.onStop ?? vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      onCaptureScreenshot: vi.fn(),
      commentActive: extra.commentActive ?? false,
      onToggleComment: vi.fn(),
      onOpenInSystemBrowser,
      onCopyLink,
      commentSupported: extra.commentSupported,
      canOpenInSystemBrowser: extra.canOpenInSystemBrowser ?? true,
    }),
  );
  return { onNavigate, onOpenInSystemBrowser, onCopyLink, ref };
}

describe('BrowserChrome', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('submits Ctrl+Enter once and suppresses the following blur submit', () => {
    const { onNavigate } = renderChrome();

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn/' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.blur(input);

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('https://www.google.com');
  });

  it('renders the page-comment button by default (commentSupported defaults to true)', () => {
    renderChrome();
    expect(screen.getByRole('button', { name: 'rightSidebar.browser.comment' })).toBeTruthy();
  });

  it('describes exiting comment mode while the page-comment tool is active', () => {
    renderChrome('https://www.taptap.cn/', { commentActive: true });

    expect(
      screen.getByRole('button', { name: 'rightSidebar.browser.exitCommentMode' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'rightSidebar.browser.comment' })).toBeNull();
  });

  it('hides the page-comment button when commentSupported is false (detached sidebar window has no composer)', () => {
    renderChrome('https://www.taptap.cn/', { commentSupported: false });
    expect(screen.queryByRole('button', { name: 'rightSidebar.browser.comment' })).toBeNull();
  });

  it('shows a compositor-friendly refresh animation while loading and stops on click', () => {
    const onReload = vi.fn();
    const onStop = vi.fn();
    renderChrome('https://www.taptap.cn/', {
      isLoading: true,
      onReload,
      onStop,
    });

    const button = screen.getByRole('button', { name: 'rightSidebar.browser.stop' });
    const spinner = button.querySelector('span');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(spinner?.classList.contains('animate-spinner')).toBe(true);
    expect(spinner?.classList.contains('animate-spin')).toBe(false);
    expect(spinner?.classList.contains('motion-reduce:hidden')).toBe(true);
    expect(button.querySelector('.lucide-rotate-cw')).toBeTruthy();
    expect(
      button
        .querySelector('.lucide-x')
        ?.parentElement?.classList.contains('motion-reduce:inline-flex'),
    ).toBe(true);

    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledOnce();
    expect(onReload).not.toHaveBeenCalled();
  });

  it('keeps the idle refresh icon static and reloads on click', () => {
    const onReload = vi.fn();
    const onStop = vi.fn();
    renderChrome('https://www.taptap.cn/', { onReload, onStop });

    const button = screen.getByRole('button', { name: 'rightSidebar.browser.reload' });
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.querySelector('span')?.classList.contains('animate-spinner')).toBe(false);

    fireEvent.click(button);
    expect(onReload).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('explains why back and forward navigation are unavailable', () => {
    renderChrome();

    expect(
      screen
        .getByRole('button', { name: 'rightSidebar.browser.goBackUnavailable' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen
        .getByRole('button', { name: 'rightSidebar.browser.goForwardUnavailable' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('uses action labels when back and forward navigation are available', () => {
    renderChrome('https://www.taptap.cn/', { canGoBack: true, canGoForward: true });

    expect(screen.getByRole('button', { name: 'rightSidebar.browser.goBack' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'rightSidebar.browser.goForward' })).toBeTruthy();
  });

  it('routes the refresh spinner through the approved semantic cycle token', () => {
    const animation = (
      tailwindConfig.theme?.extend?.animation as Record<string, string> | undefined
    )?.spinner;

    expect(animation).toContain('var(--motion-spinner-cycle, 1000ms)');
    expect(animation).not.toContain('--motion-enter');
    expect(animation).not.toContain('spin 1s');
  });

  it('fires open-in-system-browser and copy-link from the more menu when the link is valid', () => {
    const { onOpenInSystemBrowser, onCopyLink } = renderChrome();

    fireEvent.click(
      screen.getByRole('button', { name: 'rightSidebar.browser.openInSystemBrowser' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.browser.copyLink' }));

    expect(onOpenInSystemBrowser).toHaveBeenCalledTimes(1);
    expect(onCopyLink).toHaveBeenCalledTimes(1);
  });

  it('disables both more-menu items when there is no valid link (about:blank new tab)', () => {
    const { onOpenInSystemBrowser, onCopyLink } = renderChrome('about:blank');

    const openItem = screen.getByRole('button', {
      name: 'rightSidebar.browser.openInSystemBrowser',
    }) as HTMLButtonElement;
    const copyItem = screen.getByRole('button', {
      name: 'rightSidebar.browser.copyLink',
    }) as HTMLButtonElement;

    expect(openItem.disabled).toBe(true);
    expect(copyItem.disabled).toBe(true);

    // disabled 的 <button> 在 jsdom 里点击不触发 onClick —— 断言回调没被调。
    fireEvent.click(openItem);
    fireEvent.click(copyItem);
    expect(onOpenInSystemBrowser).not.toHaveBeenCalled();
    expect(onCopyLink).not.toHaveBeenCalled();
  });

  it('disables system-browser opening when the host has no safe opener for the URL', () => {
    const { onOpenInSystemBrowser, onCopyLink } = renderChrome('file:///tmp/notes.md', {
      canOpenInSystemBrowser: false,
    });

    const openItem = screen.getByRole('button', {
      name: 'rightSidebar.browser.openInSystemBrowser',
    }) as HTMLButtonElement;
    const copyItem = screen.getByRole('button', {
      name: 'rightSidebar.browser.copyLink',
    }) as HTMLButtonElement;

    expect(openItem.disabled).toBe(true);
    expect(copyItem.disabled).toBe(false);
  });
});
