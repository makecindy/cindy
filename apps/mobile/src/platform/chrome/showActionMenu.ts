import { isLiquidGlassAvailable } from "expo-glass-effect";
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

// 所有入口共用同一个原生 presenter。菜单关闭前忽略重复请求,也不把动作结果
// 共享给重复调用方,否则一次选择会执行多次预览/分享等副作用。
let actionMenuPresented = false;

/** iOS 无附着点的纯动作菜单走系统路径;其它端继续自绘。 */
export function usesSystemActionMenu(): boolean {
  return Platform.OS === "ios";
}

/**
 * 原生底部 Sheet 的内容透明,靠系统 Liquid Glass 材质托底。旧设计(iOS 26 以前、旧 SDK
 * 构建或兼容模式)下 Sheet 不画底色,菜单会和正文叠字,只能走 ActionSheetIOS。
 */
function nativeBottomSheetUsable(): boolean {
  if (!iosBottomActionSheetAvailable) return false;
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
}

function presentIosActionSheet(spec: IosActionSheetSpec): Promise<number> {
  const useNativeSheet = nativeBottomSheetUsable();
  if (__DEV__) {
    console.log(
      `[cindy-action-sheet] presenter=${useNativeSheet ? "native-sheet" : "fallback-ActionSheetIOS"}`,
    );
  }
  const native = useNativeSheet && showIosBottomActionSheet({
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
 * 当前包尚未编进原生模块、或系统没有 Liquid Glass 材质时回退 ActionSheetIOS。
 * 从用户手势回调里调用,不要从 useEffect 里调,避免 Strict Mode 弹两次。
 */
export async function showActionMenu<K extends string>(
  request: ChromeActionMenuRequest<K>,
): Promise<ChromeActionMenuResult<K>> {
  if (Platform.OS !== "ios" || actionMenuPresented) {
    return { kind: "cancel" };
  }
  actionMenuPresented = true;
  try {
    const spec = buildIosActionSheetSpec(request);
    // 原生 Sheet 的 promise 在关闭动画完成后才结算;异常也必须释放占用。
    const buttonIndex = await presentIosActionSheet(spec);
    return resolveIosActionSheetResult(spec, buttonIndex);
  } finally {
    actionMenuPresented = false;
  }
}

/** 确认框两端都用系统 Alert,这里只做统一入口。 */
export function showConfirm(input: {
  title: string;
  message?: string;
  cancelLabel: string;
  confirmLabel: string;
  destructive?: boolean;
  cancelable?: boolean;
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
    ], { cancelable: input.cancelable ?? false, onDismiss: () => resolve(false) });
  });
}
