// @vitest-environment jsdom
// Unit, approved V9: previous Host/hook tests mock the View entirely. Native bridge substitution
// checks production close/submit controls and compact input detents, not rendered iOS fidelity.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ sheet: null as any, input: null as any, detents: [] as any[], scale: 1, scrollGeometry: null as any, geometry: [] as any[], dismissKeyboard: vi.fn() }));
vi.mock('@expo/ui', () => ({ Host: ({ children }: any) => <div>{children}</div> }));
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children, testID, modifiers }: any) => { const measure = modifiers?.find((m: any) => m.onGeometryChange)?.onGeometryChange; if (measure) h.geometry.push(measure); return <div data-testid={testID}>{children}</div>; };
  return { BottomSheet: (props: any) => { h.sheet = props; return <div>{props.children}</div>; },
    Group: ({ children, modifiers }: any) => { h.detents = modifiers.find((m: any) => m.presentationDetents)?.presentationDetents; return <div>{children}</div>; },
    HStack: Box, VStack: Box, ZStack: Box, RNHostView: Box, ScrollView: Box, Spacer: () => null, Image: () => null,
    Text: ({ children, modifiers }: any) => <span data-font-size={modifiers?.find((m: any) => m.font)?.font.size}>{children}</span>,
    Button: ({ children, onPress, modifiers, testID }: any) => <button data-testid={testID}
      disabled={modifiers?.some((m: any) => m.disabled)} onClick={onPress}>{children}</button> };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(['accessibilityLabel', 'background', 'buttonStyle', 'containerRelativeFrame', 'contentShape', 'disabled', 'fixedSize',
    'font', 'foregroundStyle', 'frame', 'interactiveDismissDisabled', 'lineSpacing', 'multilineTextAlignment', 'onGeometryChange', 'opacity',
    'padding', 'presentationDetents', 'presentationDragIndicator', 'scrollDismissesKeyboard'].map(name => [name, (value: unknown) => ({ [name]: value })])),
  useScrollGeometryChange: (callback: any) => { h.scrollGeometry = callback; return {}; },
  shapes: { capsule: () => ({}), rectangle: () => ({}) },
}));
vi.mock('react-native', () => ({ View: ({ children }: any) => <div>{children}</div>, ActivityIndicator: () => <i data-testid="progress" />,
  Keyboard: { dismiss: h.dismissKeyboard }, useWindowDimensions: () => ({ width: 390, height: 844, fontScale: h.scale }) }));
vi.mock('@/components/AppText', () => ({ TextInput: (props: any) => { h.input = props; return <input data-testid={props.testID} value={props.value} onChange={() => {}} />; } }));
vi.mock('@/chat/ChatInviteAvatar', () => ({ ChatInviteAvatar: () => <div data-testid="identity" /> }));
vi.mock('@/platform/chrome/nativeGlassButtonStyle.ios', () => ({ useNativeGlassButtonStyle: () => [] }));
vi.mock('@/theme', () => ({ useTheme: () => ({ mode: 'light', colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ChatInviteView } from '@/chat/ChatInviteView.ios';
import type { ChatInviteViewProps } from '@/chat/ChatInviteView';
let root: Root, host: HTMLDivElement, props: ChatInviteViewProps;
const render = () => act(async () => root.render(createElement(ChatInviteView, props)));
const button = (name: string) => host.querySelector(`[data-testid="chatInvite.${name}"]`) as HTMLButtonElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); h.scale = 1; h.input = null; h.geometry = [];
  host = document.createElement('div'); root = createRoot(host);
  props = { visible: true, title: '', input: false, model: { phase: 'preview', owner: 'owner', input: '', manual: true,
    preview: { groupId: 'group', name: 'Support', inviterName: 'Lin', memberCount: 8, joined: false },
    close: vi.fn(), closed: vi.fn(), edit: vi.fn(), setInput: vi.fn(), read: vi.fn(), retry: vi.fn(), accept: vi.fn() },
    primary: { label: 'Join', disabled: false, busy: false, onPress: vi.fn() } };
});
afterEach(() => act(() => root.unmount()));
it('retains close/edit while joining, prevents activation, and delivers dismissal separately', async () => {
  h.scale = 1.8;
  await render(); const close = button('close'), edit = button('edit');
  const normalSize = Number(button('primary').querySelector('span')!.getAttribute('data-font-size'));
  expect(normalSize).toBeGreaterThan(16);
  props = { ...props, model: { ...props.model, phase: 'joining' }, primary: { ...props.primary!, busy: true, label: 'Joining' } }; await render();
  expect(button('close')).toBe(close); expect(button('edit')).toBe(edit);
  expect(Number(button('primary').querySelector('span')!.getAttribute('data-font-size'))).toBe(normalSize);
  expect(close.disabled).toBe(true); expect(edit.disabled).toBe(true);
  expect(button('primary').tagName).toBe('DIV'); expect(host.querySelector('[data-testid="progress"]')).not.toBeNull();
  await act(async () => { close.click(); edit.click(); h.sheet.onIsPresentedChange(false); });
  expect(props.model.close).not.toHaveBeenCalled(); expect(props.model.edit).not.toHaveBeenCalled(); expect(props.primary!.onPress).not.toHaveBeenCalled();
  props = { ...props, visible: false }; await render(); await act(async () => h.sheet.onDismiss());
  expect(props.model.closed).toHaveBeenCalledOnce();
});
it('uses one input detent and native editing props, guards empty submission, and permits large accessibility text', async () => {
  props = { ...props, input: true, title: 'Join', model: { ...props.model, phase: 'input', preview: undefined }, primary: { ...props.primary!, disabled: true } }; await render();
  expect(h.detents).toHaveLength(1); expect(h.detents).not.toContain('large');
  expect(h.input).toMatchObject({ clearButtonMode: 'while-editing', keyboardType: 'url', autoCorrect: false, autoCapitalize: 'none' });
  await act(async () => h.input.onSubmitEditing()); expect(props.primary!.onPress).not.toHaveBeenCalled();
  props = { ...props, model: { ...props.model, input: 'link' }, primary: { ...props.primary!, disabled: false } }; await render();
  await act(async () => h.input.onSubmitEditing()); expect(props.primary!.onPress).toHaveBeenCalledOnce(); expect(h.dismissKeyboard).toHaveBeenCalledOnce();
  h.scale = 1.8; await render(); expect(h.detents).toEqual(['large']);
});
it('keeps uncertain editing/exit available and never exposes manual input for an external failure', async () => {
  props = { ...props, model: { ...props.model, phase: 'error', error: 'uncertain' } }; await render();
  expect(button('edit').disabled).toBe(false); expect(button('close').disabled).toBe(false);
  await act(async () => button('edit').click()); expect(props.model.edit).toHaveBeenCalledOnce();
  props = { ...props, model: { ...props.model, manual: false, error: 'format', preview: undefined } }; await render();
  expect(button('edit')).toBeNull(); expect(host.querySelector('input')).toBeNull();
  await act(async () => button('close').click()); expect(props.model.close).toHaveBeenCalledOnce();
});

it('uses unscaled scroll geometry for the compact detent during the floating-sheet transform', async () => {
  await render();
  const [bodyMeasure, footerMeasure] = h.geometry;
  await act(async () => {
    bodyMeasure({width:377, height:230 * 377 / 393});
    footerMeasure({width:377, height:66 * 377 / 393});
    h.scrollGeometry({containerWidth:393, contentHeight:230});
  });
  expect(h.detents[0]).toEqual({height:296});
});
