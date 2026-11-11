// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PluginInvocationHeader } from '@/session/PluginInvocationHeader';

const h = vi.hoisted(() => ({ reduced: false, start: vi.fn(), stop: vi.fn() }));
vi.mock('react-native', () => {
  const view = ({ children, onPress, accessibilityLabel }: any) => createElement('div', { onClick: onPress, 'aria-label': accessibilityLabel }, children);
  class Value { interpolate() { return 0; } setValue() {} }
  return { View: view, Pressable: view, Image: () => null, Text: view,
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 }, Easing: { linear: () => 0 },
    Animated: { View: view, Value, timing: () => ({}), loop: () => ({ start: h.start, stop: h.stop }) } };
});
vi.mock('@legendapp/list/react-native', () => ({ useRecyclingState: (s: any) => useState(s) }));
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => h.reduced }));
vi.mock('@/session/usePluginResultCard', () => ({ useSessionPluginResource: () => ({}) }));
vi.mock('lucide-react-native', () => ({ Check: () => createElement('span', { 'data-check': true }), ChevronDown: () => null, ChevronUp: () => null, Ghost: () => null }));
vi.mock('react-native-svg', () => ({ default: ({ children }: any) => createElement('div', {}, children), Circle: () => createElement('span', { 'data-arc': true }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }) };
});
it('tracks two plugins independently, stops rotation for reduced motion, and keeps details without a false success badge', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const plugins = [
    { id: 'a', name: 'Art', tools: ['generate'], hasPendingCalls: true },
    { id: 'b', name: 'Calendar', tools: ['read'], hasPendingCalls: false },
  ];
  const render = (running = true) => act(async () => root.render(<PluginInvocationHeader sessionId="s" plugins={plugins} running={running} showCompletionBadge={false} />));
  try {
    await render();
    expect(h.start).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('[data-arc]')).toHaveLength(4);
    expect(host.querySelector('[aria-label="Art · message.pluginInvocation.status.running"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Calendar · message.pluginInvocation.status.called"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLElement>('[aria-label^="Art"]')!.click());
    expect(host.textContent).toContain('generate');
    h.reduced = true;
    await render();
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenCalledOnce();
    await render(false);
    expect(host.querySelector('[aria-label="Art · message.pluginInvocation.status.called"]')).not.toBeNull();
    expect(host.querySelector('[data-check]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
