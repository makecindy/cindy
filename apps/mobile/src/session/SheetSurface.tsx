/**
 * SheetSurface —— 可拖动底部浮窗的「面板表面」(从 ContextSheet 抽出,非 Modal)。
 *
 * 结构:grabber + header(子视图返回 ChevronLeft + 居中标题;根视图无关闭键——把手下拉
 * 与点背板关闭已足够)+ 可选 pinnedTop 固定插槽
 * (钉在 header 下、滚动区上,如模型搜索框)+ ScrollView 内容 + 可选 footer 固定底部。
 * 拖动换档(half / full / 下拉 dismiss)沿用 useContextSheetDrag + contextSheetModel 纯函数。
 *
 * 为什么抽出:模型选择浮窗需要「单 Modal 内叠两层 sheet」(一级模型列表、二级模型选项/权限)。
 * RN 的 Modal 叠 Modal 在 iOS/Android 行为不可控(见 ModelPickerSheet 头注释),所以把
 * 「sheet 表面」做成普通组件,由调用方决定套 Modal(ContextSheet)还是在一个 Modal 里叠两层
 * (ModelPickerSheet)。snap 档位**受控**:状态由调用方持有(heights/snap/onSnapChange),
 * 不依赖「Modal 不可见时 children 是否卸载」的平台差异来重置。
 */
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react-native';
import { Pressable, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { GestureDetector } from '@/platform/gestureHandler';
import { Text } from '@/components/AppText';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import type { ContextSheetSnap, ContextSheetSnapHeights } from '@/session/contextSheetModel';
import { useContextSheetDrag } from '@/session/useContextSheetDrag';
import { fontWeight, iconSize, iconStroke, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

export interface SheetSurfaceProps {
  /** header 居中标题。 */
  title: string;
  /** 把手下拉 dismiss 的回调(二级浮窗场景传「回一级」)。 */
  onClose: () => void;
  /** 提供则 header 左侧显示返回键(ChevronLeft);不提供时左侧为对称占位 spacer。 */
  onBack?: () => void;
  /** 返回键的 a11y 文案(onBack 场景)。 */
  backAccessibilityLabel?: string;
  /** header 右侧插槽(如模型浮窗的权限小入口);缺省为对称占位 spacer。 */
  headerTrailing?: ReactNode;
  /** header 下、滚动区上的固定插槽(如搜索框);不传不占位。 */
  pinnedTop?: ReactNode;
  children: ReactNode;
  /** 固定在面板底部(滚动区之外)的操作区。 */
  footer?: ReactNode;
  /** 暴露内容 ScrollView(打开时滚动到选中行用);不传则内部自管。 */
  scrollRef?: RefObject<ScrollView | null>;
  /** 档位三件套(受控):heights 由调用方 useMemo computeContextSheetSnapHeights 保持身份稳定。 */
  heights: ContextSheetSnapHeights;
  snap: ContextSheetSnap;
  onSnapChange: (snap: ContextSheetSnap) => void;
  /** 底部安全区 padding(调用方传 insets.bottom)。 */
  bottomInset: number;
  /** 纯视觉变体；默认保留既有通用 sheet 外观，tasksheet 只给会话任务面板使用。 */
  variant?: SheetSurfaceVariant;
  testID?: string;
}

export type SheetSurfaceVariant = 'default' | 'tasksheet';

export function SheetSurface({
  title,
  onClose,
  onBack,
  backAccessibilityLabel,
  headerTrailing,
  pinnedTop,
  children,
  footer,
  scrollRef,
  heights,
  snap,
  onSnapChange,
  bottomInset,
  variant = 'default',
  testID,
}: SheetSurfaceProps) {
  const styles = useThemedStyles(makeSheetSurfaceStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const drag = useContextSheetDrag({
    heights,
    onDismiss: onClose,
    onSnapChange,
    snap,
  });

  return (
    <Animated.View
      style={[
        styles.sheet,
        variant === 'tasksheet' && styles.sheetTasksheet,
        { paddingBottom: bottomInset },
        drag.animatedStyle,
      ]}
      testID={testID}
    >
      <BlurBackdrop
        intensity={32}
        overlayColor={variant === 'tasksheet' ? colors.sheetSurface : colors.surfaceGlassPanel}
      />
      <GestureDetector gesture={drag.gesture}>
      <View collapsable={false} style={styles.dragZone} {...drag.panHandlers}>
        <SheetGrabber variant={variant} />
        <View style={styles.header}>
          {onBack ? (
            <Pressable
              accessibilityLabel={backAccessibilityLabel ?? t('shared.back')}
              accessibilityRole="button"
              hitSlop={8}
              onPress={onBack}
              style={styles.headerButton}
              testID={testID ? `${testID}.back` : undefined}
            >
              <ChevronLeft color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
            </Pressable>
          ) : (
            <View style={styles.headerSpacer} />
          )}
          <View pointerEvents="none" style={styles.headerTitleOverlay}>
            <Text numberOfLines={1} style={styles.headerTitle}>{title}</Text>
          </View>
          {headerTrailing ?? <View style={styles.headerSpacer} />}
        </View>
      </View>
      </GestureDetector>
      {pinnedTop ? <View style={styles.pinnedTop}>{pinnedTop}</View> : null}
      <ScrollView
        contentContainerStyle={styles.contentScrollContent}
        keyboardShouldPersistTaps="handled"
        ref={scrollRef}
        style={styles.contentScroll}
        testID={testID ? `${testID}.scroll` : undefined}
      >
        {children}
      </ScrollView>
      {footer ? (
        <View style={styles.footer} testID={testID ? `${testID}.footer` : undefined}>
          {footer}
        </View>
      ) : null}
    </Animated.View>
  );
}

/**
 * 底部 sheet 的把手横条(grabber)。SheetSurface 内部与 ad-hoc 面板(会话页队列 / 搜索 sheet
 * 等不接拖动手势、只要视觉暗示的面板)共用同一份样式,避免各处手写漂移。
 * `style` 供 ad-hoc 场景补容器差异(如 SheetSurface 里 paddingTop 由 dragZone 提供,
 * ad-hoc 面板需自带 paddingTop)。
 */
export function SheetGrabber({
  style,
  variant = 'default',
}: {
  style?: StyleProp<ViewStyle>;
  variant?: SheetSurfaceVariant;
}) {
  const styles = useThemedStyles(makeSheetSurfaceStyles);
  return (
    <View style={[styles.grabberWrap, style]}>
      <View style={[styles.grabber, variant === 'tasksheet' && styles.grabberTasksheet]} />
    </View>
  );
}

const SHEET_HORIZONTAL_PADDING = 20;

function makeSheetSurfaceStyles(colors: ThemeColors) {
  return {
    // 水平 padding 不加在 sheet 容器上,而是下放到 dragZone / pinnedTop / 滚动内容 / footer:
    // ScrollView 需要撑满面板宽,否则竖向滚动指示条会内缩 20px、悬在内容右缘。
    sheet: {
      backgroundColor: 'transparent',
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      overflow: 'hidden' as const,
    },
    sheetTasksheet: {
      backgroundColor: 'transparent',
    },
    dragZone: {
      paddingHorizontal: SHEET_HORIZONTAL_PADDING,
      paddingTop: spacing.sm,
    },
    grabberWrap: {
      alignItems: 'center' as const,
      paddingBottom: 10,
    },
    grabber: {
      backgroundColor: colors.border,
      borderRadius: radius.pill,
      height: 5,
      width: 36,
    },
    grabberTasksheet: {
      backgroundColor: colors.sheetGrabber,
      width: 30,
    },
    header: {
      alignItems: 'center' as const,
      flexDirection: 'row' as const,
      height: 44,
      justifyContent: 'space-between' as const,
    },
    headerButton: {
      alignItems: 'center' as const,
      backgroundColor: colors.surfaceChip,
      borderRadius: radius.pill,
      height: 36,
      justifyContent: 'center' as const,
      width: 36,
    },
    // 标题绝对居中覆盖层:左右两侧宽度可以不对称(如权限入口比返回键宽),标题始终屏幕居中。
    // 两侧各留 44 避开按钮区;pointerEvents none 不挡拖动/点击。
    headerTitleOverlay: {
      alignItems: 'center' as const,
      bottom: 0,
      justifyContent: 'center' as const,
      left: 44,
      position: 'absolute' as const,
      right: 44,
      top: 0,
    },
    headerTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.semibold,
      textAlign: 'center' as const,
    },
    headerSpacer: {
      height: 36,
      width: 36,
    },
    pinnedTop: {
      paddingHorizontal: SHEET_HORIZONTAL_PADDING,
    },
    contentScroll: {
      flex: 1,
    },
    contentScrollContent: {
      paddingHorizontal: SHEET_HORIZONTAL_PADDING,
    },
    footer: {
      paddingHorizontal: SHEET_HORIZONTAL_PADDING,
      paddingTop: spacing.md,
    },
  };
}
