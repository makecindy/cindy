// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MobileComposerInputRow } from '@/session/MobileComposerInputRow';

vi.mock('expo-constants', () => ({ default: { executionEnvironment: 'bare' }, ExecutionEnvironment: { StoreClient: 'storeClient' } }));
vi.mock('react-native', async () => {
  const React = await import('react');
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    React.createElement('div', { 'data-testid': testID }, children);
  const ScrollView = ({ children, testID, scrollEnabled }: { children?: ReactNode; testID?: string; scrollEnabled?: boolean }) =>
    React.createElement('div', { 'data-testid': testID, 'data-scroll': String(scrollEnabled) }, children);
  return { View, ScrollView, Pressable: View, Platform: { OS: 'ios' },
    StyleSheet: { hairlineWidth: 1, absoluteFill: {} }, Animated: {}, Easing: {} };
});
vi.mock('@/components/AppText', () => ({ TextInput: () => null }));
vi.mock('@/platform/gestureHandler', () => ({ GestureDetector: ({ children }: { children: ReactNode }) => children }));
vi.mock('expo-paste-input', () => ({ TextInputWrapper: ({ children }: { children: ReactNode }) => children }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }));
vi.mock('lucide-react-native', () => ({ Mic: () => null }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/voicePillWidthMotion', () => ({ useVoicePillWidthStyle: () => ({}) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ mode: 'dark', colors: tokens.darkColors }),
    useThemedStyles: (make: (colors: typeof tokens.darkColors) => unknown) => make(tokens.darkColors) };
});
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  const { useRef } = await import('react');
  return { default: { View }, useSharedValue: (value: unknown) => useRef({ value }).current,
    useAnimatedStyle: (calculate: () => unknown) => calculate() };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('keeps send/voice/grabber outside the scrolling body and retains the editor across collapse', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const send = vi.fn();
  const gesture = {} as NonNullable<React.ComponentProps<typeof MobileComposerInputRow>['bodyScrollGesture']>;
  const render = (cardActive: boolean) => act(() => root.render(<MobileComposerInputRow
    accessibilityLabel="Message" inputTestID="input" placeholder="Message" placeholderTextColor="inherit"
    value={'Long text\n'.repeat(300)} onChangeText={() => {}} cardActive={cardActive}
    bodyScrollGesture={gesture} inputElement={<textarea defaultValue={'Long text\n'.repeat(300)} />}
    accessoryAbove={<div data-testid="attachment">Image</div>}
    toolbar={<button onClick={send}>Send</button>} resizeHandle={<div data-testid="grabber" />}
    voicePlacement={{ inline: false, floating: true }} floatingVoiceButton={() => <button>Voice</button>}
    testID="composer"
  />));
  try {
    render(true);
    const body = container.querySelector('[data-testid="composer.bodyScroll"]')!;
    const editor = container.querySelector('textarea');
    expect(body.contains(editor)).toBe(true);
    expect(body.querySelector('[data-testid="attachment"]')).not.toBeNull();
    for (const selector of ['button', '[data-testid="grabber"]']) expect(body.querySelector(selector)).toBeNull();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="composer.toolbar"] button')!;
    act(() => button.click());
    expect(send).toHaveBeenCalledOnce();
    render(false);
    expect(container.querySelector('textarea')).toBe(editor);
    expect(body.getAttribute('data-scroll')).toBe('false');
    render(true);
    expect(container.querySelector('textarea')).toBe(editor);
    expect(body.getAttribute('data-scroll')).toBe('true');
  } finally { act(() => root.unmount()); }
});
