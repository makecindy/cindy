import AsyncStorage from '@react-native-async-storage/async-storage';

/** 本机偏好：系统里的 alternateIconName 才是真值，这里只做重装/恢复后的缓存。 */
export const APP_ICON_STORAGE_KEY = 'xdt-maker.mobile.app-icon.v1';

/** 资源集名称同时是运行时名称；改名会让已选用户回落到主图标。 */
export const APP_ICON_NATIVE_NAMES = {
  cat: 'AppIcon-Cat',
  wordmark: 'AppIcon-Wordmark',
  mark: 'AppIcon-Mark',
} as const;

export type AppIconChoice = 'default' | keyof typeof APP_ICON_NATIVE_NAMES;

export const APP_ICON_CHOICES = ['default', 'cat', 'wordmark', 'mark'] as const;

export function normalizeAppIconChoice(value: unknown): AppIconChoice {
  return typeof value === 'string' && (APP_ICON_CHOICES as readonly string[]).includes(value)
    ? (value as AppIconChoice)
    : 'default';
}

export function nativeNameForAppIcon(choice: AppIconChoice): string | null {
  return choice === 'default' ? null : APP_ICON_NATIVE_NAMES[choice];
}

export function appIconFromNativeName(name: string | null | undefined): AppIconChoice {
  if (!name) return 'default';
  const match = (Object.entries(APP_ICON_NATIVE_NAMES) as Array<[AppIconChoice, string]>).find(
    ([, nativeName]) => nativeName === name,
  );
  return match?.[0] ?? 'default';
}

export async function readAppIconPreference(): Promise<AppIconChoice> {
  try {
    return normalizeAppIconChoice(await AsyncStorage.getItem(APP_ICON_STORAGE_KEY));
  } catch {
    return 'default';
  }
}

/** `default` 表示没有覆盖：清掉键，与主题/气泡偏好的恢复默认语义一致。 */
export async function writeAppIconPreference(choice: AppIconChoice): Promise<void> {
  if (choice === 'default') {
    await AsyncStorage.removeItem(APP_ICON_STORAGE_KEY);
    return;
  }
  await AsyncStorage.setItem(APP_ICON_STORAGE_KEY, choice);
}
