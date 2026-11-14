// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
const native = vi.hoisted(() => ({
  supported: true,
  current: null as string | null,
  setIcon: vi.fn(async (_name: string | null) => {}),
  alert: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

vi.mock('@/settings/appIconNative', () => ({
  getAppIconNative: () => ({
    supportsAlternateIcons: async () => native.supported,
    getAlternateIconName: async () => native.current,
    setAlternateIconName: native.setIcon,
  }),
}));

vi.mock('@/settings/appIconAssets', () => ({
  defaultIconAsset: 1,
  wordmarkLightAsset: 2,
  wordmarkDarkAsset: 3,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  type Props = {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { checked?: boolean; disabled?: boolean };
    disabled?: boolean;
    testID?: string;
  };
  const host = (tag: string) => ({ children, onPress, accessibilityLabel, accessibilityState, disabled, testID }: Props) =>
    createElement(
      tag,
      {
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'aria-checked': accessibilityState?.checked,
        'aria-disabled': accessibilityState?.disabled,
        'data-testid': testID,
        ...(tag === 'button' ? { disabled } : {}),
      },
      children,
    );
  return {
    View: host('div'),
    Pressable: host('button'),
    Text: host('span'),
    Image: () => null,
    Alert: { alert: native.alert },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
  };
});

vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));

vi.mock('@/session/SettingsGroupRows', async () => {
  const { createElement } = await import('react');
  return {
    SettingsGroup: ({ children }: { children: ReactNode }) => createElement('div', null, children),
    useSettingsRowStyles: () => ({ row: {}, rowLine: {}, rowLabel: {} }),
  };
});

vi.mock('@/theme', async () => {
  const { lightColors } = await import('@/theme/tokens');
  return {
    useTheme: () => ({ colors: lightColors, mode: 'light' }),
    useThemedStyles: (make: (colors: typeof lightColors) => unknown) => make(lightColors),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppIconSettings } from '@/settings/AppIconSettings.ios';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  store.clear();
  native.supported = true;
  native.current = null;
  native.setIcon.mockReset();
  native.setIcon.mockResolvedValue(undefined);
  native.alert.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function renderScreen() {
  await act(async () => {
    root.render(<AppIconSettings />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const option = (key: 'default' | 'wordmark') =>
  host.querySelector(`[data-testid="settings.appIcon.option.${key}"]`)!;

describe('AppIconSettings', () => {
  it('系统不支持时不渲染入口', async () => {
    native.supported = false;
    await renderScreen();
    expect(host.innerHTML).toBe('');
  });

  it('挂载时以系统当前图标为准，并修正本地缓存', async () => {
    native.current = 'AppIcon-Wordmark';
    await renderScreen();
    expect(option('wordmark').getAttribute('aria-checked')).toBe('true');
    expect(store.get('xdt-maker.mobile.app-icon.v1')).toBe('wordmark');
  });

  it('选择后切换系统图标并写入偏好', async () => {
    await renderScreen();
    await click(option('wordmark'));
    expect(native.setIcon).toHaveBeenCalledWith('AppIcon-Wordmark');
    expect(store.get('xdt-maker.mobile.app-icon.v1')).toBe('wordmark');
    expect(option('wordmark').getAttribute('aria-checked')).toBe('true');
  });

  it('系统拒绝切换时回滚选中态并提示', async () => {
    native.setIcon.mockRejectedValueOnce(new Error('nope'));
    await renderScreen();
    await click(option('wordmark'));
    expect(native.alert).toHaveBeenCalledWith(
      'settings.appearance.appIcon.label',
      'settings.appearance.appIcon.setFailed',
    );
    expect(option('default').getAttribute('aria-checked')).toBe('true');
    expect(store.has('xdt-maker.mobile.app-icon.v1')).toBe(false);
  });

  it('偏好保存失败时保留已生效的图标并提示', async () => {
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await renderScreen();
    await click(option('wordmark'));
    expect(native.alert).toHaveBeenCalledWith(
      'settings.appearance.appIcon.label',
      'settings.appearance.appIcon.saveFailed',
    );
    expect(option('wordmark').getAttribute('aria-checked')).toBe('true');
  });
});
