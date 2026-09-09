import { requireOptionalNativeModule } from 'expo-modules-core';

export type IosBottomActionSheetOptions = {
  cancelButtonIndex: number;
  destructiveButtonIndex?: number;
  message?: string;
  options: readonly string[];
  title?: string;
  userInterfaceStyle?: 'light' | 'dark';
};

type IosActionSheetNativeModule = {
  show(options: IosBottomActionSheetOptions): Promise<number>;
};

const nativeModule = requireOptionalNativeModule<IosActionSheetNativeModule>(
  'XdtIosActionSheet',
);

export const iosBottomActionSheetAvailable = typeof nativeModule?.show === 'function';

/** iPhone 上走系统可拖底部 Sheet;模块未编进当前包时返回 null。 */
export function showIosBottomActionSheet(
  options: IosBottomActionSheetOptions,
): Promise<number> | null {
  if (!nativeModule?.show) return null;
  return nativeModule.show(options);
}
