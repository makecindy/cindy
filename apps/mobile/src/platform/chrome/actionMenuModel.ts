/**
 * 纯动作菜单的平台无关模型。iOS 把它投影成 ActionSheetIOS 的 options 数组;
 * Android 仍走自绘卡片,不经过本文件的 present。
 */

export interface ChromeActionMenuItem<K extends string = string> {
  key: K;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export interface ChromeActionMenuRequest<K extends string = string> {
  title?: string;
  message?: string;
  items: readonly ChromeActionMenuItem<K>[];
  cancelLabel: string;
  userInterfaceStyle?: "light" | "dark";
}

export type ChromeActionMenuResult<K extends string = string> =
  { kind: "action"; key: K } | { kind: "cancel" };

export interface IosActionSheetSpec<K extends string = string> {
  options: string[];
  cancelButtonIndex: number;
  destructiveButtonIndex?: number;
  enabledKeys: K[];
  title?: string;
  message?: string;
  userInterfaceStyle?: "light" | "dark";
}

/** 去掉 disabled 项,把取消键钉在最后,供 ActionSheetIOS 使用。 */
export function buildIosActionSheetSpec<K extends string>(
  request: ChromeActionMenuRequest<K>,
): IosActionSheetSpec<K> {
  const enabled = request.items.filter((item) => item.disabled !== true);
  const options = [...enabled.map((item) => item.label), request.cancelLabel];
  const destructiveIndex = enabled.findIndex(
    (item) => item.destructive === true,
  );
  return {
    options,
    cancelButtonIndex: options.length - 1,
    ...(destructiveIndex >= 0
      ? { destructiveButtonIndex: destructiveIndex }
      : {}),
    enabledKeys: enabled.map((item) => item.key),
    ...(request.title ? { title: request.title } : {}),
    ...(request.message ? { message: request.message } : {}),
    ...(request.userInterfaceStyle
      ? { userInterfaceStyle: request.userInterfaceStyle }
      : {}),
  };
}

export function resolveIosActionSheetResult<K extends string>(
  spec: IosActionSheetSpec<K>,
  buttonIndex: number,
): ChromeActionMenuResult<K> {
  if (buttonIndex < 0 || buttonIndex === spec.cancelButtonIndex) {
    return { kind: "cancel" };
  }
  const key = spec.enabledKeys[buttonIndex];
  if (key === undefined) return { kind: "cancel" };
  return { kind: "action", key };
}
