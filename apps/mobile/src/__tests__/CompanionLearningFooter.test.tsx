// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dark: false }));
vi.mock('react-native', () => ({
  View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress }: any) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, style }: any) => createElement('span', { style }, children),
}));
vi.mock('lucide-react-native', () => ({ Brain: () => null, BookOpen: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, args: any) => `${key}: ${args.title}` }),
}));
vi.mock('@/theme', async () => {
  const tokens = await vi.importActual<any>('@/theme/tokens');
  const colors = () => (state.dark ? tokens.darkColors : tokens.lightColors);
  return {
    ...tokens,
    useTheme: () => ({ colors: colors() }),
    useThemedStyles: (make: any) => make(colors()),
  };
});
import { CompanionLearningFooter } from '@/session/CompanionLearningFooter';
it.each([false, true])(
  'opens existing profile pages in dark=%s with two distinct receipt rows',
  async (dark) => {
    state.dark = dark;
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    const root = createRoot(host);
    const open = vi.fn();
    const receipts = [
      { kind: 'memory', key: 'preference', title: 'Conclusion first', action: 'created' },
      { kind: 'skill', key: 'report', title: 'Weekly report', action: 'updated' },
    ];
    await act(async () =>
      root.render(<CompanionLearningFooter receipts={receipts} onOpenSettings={open} />),
    );
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('Conclusion first');
    expect(buttons[1].textContent).toContain('Weekly report');
    await act(async () => buttons[0].click());
    expect(open).toHaveBeenLastCalledWith('memory');
    await act(async () => buttons[1].click());
    expect(open).toHaveBeenLastCalledWith('capabilities');
    await act(async () =>
      root.render(<CompanionLearningFooter receipts={undefined} onOpenSettings={open} />),
    );
    expect(host.querySelectorAll('button')).toHaveLength(0);
    await act(async () => root.unmount());
  },
);
