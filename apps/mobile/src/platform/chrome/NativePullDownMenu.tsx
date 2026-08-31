import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { type ReactNode } from "react";
import { NativeModules, Platform, UIManager } from "react-native";

export type NativePullDownAction = {
  disabled?: boolean;
  destructive?: boolean;
  displayInline?: boolean;
  id: string;
  keepPresented?: boolean;
  preferredElementSize?: "small" | "medium" | "large";
  state?: "on" | "off" | "mixed";
  subactions?: NativePullDownAction[];
  subtitle?: string;
  title: string;
};

let nativePullDownAvailable: boolean | null = null;

/** iOS 且当前包里已经编进 MenuView 时才挂 UIMenu;没冷更前自动退回自绘。 */
export function usesNativePullDownMenu(): boolean {
  if (Platform.OS !== "ios") return false;
  if (nativePullDownAvailable !== null) return nativePullDownAvailable;
  const config = UIManager.getViewManagerConfig?.("MenuView");
  nativePullDownAvailable = Boolean(config || NativeModules.MenuView);
  return nativePullDownAvailable;
}

function toMenuAction(action: NativePullDownAction): MenuAction {
  return {
    id: action.id,
    title: action.title,
    ...(action.subtitle ? { subtitle: action.subtitle } : {}),
    ...(action.state ? { state: action.state } : {}),
    ...(action.displayInline ? { displayInline: true } : {}),
    ...(action.preferredElementSize
      ? { preferredElementSize: action.preferredElementSize }
      : {}),
    ...(action.destructive || action.disabled || action.keepPresented
      ? {
          attributes: {
            ...(action.destructive ? { destructive: true } : {}),
            ...(action.disabled ? { disabled: true } : {}),
            ...(action.keepPresented ? { keepsMenuPresented: true } : {}),
          },
        }
      : {}),
    ...(action.subactions?.length
      ? { subactions: action.subactions.map(toMenuAction) }
      : {}),
  };
}

/**
 * 收起时完全是调用方原来的按钮/标题;iOS 点开是系统 UIMenu 下拉。
 * Android 或尚未冷更的包只渲染 children,由调用方继续走自绘面板。
 */
export function NativePullDownMenu({
  actions,
  children,
  longPress = false,
  onAction,
  testID,
}: {
  actions: readonly NativePullDownAction[];
  children: ReactNode;
  longPress?: boolean;
  onAction(id: string): void;
  testID?: string;
}) {
  if (!usesNativePullDownMenu()) return children;
  return (
    <MenuView
      actions={actions.map(toMenuAction)}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event) onAction(nativeEvent.event);
      }}
      shouldOpenOnLongPress={longPress}
      testID={testID}
    >
      {children}
    </MenuView>
  );
}
