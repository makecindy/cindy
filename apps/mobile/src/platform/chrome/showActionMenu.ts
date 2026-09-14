import { ActionSheetIOS, Alert, Platform } from "react-native";
import {
  iosBottomActionSheetAvailable,
  showIosBottomActionSheet,
} from "xdt-ios-action-sheet";
import {
  buildIosActionSheetSpec,
  resolveIosActionSheetResult,
  type ChromeActionMenuRequest,
  type ChromeActionMenuResult,
  type IosActionSheetSpec,
} from "@/platform/chrome/actionMenuModel";

/** iOS 无附着点的纯动作菜单走系统路径;其它端继续自绘。 */
export function usesSystemActionMenu(): boolean {
  return Platform.OS === "ios";
}

function presentIosActionSheet(spec: IosActionSheetSpec): Promise<number> {
  if (__DEV__) {
    console.log(
      `[cindy-action-sheet] presenter=${iosBottomActionSheetAvailable ? "native-sheet" : "fallback-ActionSheetIOS"}`,
    );
  }
  const native = showIosBottomActionSheet({
    cancelButtonIndex: spec.cancelButtonIndex,
    options: spec.options,
    ...(spec.destructiveButtonIndex !== undefined
      ? { destructiveButtonIndex: spec.destructiveButtonIndex }
      : {}),
    ...(spec.message ? { message: spec.message } : {}),
    ...(spec.title ? { title: spec.title } : {}),
    ...(spec.userInterfaceStyle
      ? { userInterfaceStyle: spec.userInterfaceStyle }
      : {}),
  });
  if (native) return native;

  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: spec.options,
        cancelButtonIndex: spec.cancelButtonIndex,
        destructiveButtonIndex: spec.destructiveButtonIndex,
        title: spec.title,
        message: spec.message,
        userInterfaceStyle: spec.userInterfaceStyle,
      },
      (buttonIndex) => {
        resolve(buttonIndex);
      },
    );
  });
}

/**
 * 弹出系统动作菜单。只在 iOS 调用;Android 应渲染现有自绘 sheet。
 * 优先走系统底部 Sheet(UISheetPresentationController,抓手 + medium/large,可拖高度);
 * 当前包尚未编进原生模块时回退 ActionSheetIOS。
 * 从用户手势回调里调用,不要从 useEffect 里调,避免 Strict Mode 弹两次。
 */
export function showActionMenu<K extends string>(
  request: ChromeActionMenuRequest<K>,
): Promise<ChromeActionMenuResult<K>> {
  if (Platform.OS !== "ios") {
    return Promise.resolve({ kind: "cancel" });
  }
  const spec = buildIosActionSheetSpec(request);
  return presentIosActionSheet(spec).then((buttonIndex) =>
    resolveIosActionSheetResult(spec, buttonIndex),
  );
}

/** 确认框两端都用系统 Alert,这里只做统一入口。 */
export function showConfirm(input: {
  title: string;
  message?: string;
  cancelLabel: string;
  confirmLabel: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(input.title, input.message, [
      {
        style: "cancel",
        text: input.cancelLabel,
        onPress: () => resolve(false),
      },
      {
        style: input.destructive === true ? "destructive" : "default",
        text: input.confirmLabel,
        onPress: () => resolve(true),
      },
    ]);
  });
}
