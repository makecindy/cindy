import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { cloneElement, isValidElement, type ReactNode } from "react";
import {
  NativeModules,
  Platform,
  UIManager,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { AnchoredPullDownMenu } from "@/platform/chrome/AnchoredPullDownMenu";
import { useTheme, type ThemeColors } from "@/theme";

export type NativePullDownAction = {
  disabled?: boolean;
  destructive?: boolean;
  displayInline?: boolean;
  id: string;
  image?: MenuAction["image"];
  keepPresented?: boolean;
  preferredElementSize?: "small" | "medium" | "large";
  state?: "on" | "off" | "mixed";
  subactions?: NativePullDownAction[];
  subtitle?: string;
  title: string;
};

let nativePullDownAvailable: boolean | null = null;

/**
 * 是否用「贴着触发控件弹出」的菜单:iOS 在包里编进 MenuView 时用系统 UIMenu(没冷更前
 * 自动退回调用方的自绘面板);Android 用 Compose DropdownMenu 的平台实现。
 */
export function usesNativePullDownMenu(): boolean {
  if (Platform.OS === "android") return true;
  if (Platform.OS !== "ios") return false;
  if (nativePullDownAvailable !== null) return nativePullDownAvailable;
  const config = UIManager.getViewManagerConfig?.("MenuView");
  nativePullDownAvailable = Boolean(config || NativeModules.MenuView);
  return nativePullDownAvailable;
}

function toMenuAction(
  action: NativePullDownAction,
  colors: ThemeColors,
): MenuAction {
  return {
    id: action.id,
    title: action.title,
    // Fabric defaults the library's optional Int32 imageColor to transparent.
    // Always pair a symbol with a visible semantic color.
    ...(action.image
      ? {
          image: action.image,
          imageColor: action.destructive
            ? colors.destructive
            : colors.textPrimary,
        }
      : {}),
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
      ? {
          subactions: action.subactions.map((item) =>
            toMenuAction(item, colors),
          ),
        }
      : {}),
  };
}

/** 至少有一项能点:禁用项不算,子菜单要其中还有能点的项。 */
export function hasActionablePullDownChoice(
  actions: readonly NativePullDownAction[],
): boolean {
  return actions.some(
    (action) =>
      !action.disabled &&
      (action.subactions?.length
        ? hasActionablePullDownChoice(action.subactions)
        : true),
  );
}

/** 子控件自己标了 disabled(如忙碌中的按钮)同样视为禁用。 */
function childDisabled(children: ReactNode): boolean {
  if (!isValidElement(children)) return false;
  return (children.props as { disabled?: unknown }).disabled === true;
}

/**
 * 收起时完全是调用方原来的按钮/标题;iOS 点开是系统 UIMenu 下拉,Android 是 Material
 * 下拉菜单(AnchoredPullDownMenu.android)。iOS 尚未编进 MenuView 的包只渲染 children,
 * 由调用方继续走自绘面板。
 */
export function NativePullDownMenu({
  accessibilityLabel,
  actions,
  children,
  disabled = false,
  longPress = false,
  onAction,
  style,
  testID,
}: {
  /** Android 触发器整块作为一个读屏按钮;不传时取子元素的 accessibilityLabel。 */
  accessibilityLabel?: string;
  actions: readonly NativePullDownAction[];
  children: ReactNode;
  /** 触发控件禁用时不挂菜单:菜单接管整块点按。子元素自带 disabled 时也会读取。 */
  disabled?: boolean;
  longPress?: boolean;
  onAction(id: string): void;
  /**
   * 菜单外层在父布局里的样式。外层替代子元素成为父布局的直接子节点,子元素原本
   * 依赖父布局的样式(如 flex: 1 占满标题区)要同时交给这里。
   */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { colors } = useTheme();
  if (disabled || childDisabled(children) || !usesNativePullDownMenu())
    return children;
  // 一项能点的都没有(空列表或全部禁用)时不挂菜单,触发控件也显示为禁用:
  // 调用方在有菜单时把自己的 onPress 置空,不禁用就会留下一个点了没反应的按钮。
  if (!hasActionablePullDownChoice(actions))
    return isValidElement<{ disabled?: boolean }>(children)
      ? cloneElement(children, { disabled: true })
      : children;
  if (Platform.OS === "android") {
    return (
      <AnchoredPullDownMenu
        accessibilityLabel={accessibilityLabel}
        actions={actions}
        longPress={longPress}
        onAction={onAction}
        style={style}
        testID={testID}
      >
        {children}
      </AnchoredPullDownMenu>
    );
  }
  return (
    <MenuView
      actions={actions.map((action) => toMenuAction(action, colors))}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event) onAction(nativeEvent.event);
      }}
      shouldOpenOnLongPress={longPress}
      style={style}
      testID={testID}
    >
      {children}
    </MenuView>
  );
}
