import type { ReactNode } from "react";
import { Host } from "@expo/ui";
import {
  Button,
  HStack,
  Image,
  Menu,
  ProgressView,
  Spacer,
  Text as NativeText,
} from "@expo/ui/swift-ui";
import {
  accessibilityHint,
  accessibilityLabel,
  background,
  buttonBorderShape,
  buttonStyle,
  contentShape,
  controlSize,
  disabled,
  font,
  frame,
  glassEffect,
  labelStyle,
  lineLimit,
  menuOrder,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { iconSize, spacing, typeScale, useTheme } from "@/theme";
import { useLiquidGlassAvailable } from "./useLiquidGlassAvailable";
import {
  PreviewNativeGroupContext,
  type NativePreviewButtonProps,
  type NativePreviewHeaderProps,
} from "./PreviewNativeChrome.types";

/** iOS 的预览按钮、玻璃、菜单与载入指示都用 SwiftUI 原生控件(与内置浏览器同一套)。 */
export const NATIVE_PREVIEW_CHROME = true;

const SIZE = 48;

/**
 * 系统玻璃:不压底色、不另配字色,由系统按背后内容决定玻璃明暗与图标颜色。
 * iOS 26 以前没有 Liquid Glass,退回主题实色圆角底。
 */
function useGlass() {
  const glass = useLiquidGlassAvailable();
  const { colors } = useTheme();
  return (shape: "capsule" | "circle", interactive: boolean) =>
    glass
      ? glassEffect({ glass: { variant: "regular", interactive }, shape })
      : background(
          colors.surfaceElevated,
          shape === "circle" ? shapes.circle() : shapes.capsule(),
        );
}

function useHostProps() {
  const { mode } = useTheme();
  return { colorScheme: mode, matchContents: true } as const;
}

/** 组内一个按钮:系统图标 + 可选文字;禁用、按压效果由系统绘制。 */
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
      onPress={onPress}
      testID={testID}
      modifiers={[
        buttonStyle("plain"),
        disabled(off),
        accessibilityLabel(label),
        ...(hint ? [accessibilityHint(hint)] : []),
      ]}
    >
      {title ? (
        <HStack
          spacing={spacing.sm}
          modifiers={[
            padding({ horizontal: spacing.md }),
            frame({ height: SIZE }),
            contentShape(shapes.rectangle()),
          ]}
        >
          <Image systemName={systemImage} size={iconSize.lg} />
          <NativeText modifiers={[font({ size: typeScale.footnote, weight: "medium" }), lineLimit(1)]}>
            {title}
          </NativeText>
        </HStack>
      ) : (
        <Image
          systemName={systemImage}
          size={iconSize.lg}
          // 整个 48pt 方块都可点:plain 按钮默认只有图标笔画本身能点中。
          modifiers={[frame({ width: SIZE, height: SIZE }), contentShape(shapes.rectangle())]}
        />
      )}
    </Button>
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
 * 一组浮动按钮:一枚可交互的系统玻璃胶囊(单个按钮时是圆钮),按下有系统的液态反馈。
 * 组里的子节点必须是原生控件:PreviewIconButton 等在组内会自动改画成原生按钮。
 */
export function NativePreviewGroup({ children }: { children: ReactNode }) {
  const glass = useGlass();
  const host = useHostProps();
  return (
    <PreviewNativeGroupContext.Provider value>
      <Host {...host}>
        <HStack spacing={0} modifiers={[glass("capsule", true)]}>
          {children}
        </HStack>
      </Host>
    </PreviewNativeGroupContext.Provider>
  );
}

/** 载入提示胶囊:系统转圈 + 文字,与工具胶囊同高。 */
export function NativePreviewLoadingPill({
  label,
  testID,
}: {
  label: string;
  testID?: string;
}) {
  const glass = useGlass();
  const host = useHostProps();
  return (
    <Host {...host}>
      <HStack
        spacing={spacing.sm}
        testID={testID}
        modifiers={[
          padding({ horizontal: spacing.lg }),
          frame({ height: SIZE }),
          accessibilityLabel(label),
          glass("capsule", false),
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
 * 顶栏:系统玻璃圆钮「关闭」、文件名(玻璃和文件名一样宽、居中)、系统菜单「更多」。
 * 外层 RN 容器负责安全区与左右边距,这里只画一行原生控件。
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
  const glass = useGlass();
  const { mode } = useTheme();
  const icon = (systemName: NativePreviewButtonProps["systemImage"]) => (
    <Image
      systemName={systemName}
      size={iconSize.lg}
      modifiers={[frame({ width: SIZE, height: SIZE }), contentShape(shapes.circle())]}
    />
  );
  return (
    <Host colorScheme={mode} style={{ flex: 1, height: SIZE }}>
      <HStack spacing={spacing.sm} modifiers={[frame({ maxWidth: Infinity, height: SIZE })]}>
        <Button
          onPress={onClose}
          testID={closeTestID}
          systemImage="xmark"
          label={closeLabel}
          modifiers={[
            labelStyle("iconOnly"),
            buttonStyle("glass"),
            buttonBorderShape("circle"),
            controlSize("extraLarge"),
            disabled(closeDisabled),
          ]}
        />
        <Spacer minLength={0} />
        <NativeText
          testID="preview.title"
          modifiers={[
            font({ size: typeScale.body, weight: "semibold" }),
            lineLimit(1),
            padding({ horizontal: spacing.lg }),
            frame({ height: SIZE }),
            glass("capsule", false),
          ]}
        >
          {name}
        </NativeText>
        <Spacer minLength={0} />
        <Menu
          label={icon("ellipsis")}
          testID="preview.more"
          modifiers={[
            buttonStyle("plain"),
            glass("circle", true),
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
      </HStack>
    </Host>
  );
}
