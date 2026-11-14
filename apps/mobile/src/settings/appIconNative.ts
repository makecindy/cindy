import { requireOptionalNativeModule } from 'expo-modules-core';

/** `modules/cindy-app-icon` 的 JS 契约；旧包、Android、Web 上模块不存在。 */
export type AppIconNativeModule = {
  supportsAlternateIcons(): Promise<boolean>;
  getAlternateIconName(): Promise<string | null>;
  setAlternateIconName(name: string | null): Promise<void>;
};

export function getAppIconNative(): AppIconNativeModule | null {
  try {
    return requireOptionalNativeModule<AppIconNativeModule>('CindyAppIcon') ?? null;
  } catch {
    // 桥接缺失等同于不支持：不向用户暴露会失败的入口。
    return null;
  }
}
