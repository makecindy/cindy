// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { textLayouts } = vi.hoisted(() => ({ textLayouts: new Map<string, (event: { nativeEvent: { lines: unknown[] } }) => void>() }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => ({ children, testID }: { children?: ReactNode | ((state: { pressed: boolean }) => ReactNode); testID?: string }) =>
    createElement(tag, { 'data-testid': testID }, typeof children === 'function' ? children({ pressed: false }) : children);
  return { View: view('div'), Pressable: view('button'), ActivityIndicator: () => null,
    StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@/components/AppText', async () => {
  const { createElement } = await import('react');
  // Text keeps its onTextLayout so a test can report how many lines a label took.
  return { Text: ({ children, onTextLayout }: { children?: ReactNode; onTextLayout?: (event: { nativeEvent: { lines: unknown[] } }) => void }) => {
    if (onTextLayout) textLayouts.set(String(children), onTextLayout);
    return createElement('span', null, children);
  } };
});
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }), useThemedStyles: (make: (c: unknown) => unknown) => make(tokens.lightColors) };
});

import { CompanionCardActions, CompanionCardButton } from '@/session/CompanionCardButton';
import { BotGroupPlanActions } from '@/session/BotGroupPlanActions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { textLayouts.clear(); host = document.createElement('div'); root = createRoot(host); });
afterEach(() => act(() => root.unmount()));

it('stacks the work-split card buttons one per row once any label would wrap at equal width', async () => {
  await act(async () => root.render(<CompanionCardActions>
    <CompanionCardButton label="End Work Split" onPress={() => {}} />
    <CompanionCardButton primary label="Start Next Step" onPress={() => {}} />
  </CompanionCardActions>));
  const stacked = () => host.querySelector('[data-testid="companion.cardActions.stacked"]');
  await act(async () => textLayouts.get('End Work Split')!({ nativeEvent: { lines: [{}] } }));
  expect(stacked()).toBeNull();
  await act(async () => textLayouts.get('Start Next Step')!({ nativeEvent: { lines: [{}, {}] } }));
  expect(stacked()).not.toBeNull();
});

it('moves Android plan actions below the teammate when a narrow-card label wraps', async () => {
  const onStacked = vi.fn();
  await act(async () => root.render(<BotGroupPlanActions onStacked={onStacked} actions={[
    { label: 'Arbeitsaufteilung beenden', onPress() {} },
    { label: 'Nächsten Schritt starten', tone: 'primary', onPress() {} },
  ]} />));
  await act(async () => textLayouts.get('Nächsten Schritt starten')?.({ nativeEvent: { lines: [{}] } }));
  expect(onStacked).not.toHaveBeenCalled();
  expect(textLayouts.has('Nächsten Schritt starten')).toBe(true);
  await act(async () => textLayouts.get('Nächsten Schritt starten')!({ nativeEvent: { lines: [{}, {}] } }));
  expect(onStacked).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="companion.cardActions.stacked"]')).not.toBeNull();
  expect(host.textContent).toContain('Arbeitsaufteilung beenden');
  expect(host.textContent).toContain('Nächsten Schritt starten');
});
