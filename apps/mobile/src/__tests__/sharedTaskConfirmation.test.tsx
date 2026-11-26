// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { useSharedTaskConfirmation } from '@/session/useSharedTaskConfirmation';

const h = vi.hoisted(() => ({ native: vi.fn(), alert: vi.fn(), result: vi.fn(), close: () => {}, dark: false, request: null as any,
  props: new Map<string, any>() }));
vi.mock('@/platform/chrome/showActionMenu', () => ({ showConfirm: h.native }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (props: { children: ReactNode; testID?: string; style?: object }) => {
    if (props.testID) h.props.set(props.testID, props);
    const style = Object.assign({}, ...[props.style].flat(3).filter(Boolean));
    return createElement('div', { 'data-testid': props.testID, style }, props.children);
  };
  return { Platform: { OS: 'android' }, View: view, ScrollView: view,
    Modal: ({ children, onRequestClose }: { children: ReactNode; onRequestClose(): void }) => { h.close = onRequestClose; return createElement('div', { role: 'dialog' }, children); },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    AccessibilityInfo: { setAccessibilityFocus: vi.fn() }, findNodeHandle: () => null, Alert: { alert: h.alert },
  };
});
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { label: string; tone?: string; testID?: string; onPress(): void } }) => <button data-testid={action.testID} data-tone={action.tone} onClick={action.onPress}>{action.label}</button>,
}));
vi.mock('@/theme', async () => {
  const { lightColors, darkColors } = await import('@/theme/tokens');
  return { useThemedStyles: (make: (colors: typeof lightColors) => unknown) => make(h.dark ? darkColors : lightColors),
    useTheme: () => ({ colors: h.dark ? darkColors : lightColors }) };
});
let root: Root;
let host: HTMLDivElement;
const input = { title: 'Leave?', message: 'Access will end.', cancelLabel: 'Stay', confirmLabel: 'Leave', destructive: true };
function Harness() {
  const confirmation = useSharedTaskConfirmation();
  return <><button onClick={() => { void confirmation.confirm(h.request ?? input).then(h.result); }}>open</button>{confirmation.dialog}</>;
}
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === text)!.click()); }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); Platform.OS = 'android'; h.dark = false; h.request = null;
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
/* 测试价值（调度要求 J-2：插件页的提示改走这套两态提示）
 * - 生产入口与可观察结果：useSharedTaskConfirmation（Android 主题卡片、iOS 系统提示）；观察按钮、结果与回调时机。
 * - 依据：只告知的提示只有一个「知道了」，不出现取消；确认动作在同一次点按里先执行（插件页据此同步拿占用）。
 * - 缺口：系统 Alert 在 Android 不跟随应用的深浅色；长句当标题；确认后的占用晚一个微任务，被同帧另一入口抢先。
 * - 最小失败输入：无 cancelLabel 的请求；带 onConfirm 的确认。tier: unit。
 */
it('shows a notice with one button only, on Android in the themed card and on iOS as the system alert', async () => {
  h.request = { title: 'Short title', message: 'The full explanation.', confirmLabel: 'Got it' };
  await click('open');
  const actions = [...host.querySelector('[role=dialog]')!.querySelectorAll('button')];
  expect(actions.map((button) => button.textContent)).toEqual(['Got it']);
  expect(host.textContent).toContain('Short title');
  expect(host.textContent).toContain('The full explanation.');
  await click('Got it');
  expect(h.result).toHaveBeenLastCalledWith(true);
  Platform.OS = 'ios';
  await click('open');
  expect(h.native).not.toHaveBeenCalled();
  expect(h.alert).toHaveBeenCalledWith('Short title', 'The full explanation.', [{ text: 'Got it', onPress: expect.any(Function) }], expect.objectContaining({ cancelable: true }));
});
it('runs onConfirm in the tap that confirms, before the promise settles', async () => {
  const order: string[] = [];
  h.request = { ...input, onConfirm: () => order.push('confirm') };
  h.result.mockImplementation(() => order.push('settled'));
  await click('open');
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="sharedTask.confirmAccept"]')!.click(); order.push('tap'); });
  expect(order).toEqual(['confirm', 'tap', 'settled']);
});

// Dispatcher M-2 (plugin page prompts use this card on Android): at the largest text sizes the text scrolls and the
// buttons stay whole below it, outside the scroll area.
it('keeps the buttons outside the scrolled text', async () => {
  h.request = { title: 'Short title', message: 'A long explanation. '.repeat(40), confirmLabel: 'Got it' };
  await click('open');
  const card = host.querySelector('[data-testid="sharedTask.confirmDialog"]')!;
  const [scrolled, actions] = [...card.children];
  expect(scrolled.textContent).toContain('A long explanation.');
  expect(scrolled.querySelector('button')).toBeNull();
  expect(actions.querySelector('[data-testid="sharedTask.confirmAccept"]')).not.toBeNull();
});

// Dispatcher Q-4 (Android sixth reshoot): a German notice at the largest text size on a short screen scrolled, and the
// resting card showed only half a last line. More text than fits: a fade over the lower edge and a scroll thumb in a
// token that stands out from the card in light and dark; both go once the end shows. Tier: unit/jsdom.
it.each([false, true])('says the text scrolls with a fade and a visible thumb (dark=%s)', async (dark) => {
  h.dark = dark;
  await act(async () => root.render(<Harness />));
  await click('open');
  const copy = h.props.get('sharedTask.confirmCopy');
  await act(async () => copy.onLayout({ nativeEvent: { layout: { height: 200 } } }));
  await act(async () => copy.onContentSizeChange(300, 600));
  const { lightColors, darkColors } = await import('@/theme/tokens');
  expect(host.querySelector('[data-testid="sharedTask.confirmFade"]')).not.toBeNull();
  const thumb = host.querySelector('[data-testid="sharedTask.confirmThumb"]') as HTMLElement;
  expect(thumb).not.toBeNull();
  const expected = (dark ? darkColors : lightColors).borderStrong;
  expect(thumb.style.backgroundColor.replace(/\s/g, '')).toBe(`rgb(${[1, 3, 5].map((i) => parseInt(expected.slice(i, i + 2), 16)).join(',')})`);
  expect(copy.showsVerticalScrollIndicator).toBe(false);
  await act(async () => copy.onScroll({ nativeEvent: { contentOffset: { y: 400 }, contentSize: { height: 600 }, layoutMeasurement: { height: 200 } } }));
  expect(host.querySelector('[data-testid="sharedTask.confirmFade"]')).toBeNull();
});

// Dispatcher S-3 (Android seventh reshoot): the same thumb lay over content in the plugin record panel; this card uses it
// too. While the text scrolls its right side keeps the thumb's width and a gap free; otherwise it keeps its full
// width. Failed on 5983ba71dd (no right padding). Tier: unit/jsdom.
it('keeps the scroll thumb off the text', async () => {
  await act(async () => root.render(<Harness />));
  await click('open');
  const flat = (style: any) => Object.assign({}, ...[style].flat(3).filter(Boolean));
  const copy = () => h.props.get('sharedTask.confirmCopy');
  expect(flat(copy().contentContainerStyle).paddingRight).toBeUndefined();
  await act(async () => copy().onLayout({ nativeEvent: { layout: { height: 200 } } }));
  await act(async () => copy().onContentSizeChange(300, 600));
  const thumb = host.querySelector('[data-testid="sharedTask.confirmThumb"]') as HTMLElement;
  const right = parseFloat(thumb.style.right), width = parseFloat(thumb.style.width);
  expect(right + width).toBeLessThan(flat(copy().contentContainerStyle).paddingRight);
});
