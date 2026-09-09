/**
 * 首页下拉菜单面板。
 * iOS 26+:GlassView 包住内容(和顶栏圆钮同一用法),写死宽度,圆角走系统玻璃。
 * 不要把玻璃绝对铺满,也不要对玻璃做透明度动画——会掏空底板。
 * 无系统玻璃时回退 BlurBackdrop + sheet 色卡片。
 */
import { GlassView } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import { useLiquidGlassAvailable } from '@/session/useLiquidGlassAvailable';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing } from '@/theme/tokens';

const MENU_WIDTH = 280;

export function HomeGlassMenuPanel({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID: string;
}) {
  const { colors, mode } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const liquidGlass = useLiquidGlassAvailable();

  return (
    <Pressable
      onPress={() => undefined}
      style={[styles.shell, liquidGlass ? styles.shellGlass : styles.shellSolid, style]}
      testID={testID}
    >
      {liquidGlass ? (
        <GlassView
          colorScheme={mode}
          glassEffectStyle="regular"
          isInteractive
          style={styles.glass}
        >
          <View style={styles.body}>{children}</View>
        </GlassView>
      ) : (
        <>
          <BlurBackdrop intensity={40} overlayColor={colors.sheetSurface} />
          <View style={styles.body}>{children}</View>
        </>
      )}
    </Pressable>
  );
}

/** 背板自己淡入淡出;玻璃面板不参与 opacity,避免 UIGlassEffect 被打成全透明。 */
export function HomeMenuScrim({
  backdropTestID,
  children,
  onClose,
  onShow,
  progress,
  topOffset,
  visible,
}: {
  backdropTestID: string;
  children: ReactNode;
  onClose(): void;
  onShow(): void;
  progress: Animated.Value;
  topOffset: number;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal animationType="none" onShow={onShow} transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.layer}>
        <Animated.View pointerEvents="none" style={[styles.dim, { opacity: progress }]} />
        <Pressable
          onPress={onClose}
          style={[styles.hit, { paddingTop: topOffset }]}
          testID={backdropTestID}
        >
          {children}
        </Pressable>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    shell: {
      overflow: 'hidden',
      width: MENU_WIDTH,
    },
    shellGlass: {
      borderRadius: radius.container,
    },
    shellSolid: {
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
    },
    glass: {
      borderRadius: radius.container,
      overflow: 'hidden',
      width: MENU_WIDTH,
    },
    body: {
      padding: spacing.sm,
      zIndex: 1,
    },
    layer: {
      flex: 1,
    },
    dim: {
      backgroundColor: colors.overlay,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    hit: {
      flex: 1,
      paddingHorizontal: spacing.lg,
    },
  });
