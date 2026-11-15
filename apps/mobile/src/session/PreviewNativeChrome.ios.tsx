import type { ReactNode } from "react";
import { View } from "react-native";
import { Host } from "@expo/ui";
import {
  Button,
  HStack,
  Image,
  Menu,
  ProgressView,
  Text as NativeText,
} from "@expo/ui/swift-ui";
import {
  accessibilityHint,
  accessibilityLabel,
  buttonStyle,
  disabled,
  font,
  frame,
  labelStyle,
  lineLimit,
  menuIndicator,
  menuOrder,
  menuStyle,
  padding,
} from "@expo/ui/swift-ui/modifiers";
import { NativeChromeButton } from "@/platform/chrome/NativeChromeButton.ios";
import {
  useNativeGlassButtonStyle,
  useNativeGlassGroupStyle,
} from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { iconSize, navigationChrome, spacing, typeScale, useTheme } from "@/theme";
import {
  PreviewNativeGroupContext,
  type NativePreviewButtonProps,
  type NativePreviewHeaderProps,
} from "./PreviewNativeChrome.types";

/**
 * iOS 的预览外壳用 App 自己的原生玻璃控件(与任务页顶栏、首页、远程画面同一套):
 * 单个圆钮是 `NativeChromeButton`,成组按钮共用 `useNativeGlassGroupStyle` 的一枚玻璃胶囊,
 * 组内是 borderless 原生按钮,图标色由 Host 的 seedColor 统一。不另配一套玻璃参数。
 */
export const NATIVE_PREVIEW_CHROME = true;

const SIZE = navigationChrome.target;

function useHostProps() {
  const { colors, mode } = useTheme();
  return { colorScheme: mode, seedColor: colors.textPrimary, ignoreSafeArea: "all" } as const;
}

/** 组内一个按钮:与任务页顶栏右侧按钮组的按钮同一套修饰。 */
export function NativePreviewButton({
  label,
  systemImage,
  onPress,
  disabled: off = false,
  testID,
  hint,
  title,
}: NativePreviewButtonProps) {
  return (
    <Button
      label={title ?? label}
      systemImage={systemImage}
      onPress={onPress}
      testID={testID}
      modifiers={[
        labelStyle(title ? "titleAndIcon" : "iconOnly"),
        buttonStyle("borderless"),
        font({ size: title ? typeScale.footnote : iconSize.action, ...(title ? { weight: "medium" as const } : {}) }),
        ...(title ? [padding({ horizontal: spacing.md }), frame({ height: SIZE })] : [frame({ width: SIZE, height: SIZE })]),
        disabled(off),
        accessibilityLabel(label),
        ...(hint ? [accessibilityHint(hint)] : []),
      ]}
    />
  );
}

/** 组内不可点的文字(PDF 的「3 / 12」页码)。 */
export function NativePreviewLabel({ text }: { text: string }) {
  return (
    <NativeText
      modifiers={[
        font({ size: typeScale.footnote, weight: "medium" }),
        lineLimit(1),
        padding({ horizontal: spacing.xs }),
        frame({ height: SIZE }),
      ]}
    >
      {text}
    </NativeText>
  );
}

/**
 * 一组浮动按钮:一枚 App 共用的玻璃胶囊(useNativeGlassGroupStyle),组内 borderless 按钮。
 * 组里的子节点必须是原生控件:PreviewIconButton 等在组内会自动改画成原生按钮。
 */
export function NativePreviewGroup({ children }: { children: ReactNode }) {
  const host = useHostProps();
  const groupStyle = useNativeGlassGroupStyle();
  return (
    <PreviewNativeGroupContext.Provider value>
      <Host {...host} matchContents>
        <HStack spacing={0} modifiers={groupStyle}>
          {children}
        </HStack>
      </Host>
    </PreviewNativeGroupContext.Provider>
  );
}

/** 载入提示胶囊:系统转圈 + 文字,与工具胶囊同高、同一材质。 */
export function NativePreviewLoadingPill({
  label,
  testID,
}: {
  label: string;
  testID?: string;
}) {
  const host = useHostProps();
  const groupStyle = useNativeGlassGroupStyle();
  return (
    <Host {...host} matchContents>
      <HStack
        spacing={spacing.sm}
        testID={testID}
        modifiers={[
          padding({ horizontal: spacing.lg }),
          frame({ height: SIZE }),
          accessibilityLabel(label),
          ...groupStyle,
        ]}
      >
        <ProgressView />
        <NativeText modifiers={[font({ size: typeScale.footnote }), lineLimit(1)]}>
          {label}
        </NativeText>
      </HStack>
    </Host>
  );
}

/**
 * 顶栏:「关闭」是 App 共用的玻璃圆钮(与任务页返回键同一组件),文件名用按钮组同一材质的
 * 胶囊(与文件名一样宽、居中),「更多」与首页显示菜单同一写法的系统菜单圆钮。
 * 外层 RN 容器负责安全区与左右边距。
 */
export function NativePreviewHeader({
  name,
  onClose,
  closeLabel,
  closeDisabled,
  closeTestID,
  moreLabel,
  actions,
}: NativePreviewHeaderProps) {
  const host = useHostProps();
  const groupStyle = useNativeGlassGroupStyle();
  const circleStyle = useNativeGlassButtonStyle({ shape: "circle" });
  return (
    <View pointerEvents="box-none" style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
      <NativeChromeButton
        label={closeLabel}
        systemImage="xmark"
        onPress={onClose}
        disabled={closeDisabled}
        testID={closeTestID}
      />
      <View pointerEvents="box-none" style={{ flex: 1, minWidth: 0, alignItems: "center" }}>
        <Host {...host} matchContents style={{ maxWidth: "100%" }}>
          <NativeText
            testID="preview.title"
            modifiers={[
              font({ size: typeScale.body, weight: "semibold" }),
              lineLimit(1),
              padding({ horizontal: spacing.lg }),
              frame({ height: SIZE }),
              ...groupStyle,
            ]}
          >
            {name}
          </NativeText>
        </Host>
      </View>
      <Host {...host} style={{ width: SIZE, height: SIZE }}>
        <Menu
          testID="preview.more"
          label={<Image systemName="ellipsis" size={iconSize.action} />}
          modifiers={[
            menuStyle("button"),
            menuIndicator("hidden"),
            ...circleStyle,
            menuOrder("fixed"),
            accessibilityLabel(moreLabel),
          ]}
        >
          {actions.map((action) => (
            <Button
              key={action.key}
              label={action.label}
              onPress={action.onPress}
              modifiers={[disabled(!!action.disabled)]}
            />
          ))}
        </Menu>
      </Host>
    </View>
  );
}
