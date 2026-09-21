// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlowSendNotice } from '@/session/SlowSendNotice';
import { i18n } from '@/i18n';

vi.mock('@/components/AppText', async () => {
  const { createElement } = await import('react');
  return { Text: ({ children, accessibilityLiveRegion }: { children?: ReactNode; accessibilityLiveRegion?: string }) =>
    createElement('span', { 'aria-live': accessibilityLiveRegion }, children) };
});
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }) };
});

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('zh-CN');
  vi.useFakeTimers();
  vi.setSystemTime(0);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('SlowSendNotice', () => {
  it('adds no text or layout for fast sends, including after completion', async () => {
    act(() => root.render(<SlowSendNotice startedAt={0} phase="uploading" />));
    await act(async () => { await vi.advanceTimersByTimeAsync(7_999); });
    expect(host.childElementCount).toBe(0);
    act(() => root.render(<SlowSendNotice startedAt={null} phase="uploading" />));
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(host.childElementCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the current phase after eight seconds without resetting on phase changes', async () => {
    act(() => root.render(<SlowSendNotice startedAt={0} phase="uploading" />));
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
    act(() => root.render(<SlowSendNotice startedAt={0} phase="connecting" />));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(host.textContent).toBe('正在连接电脑…');
    expect(host.querySelector('span')?.getAttribute('aria-live')).toBe('polite');
    act(() => root.render(<SlowSendNotice startedAt={0} phase="sending" />));
    expect(host.textContent).toBe('正在发送消息…');
    act(() => root.render(<SlowSendNotice startedAt={8_000} phase="uploading" />));
    expect(host.childElementCount).toBe(0);
  });

  it('preserves elapsed time when the destination page mounts after handoff', async () => {
    vi.setSystemTime(10_000);
    act(() => root.render(<SlowSendNotice startedAt={0} phase="creating" />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(host.textContent).toBe('正在创建任务…');
  });
});
