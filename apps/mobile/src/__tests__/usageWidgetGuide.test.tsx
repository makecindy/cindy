import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import UsageScreen from '../../app/usage';
import zh from '../i18n/locales/zh-CN/devices.json';

const mock = vi.hoisted(() => ({
  platform: { OS: 'ios', Version: '18.0' },
  supported: true,
  nativeButton: false,
  alert: vi.fn(),
  action: undefined as { onPress(): void } | undefined,
}));

vi.mock('react-native', () => ({ Platform: mock.platform, Alert: { alert: mock.alert }, ScrollView: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'main' }));
vi.mock('expo-router', () => ({
  useRouter: () => ({}),
  Stack: { Toolbar: Object.assign(({ children }: { children: ReactNode }) => children, {
    Button: (props: { onPress(): void }) => { mock.nativeButton = true; mock.action = props; return null; },
  }) },
}));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }) }));
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

beforeEach(() => { mock.supported = true; mock.nativeButton = false; mock.alert.mockClear(); });

it.each([
  ['ios', '17.6', '点+'],
  ['ios', '18.1', '「编辑」→「添加小组件」'],
  ['android', '35', '拖到桌面'],
])('opens the applicable %s %s guide even without a usage snapshot', (OS, Version, expected) => {
  Object.assign(mock.platform, { OS, Version });
  renderToStaticMarkup(<UsageScreen />);
  expect(mock.alert).not.toHaveBeenCalled();
  expect(mock.nativeButton).toBe(OS === 'ios');
  mock.action!.onPress();
  const [title, help] = mock.alert.mock.calls[0]!;
  expect(title).toBe('添加小组件');
  for (const text of [expected, '订阅余量', '每日用量']) expect(help).toContain(text);
});

it.each([
  ['ios', '16.7', true],
  ['ios', '18.1', false],
  ['web', '0', true],
])('omits the guide on unsupported builds (%s %s, module %s)', (OS, Version, supported) => {
  Object.assign(mock.platform, { OS, Version });
  mock.supported = supported;
  renderToStaticMarkup(<UsageScreen />);
  expect(mock.action).toBeUndefined();
});
