/**
 * HomeChromeDrawer —— 首页左上角系统菜单。
 *
 * 从左边滑出,不是下拉卡:现在只有设置一项,以后会往里加入口。
 * 树内 overlay(不用 RN Modal),避免和首页其它 Modal 抢 present/dismiss。
 * 动画 / 左滑关闭对齐 SessionListDrawer,遵循 reduce-motion。
 */
import { Settings } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  findNodeHandle,
  Image,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  motionDuration,
  motionEasing,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';

const DRAWER_CLOSE_DISTANCE_RATIO = 1 / 3;
const DRAWER_CLOSE_VELOCITY = -800;
const DRAWER_MAX_WIDTH = 320;
const DRAWER_WIDTH_RATIO = 0.82;

export function HomeChromeDrawer({
  closeInstant = false,
  onClose,
  onClosed,
  onOpenSettings,
  open,
  user,
}: {
  /** 去设置时为 true:抽屉留在原地被设置页盖住,自己不播关闭动画。 */
  closeInstant?: boolean;
  onClose(): void;
  onClosed?(): void;
  onOpenSettings(): void;
  open: boolean;
  user: { avatar: string | null; email: string | null; name: string } | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const reduceMotion = useReduceMotionEnabled();
  const panelWidth = Math.max(
    1,
    Math.min(DRAWER_MAX_WIDTH, Math.round(screenWidth * DRAWER_WIDTH_RATIO)) + insets.left,
  );

  const [mounted, setMounted] = useState(open);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const openRef = useRef(open);
  openRef.current = open;
  const progress = useSharedValue(open ? 1 : 0);
  const dragX = useSharedValue(0);

  const finishClose = useCallback(() => {
    if (openRef.current) return;
    setMounted(false);
  }, []);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const wasMountedRef = useRef(mounted);
  useEffect(() => {
    const wasMounted = wasMountedRef.current;
    wasMountedRef.current = mounted;
    if (!wasMounted || mounted) return;
    onClosedRef.current?.();
  }, [mounted]);

  const settingsButtonRef = useRef<View>(null);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const node = findNodeHandle(settingsButtonRef.current);
      if (node != null) AccessibilityInfo.setAccessibilityFocus(node);
    }, motionDuration.enter);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    const animate = reduceMotion === false;
    if (open) {
      setMounted(true);
      const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
      progress.value = effective;
      dragX.value = 0;
      progress.value = animate
        ? withTiming(1, { duration: motionDuration.enter, easing: Easing.bezier(...motionEasing.out) })
        : 1;
      return;
    }
    if (!mountedRef.current) return;
    const effective = Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth));
    progress.value = effective;
    dragX.value = 0;
    if (!animate || closeInstant) {
      progress.value = 0;
      finishClose();
      return;
    }
    progress.value = withTiming(
      0,
      { duration: motionDuration.exit, easing: Easing.bezier(...motionEasing.in) },
      (finished) => {
        'worklet';
        if (finished) runOnJS(finishClose)();
      },
    );
  }, [closeInstant, dragX, finishClose, open, panelWidth, progress, reduceMotion]);

  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, open]);

  const closeFromGesture = useCallback(() => onClose(), [onClose]);
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(-16)
        .failOffsetX(16)
        .failOffsetY([-16, 16])
        .onUpdate((event) => {
          'worklet';
          dragX.value = Math.min(0, event.translationX);
        })
        .onEnd((event) => {
          'worklet';
          const shouldClose =
            event.translationX < -panelWidth * DRAWER_CLOSE_DISTANCE_RATIO
            || event.velocityX < DRAWER_CLOSE_VELOCITY;
          if (shouldClose) {
            runOnJS(closeFromGesture)();
          } else {
            dragX.value = withTiming(0, {
              duration: motionDuration.fast,
              easing: Easing.bezier(...motionEasing.move),
            });
          }
        }),
    [closeFromGesture, dragX, panelWidth],
  );

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, Math.min(1, progress.value + dragX.value / panelWidth)),
  }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: Math.max(
          -panelWidth,
          Math.min(0, (progress.value - 1) * panelWidth + dragX.value),
        ),
      },
    ],
  }));

  const openSettingsImmediately = useCallback(() => {
    onOpenSettings();
  }, [onOpenSettings]);

  const accountName = user?.name.trim() || user?.email?.trim() || t('settings.header.notSignedIn');
  const accountEmail = user?.email?.trim() && user.email.trim() !== accountName
    ? user.email.trim()
    : null;
  const avatarLabel = (accountName.trim()[0] ?? '?').toUpperCase();

  if (!mounted) return null;

  return (
    <View
      accessibilityViewIsModal
      pointerEvents="auto"
      style={styles.overlay}
      testID="home.chromeDrawer"
    >
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable
          accessibilityLabel={t('devices.list.a11y.closeMenu')}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.scrimPressable}
          testID="home.chromeMenu.backdrop"
        />
      </Animated.View>
      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            styles.panel,
            { paddingBottom: insets.bottom, paddingLeft: insets.left, paddingTop: insets.top, width: panelWidth },
            panelStyle,
          ]}
          testID="home.chromeMenu.panel"
        >
          <Pressable
            accessibilityLabel={accountEmail ? `${accountName}, ${accountEmail}` : accountName}
            accessibilityRole="button"
            onPress={openSettingsImmediately}
            style={({ pressed }) => [styles.accountRow, pressed && styles.pressed]}
            testID="home.chromeDrawer.account"
          >
            <View style={styles.avatar}>
              {user?.avatar ? (
                <Image source={{ uri: user.avatar }} style={styles.avatarImage} />
              ) : (
                <Text style={styles.avatarText}>{avatarLabel}</Text>
              )}
            </View>
            <View style={styles.accountTexts}>
              <Text numberOfLines={1} style={styles.accountName}>{accountName}</Text>
              {accountEmail ? (
                <Text numberOfLines={1} style={styles.accountEmail}>{accountEmail}</Text>
              ) : null}
            </View>
          </Pressable>

          <View style={styles.divider} />

          <Pressable
            accessibilityLabel={t('devices.list.a11y.openSettings')}
            accessibilityRole="button"
            onPress={openSettingsImmediately}
            ref={settingsButtonRef}
            style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
            testID="devices.settingsButton"
          >
            <Settings color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
            <Text numberOfLines={1} style={styles.menuLabel}>{t('devices.list.menu.settings')}</Text>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFill,
      zIndex: 40,
    },
    scrim: {
      ...StyleSheet.absoluteFill,
      backgroundColor: colors.overlay,
    },
    scrimPressable: {
      flex: 1,
    },
    panel: {
      backgroundColor: colors.surface,
      borderRightColor: colors.border,
      borderRightWidth: StyleSheet.hairlineWidth,
      bottom: 0,
      left: 0,
      position: 'absolute',
      top: 0,
    },
    accountRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.md,
      minHeight: 64,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    avatar: {
      alignItems: 'center',
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      height: 44,
      justifyContent: 'center',
      overflow: 'hidden',
      width: 44,
    },
    avatarImage: {
      height: 44,
      width: 44,
    },
    avatarText: {
      color: colors.textPrimary,
      fontSize: typeScale.subtitle,
      fontWeight: fontWeight.medium,
    },
    accountTexts: {
      flex: 1,
      gap: 2,
      minWidth: 0,
    },
    accountName: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    accountEmail: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    divider: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginHorizontal: spacing.lg,
    },
    menuRow: {
      alignItems: 'center',
      borderRadius: radius.container,
      flexDirection: 'row',
      gap: spacing.md,
      marginHorizontal: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.md,
    },
    menuLabel: {
      color: colors.textPrimary,
      flex: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
      minWidth: 0,
    },
    pressed: {
      opacity: 0.72,
    },
  });
