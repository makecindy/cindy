// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { useSharedTaskConfirmation } from '@/session/useSharedTaskConfirmation';

const h = vi.hoisted(() => ({ native: vi.fn(), result: vi.fn(), close: () => {}, dark: false }));
vi.mock('@/platform/chrome/showActionMenu', () => ({ showConfirm: h.native }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = ({ children, testID, style }: { children: ReactNode; testID?: string; style?: object }) => createElement('div', { 'data-testid': testID, style }, children);
  return { Platform: { OS: 'android' }, View: view, ScrollView: view,
    Modal: ({ children, onRequestClose }: { children: ReactNode; onRequestClose(): void }) => { h.close = onRequestClose; return createElement('div', { role: 'dialog' }, children); },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    AccessibilityInfo: { setAccessibilityFocus: vi.fn() }, findNodeHandle: () => null,
  };
});
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { label: string; tone?: string; testID?: string; onPress(): void } }) => <button data-testid={action.testID} data-tone={action.tone} onClick={action.onPress}>{action.label}</button>,
}));
vi.mock('@/theme', async () => {
  const { lightColors, darkColors } = await import('@/theme/tokens');
  return { useThemedStyles: (make: (colors: typeof lightColors) => unknown) => make(h.dark ? darkColors : lightColors) };
});
let root: Root;
let host: HTMLDivElement;
const input = { title: 'Leave?', message: 'Access will end.', cancelLabel: 'Stay', confirmLabel: 'Leave', destructive: true };
function Harness() {
  const confirmation = useSharedTaskConfirmation();
  return <><button onClick={() => { void confirmation.confirm(input).then(h.result); }}>open</button>{confirmation.dialog}</>;
}
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === text)!.click()); }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); Platform.OS = 'android'; h.dark = false;
  host = document.createElement('div'); root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => { await act(async () => root.unmount()); });
it('uses a compact themed Android dialog with neutral cancel and solid danger action', async () => {
  await click('open');
  expect(h.native).not.toHaveBeenCalled();
  expect(host.querySelectorAll('[role=dialog]')).toHaveLength(1);
  const actions = [...host.querySelector('[role=dialog]')!.querySelectorAll('button')];
  expect(actions.map((button) => button.textContent)).toEqual(['Stay', 'Leave']);
  expect(host.querySelector('[data-testid="sharedTask.confirmAccept"]')?.getAttribute('data-tone')).toBe('danger-solid');
  const card = host.querySelector('[data-testid="sharedTask.confirmDialog"]') as HTMLElement;
  expect(card.style.borderRadius).toBe('12px'); expect(card.style.maxWidth).toBe('400px');
  await click('Stay'); expect(h.result).toHaveBeenLastCalledWith(false);
  expect(host.querySelector('[role=dialog]')).toBeNull();
});
it('uses different theme surfaces in Light and Dark', async () => {
  await click('open');
  const light = (host.querySelector('[data-testid="sharedTask.confirmDialog"]') as HTMLElement).style.backgroundColor;
  h.dark = true; await act(async () => root.render(<Harness />));
  const dark = (host.querySelector('[data-testid="sharedTask.confirmDialog"]') as HTMLElement).style.backgroundColor;
  expect(dark).not.toBe(light);
});
it('cancels on Android Back and resolves confirmation only once', async () => {
  await click('open'); await act(async () => { h.close(); h.close(); });
  expect(h.result).toHaveBeenCalledTimes(1); expect(h.result).toHaveBeenCalledWith(false);
  await click('open'); await click('Leave'); expect(h.result).toHaveBeenLastCalledWith(true);
});
it('cancels an unresolved Android confirmation on unmount', async () => {
  await click('open'); await act(async () => root.render(null));
  expect(h.result).toHaveBeenCalledWith(false);
});
it('keeps iOS confirmation native without a second custom modal', async () => {
  Platform.OS = 'ios'; h.native.mockResolvedValue(true); await click('open');
  expect(h.native).toHaveBeenCalledWith(input);
  expect(host.querySelector('[role=dialog]')).toBeNull();
  expect(h.result).toHaveBeenCalledWith(true);
});
