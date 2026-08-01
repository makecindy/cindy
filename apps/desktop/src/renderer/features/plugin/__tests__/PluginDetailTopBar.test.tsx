/**
 * Regression coverage for the Plugin detail sticky top bar.
 *
 * 这条顶栏是 mac 上插件详情页的窗口拖拽区(通用 ContentHeader 在「侧栏展开 +
 * 无注入内容 + 无右栏」时整条隐藏);Windows / Linux 的通用 header 常驻,拖拽
 * 区归它。本文件锁住这个平台分流与顶栏的吸顶几何。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginDetailTopBar, usePluginDetailScrolled } from '../PluginDetailTopBar';

/** jsdom 下 `-webkit-app-region` 只能从 React 写进 style 对象的驼峰键读回。 */
function appRegionOf(element: HTMLElement): string {
  return (element.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'electronAPI');
});

function stubPlatform(platform: 'darwin' | 'win32' | 'linux') {
  vi.stubGlobal('electronAPI', {
    platform,
    getFullscreenState: () => Promise.resolve(false),
    onFullscreenChange: () => () => {},
  });
}

/** 滚动容器 + 顶栏的最小宿主，复刻两个详情视图的接线方式。 */
function Harness({ onBack = () => {} }: { onBack?: () => void }) {
  const { scrolled, onScroll } = usePluginDetailScrolled();
  return (
    <main data-testid="scroll-frame" onScroll={onScroll}>
      <PluginDetailTopBar label="Back" onBack={onBack} scrolled={scrolled} />
    </main>
  );
}

describe('PluginDetailTopBar', () => {
  it('carries the window drag region on macOS and keeps the back button clickable', () => {
    stubPlatform('darwin');
    const onBack = vi.fn();

    render(<Harness onBack={onBack} />);

    const bar = screen.getByTestId('plugin-detail-top-bar');
    expect(appRegionOf(bar)).toBe('drag');

    // Electron 的挖洞只在 drag 元素自身后代上生效(ContentHeader.tsx /
    // FileTabsBar.tsx 都记过这条),所以返回按钮必须落在本行内部。
    const back = screen.getByRole('button', { name: 'Back' });
    expect(bar.contains(back)).toBe(true);
    expect(appRegionOf(back)).toBe('no-drag');

    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it.each(['win32', 'linux'] as const)(
    'leaves the drag region to the shared ContentHeader on %s',
    (platform) => {
      stubPlatform(platform);

      render(<Harness />);

      const bar = screen.getByTestId('plugin-detail-top-bar');
      expect(appRegionOf(bar)).toBe('');
    },
  );

  it.each(['win32', 'linux'] as const)(
    'leaves the top separator to the shared ContentHeader on %s',
    (platform) => {
      stubPlatform(platform);

      render(<Harness />);

      // 这两端 ContentHeader 常驻且自带 border-b(--titlebar-border 与
      // --border-default 同值),本行只留实底,顶部分隔由那条下边框承担。
      const bar = screen.getByTestId('plugin-detail-top-bar');
      expect(bar.className).not.toContain('after:');

      const frame = screen.getByTestId('scroll-frame');
      Object.defineProperty(frame, 'scrollTop', { value: 24, configurable: true });
      fireEvent.scroll(frame);
      expect(bar.className).toContain('bg-[var(--surface)]');
      expect(bar.className).not.toContain('after:');
    },
  );

  it.each(['darwin', 'win32', 'linux'] as const)('sticks to the top on %s', (platform) => {
    stubPlatform(platform);

    render(<Harness />);

    // 吸顶三端一致,返回入口常驻;平台分流只作用于 drag。
    const bar = screen.getByTestId('plugin-detail-top-bar');
    expect(bar.className).toContain('sticky');

    const frame = screen.getByTestId('scroll-frame');
    Object.defineProperty(frame, 'scrollTop', { value: 24, configurable: true });
    fireEvent.scroll(frame);
    expect(bar.className).toContain('bg-[var(--surface)]');
  });

  it('matches the catalog header height at regular pane widths', () => {
    stubPlatform('darwin');

    render(<Harness />);

    // 列表与详情是同一条顶栏的两个状态,几何取自 PluginManagementLayout.tsx
    // 的 PluginManagementHeader(h-16 + flex h-full items-center)。列表页在
    // 720px 以内排两行撑到 7rem,那条 container query 的作用域是列表页根节点,
    // 本行各宽度下恒为 h-16。
    const frame = screen.getByTestId('plugin-detail-top-bar').firstElementChild;
    expect(frame?.className).toContain('h-16');
    expect(frame?.className).toContain('items-center');
  });

  it('turns opaque only after the frame leaves the top', () => {
    stubPlatform('darwin');

    render(<Harness />);

    const bar = screen.getByTestId('plugin-detail-top-bar');
    // 顶部静止态:透明背景,hairline 隐藏。
    expect(bar.className).toContain('bg-transparent');
    expect(bar.className).toContain('after:opacity-0');

    const frame = screen.getByTestId('scroll-frame');
    Object.defineProperty(frame, 'scrollTop', { value: 24, configurable: true });
    fireEvent.scroll(frame);

    // 滚动态为实底:落进 drag 矩形的正文元素同时被背景遮住,视觉与命中区一致。
    expect(bar.className).toContain('bg-[var(--surface)]');
    expect(bar.className).toContain('after:opacity-100');

    Object.defineProperty(frame, 'scrollTop', { value: 0, configurable: true });
    fireEvent.scroll(frame);
    expect(bar.className).toContain('bg-transparent');
  });
});
