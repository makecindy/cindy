// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import UsageScreen from '../../app/usage';
import zh from '../i18n/locales/zh-CN/devices.json';

const mock = vi.hoisted(() => ({
  platform: { OS: 'ios', Version: '18.0' },
  supported: true,
  nativeButton: false,

  action: undefined as { onPress(): void } | undefined,
}));

vi.mock('react-native', () => ({ Platform: mock.platform, View: ({ children, accessibilityRole, accessibilityLabel }: { children?: ReactNode; accessibilityRole?: string; accessibilityLabel?: string }) =>
  <div role={accessibilityRole === 'image' ? 'img' : undefined} aria-label={accessibilityLabel}>{children}</div>, StyleSheet: { create: (s: unknown) => s }, ScrollView: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('expo-router', () => ({
  useRouter: () => ({}),
  Stack: { Toolbar: Object.assign(({ children }: { children: ReactNode }) => children, {
    Button: (props: { onPress(): void }) => { mock.nativeButton = true; mock.action = props; return null; },
  }) },
}));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock('react-native-svg', () => ({
  default: 'svg', Circle: 'circle', Defs: 'defs', LinearGradient: 'linearGradient', Rect: 'rect', Stop: 'stop', Text: 'text',
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: { action: { onPress(): void; label: string } }) =>
    <button onClick={action.onPress}>{action.label}</button>,
}));
vi.mock('@/session/CompanionSheet', () => ({
  CompanionSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? <section>{children}</section> : null,
}));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: () => null }));
vi.mock('@/widgets/UsageDashboard', () => ({ useAutomaticUsage: () => null }));
vi.mock('@/widgets/usageWidgetSync', () => ({ get usageWidgetsSupported() { return mock.supported; } }));
vi.mock('@/platform/chrome', () => ({
  SimpleStackHeader: ({ action, rightToolbar }: { action?: typeof mock.action; rightToolbar?: ReactNode }) => {
    if (rightToolbar) expect(action).toBeUndefined();
    mock.action = action;
    return rightToolbar ?? null;
  },
  simpleScrollInsetProps: {}, simpleScrollScreenSafeAreaEdges: () => undefined,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { picker: string }) => {
    const text = zh[key.slice('devices.'.length) as keyof typeof zh];
    return typeof text === 'string' ? text.replace('{{picker}}', values?.picker ?? '') : key;
  },
}) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.supported = true;
  mock.nativeButton = false;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it.each([
  ['ios', '17.6', '点+'],
  ['ios', '18.1', '「编辑」→「添加小组件」'],
  ['android', '35', '拖到桌面'],
])('opens the applicable %s %s guide even without a usage snapshot', (OS, Version, expected) => {
  Object.assign(mock.platform, { OS, Version });
  act(() => root.render(<UsageScreen />));
  expect(host.querySelector('section')).toBeNull();
  expect(mock.nativeButton).toBe(OS === 'ios');
  act(() => mock.action!.onPress());
  const guide = host.querySelector('section')!;
  for (const text of [zh.widgetGuideIntro, '订阅余量', '每日用量', expected]) {
    expect(guide.textContent).toContain(text);
  }
  expect(guide.querySelector('[role=img]')?.getAttribute('aria-label')).toBe(zh.widgetGuideExample);
  // Only iOS offers these widgets on the Lock Screen.
  for (const text of [zh.widgetGuideLock, zh.widgetGuideLockIOS]) {
    expect(guide.textContent?.includes(text)).toBe(OS === 'ios');
  }
  expect(guide.querySelectorAll('svg')).toHaveLength(OS === 'ios' ? 2 : 1);
  act(() => guide.querySelector('button')!.click());
  expect(host.querySelector('section')).toBeNull();
});

it.each([
  ['ios', '16.7', true],
  ['ios', '18.1', false],
  ['web', '0', true],
])('omits the guide on unsupported builds (%s %s, module %s)', (OS, Version, supported) => {
  Object.assign(mock.platform, { OS, Version });
  mock.supported = supported;
  act(() => root.render(<UsageScreen />));
  expect(mock.action).toBeUndefined();
});
