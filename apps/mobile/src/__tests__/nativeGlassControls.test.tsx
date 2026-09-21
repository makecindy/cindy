// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeChromeButton } from '../platform/chrome/NativeChromeButton.ios';
import { LoginNativeButton } from '../components/LoginNativeButton.ios';
import { useNativeGlassButtonStyle } from '../platform/chrome/nativeGlassButtonStyle.ios';

const state = vi.hoisted(() => ({ glass: true, mode: 'light' }));
vi.mock('@/theme', () => ({
  navigationChrome: { target: 44, clear: { light: { foreground: 'black', scrim: 'light-scrim' }, dark: { foreground: 'white', scrim: 'dark-scrim' } } },
  iconSize: { action: 20 }, iconStroke: { regular: 2 }, radius: { pill: 9999 },
  useTheme: () => ({ mode: state.mode, colors: { textPrimary: 'primary', textSecondary: 'secondary', cta: 'cta', destructive: 'danger', surfaceElevated: 'surface' } }),
}));
vi.mock('@/session/useLiquidGlassAvailable', () => ({ useLiquidGlassAvailable: () => state.glass }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({ View: ({ children }: any) => <div>{children}</div>, Image: () => null }));
vi.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { LogOut: Icon, Monitor: Icon, Search: Icon, Settings: Icon, UsersRound: Icon };
});
vi.mock('@expo/ui', () => ({ Host: ({ children }: any) => <div>{children}</div> }));
vi.mock('@expo/ui/swift-ui', () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  return {
    HStack: Container, VStack: Container, RNHostView: Container, Text: Container, Image: () => null,
    ProgressView: () => <span role="progressbar" />,
    Button: ({ children, label, onPress, testID, modifiers = [] }: any) => <button data-testid={testID}
      disabled={modifiers.some((m: any) => m.name === 'disabled' && m.value)} onClick={onPress}>{children ?? label}</button>,
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const names = ['background', 'buttonBorderShape', 'buttonStyle', 'contentShape', 'controlSize', 'foregroundStyle', 'frame', 'glassEffect', 'accessibilityElement', 'accessibilityLabel', 'accessibilityAddTraits', 'disabled', 'font', 'labelStyle', 'lineLimit'];
  return { ...Object.fromEntries(names.map(name => [name, (value: any) => ({ name, value })])), shapes: { circle: () => 'circle', capsule: () => 'capsule' } };
});
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); state.glass = true; state.mode = 'light'; });
function mount(children: ReactNode) {
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  act(() => root.render(children));
  return host;
}
it('prevents disabled glass actions', () => {
  const click = vi.fn();
  const host = mount(<NativeChromeButton label="disabled" testID="disabled" disabled onPress={click} />);
  act(() => (host.querySelector('[data-testid="disabled"]') as HTMLButtonElement).click());
  expect(click).not.toHaveBeenCalled();
});
it.each(['light', 'dark'])('keeps clear glass foreground/backing paired in %s', mode => {
  state.mode = mode;
  let modifiers: any[] = [];
  function Probe() { modifiers = useNativeGlassButtonStyle({ shape: 'circle', clear: true }); return null; }
  mount(<Probe />);
  expect(modifiers).toContainEqual({ name: 'foregroundStyle', value: mode === 'light' ? 'black' : 'white' });
  expect(modifiers).toContainEqual({ name: 'background', value: `${mode}-scrim` });
  expect(modifiers).toContainEqual({ name: 'frame', value: { width: 44, height: 44 } });
});
it('keeps unsupported-glass controls native with bordered prominent styling', () => {
  state.glass = false; let modifiers: any[] = [];
  function Probe() { modifiers = useNativeGlassButtonStyle({ prominent: true }); return null; }
  mount(<Probe />);
  expect(modifiers).toContainEqual({ name: 'buttonStyle', value: 'borderedProminent' });
  expect(modifiers.some(m => m.name === 'glassEffect')).toBe(false);
});

it.each(['light', 'dark'])('blocks repeated login submissions while busy, then re-enables in %s', mode => {
  state.mode = mode;
  const click = vi.fn();
  const host = document.createElement('div');
  const root = createRoot(host); roots.push(root);
  const render = (busy: boolean) => root.render(<LoginNativeButton label="Verify" onPress={click}
    busy={busy} width={540} height={80} fontSize={24} variant="primary" />);
  act(() => render(true));
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  act(() => host.querySelector('button')!.click());
  expect(click).not.toHaveBeenCalled();
  act(() => render(false));
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  act(() => host.querySelector('button')!.click());
  expect(click).toHaveBeenCalledTimes(1);
});

it('keeps provider artwork inside a native button and prevents disabled activation', () => {
  const click = vi.fn();
  const host = mount(<LoginNativeButton label="Provider" disabled onPress={click}
    width={80} height={80} fontSize={24} variant="circle"><span data-brand="original" /></LoginNativeButton>);
  expect(host.querySelectorAll('button')).toHaveLength(1);
  expect(host.querySelector('button [data-brand="original"]')).not.toBeNull();
  act(() => host.querySelector('button')!.click());
  expect(click).not.toHaveBeenCalled();
});
