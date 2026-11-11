// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileBoundaryNotice } from '@/session/MobileBoundaryNotice';
import { i18n } from '@/i18n';

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  type Props = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; accessibilityState?: { expanded?: boolean }; selectable?: boolean };
  const view = (tag: string) => ({ children, onPress, accessibilityLabel, accessibilityState, selectable }: Props) =>
    createElement(tag, { onClick: onPress, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded, 'data-selectable': selectable }, children);
  return { View: view('div'), Pressable: view('button'), Text: view('span'), StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ ChevronDown: () => null, ChevronRight: () => null, Layers: () => null, RefreshCw: () => null, Target: () => null }));
vi.mock('@legendapp/list/react-native', async () => ({ useRecyclingState: (await import('react')).useState }));
vi.mock('@/theme', async () => {
  const { lightColors } = await import('@/theme/tokens');
  return { useTheme: () => ({ colors: lightColors }), useThemedStyles: (make: (colors: typeof lightColors) => unknown) => make(lightColors) };
});

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('zh-CN');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('MobileBoundaryNotice', () => {
  it.each(['goal-complete', 'context-rebuild'] as const)('keeps %s details selectable and available on demand', (type) => {
    const detail = '完整原因或交接正文\n第二行也必须保留';
    act(() => root.render(<MobileBoundaryNotice type={type} data={{ reason: detail, handoff: detail, turnsUsed: 3, elapsedMs: 65000 }} />));
    const button = host.querySelector('button')!;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain(detail);
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-selectable="true"]')?.textContent).toBe(detail);
    act(() => button.click());
    expect(host.textContent).not.toContain(detail);
  });

  it.each(['compact', 'goal-complete', 'goal-resumed', 'context-rebuild'] as const)('does not offer an empty expander for %s', (type) => {
    act(() => root.render(<MobileBoundaryNotice type={type} />));
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).not.toBe('');
  });
});
