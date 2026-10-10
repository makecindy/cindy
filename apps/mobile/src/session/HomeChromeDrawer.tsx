/**
 * HomeChromeDrawer —— 首页左上角系统菜单。
 *
 * 从左边滑出,不是下拉卡:承载搜索、设备管理、设置和账号入口。
 * 抽屉必须盖住整个窗口,所以不能是树内 overlay,两端都放进独立窗口:
 * - iOS 系统导航栏在 RN 内容之上,走 react-native-screens FullWindowOverlay
 *   (独立 UIWindow),不用 RN Modal,避免和首页其它 Modal 抢 present/dismiss。
 * - Android 宽屏常驻布局(折叠屏展开等)把首页列表挂在路由树之上的根层
 *   (ResidentHomeList),连接提示也在根层,树内 zIndex 越不过这些兄弟层;
 *   走透明 RN Modal(独立 Dialog 窗口),返回键由 onRequestClose 接管。
 * 新窗口里要自带 GestureHandlerRootView,左滑关闭才有效。动画遵循 reduce-motion。
 */
import { Building2, LogOut, Monitor, Plug, Search, Settings, UsersRound } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  DeviceEventEmitter,
  findNodeHandle,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { FullWindowOverlay } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { mobileInteractionStyles } from "@/components/mobileInteractionStyles";
import { MobileUserAvatar } from "@/components/MobileUserAvatar";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "@/platform/gestureHandler";
import { useReduceMotionEnabled } from "@/hooks/useReduceMotion";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
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
} from "@/theme/tokens";

import { PluginMenuUnreadDot } from '@/plugins/PluginMenuUnreadDot';
import { confirmLogout } from './confirmLogout';
import { HomeModeSwitch } from './HomeModeSwitch';
import type { HomeMode } from './homeViewPreferenceStore';

const DRAWER_CLOSE_DISTANCE_RATIO = 1 / 3;
const DRAWER_CLOSE_VELOCITY = -800;
const DRAWER_MAX_WIDTH = 320;
const DRAWER_WIDTH_RATIO = 0.82;

export function HomeChromeDrawer({
  closeInstant = false,
  onClose,
  onClosed,
  onOpenSearch,
  onOpenAccounts,
  onOpenDevices,
  onOpenPlugins,
  onOpenSettings,
  onLogout,
  hasRunningTasks = false,
  loggingOut = false,
  mode = 'tasks',
  onModeChange,
  open,
  user,
}: {
  /** 去设置时为 true:抽屉留在原地被设置页盖住,自己不播关闭动画。 */
  closeInstant?: boolean;
  onClose(): void;
  onClosed?(): void;
  onOpenSearch(): void;
  onOpenAccounts(): void;
  onOpenDevices(): void;
  onOpenPlugins?(): void;
  onOpenSettings(): void;
  /** 确认后才调用:抽屉内部先弹 confirmLogout,调用方不要再重复确认。 */
  onLogout(): void;
  /** 退出确认文案用:有运行中任务时额外说明任务会继续在电脑上运行。 */
  hasRunningTasks?: boolean;
  loggingOut?: boolean;
  mode?: HomeMode;
  onModeChange?(mode: HomeMode): void;
  open: boolean;
  user: {
    avatar: string | null;
    email: string | null;
    membershipKind: 'personal' | 'org';
    name: string;
    orgLogoUrl: string | null;
    orgName: string | null;
  } | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const reduceMotion = useReduceMotionEnabled();
  const panelWidth = Math.max(
    1,
    Math.min(DRAWER_MAX_WIDTH, Math.round(screenWidth * DRAWER_WIDTH_RATIO)) +
      insets.left,
  );

  const [mounted, setMounted] = useState(open);
  const [panelReady, setPanelReady] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const progress = useSharedValue(0);
  const dragStartProgress = useSharedValue(0);
  const dragging = useSharedValue(false);
  const targetOpen = useSharedValue(open);

  const finishClose = useCallback(() => {
    if (openRef.current) return;
    setMounted(false);
    setPanelReady(false);
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
    if (open && !mounted) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    // Wait for FullWindowOverlay to lay out before starting the first frame.
    if (open && !panelReady) return;
    runOnUI((opening: boolean, animate: boolean, instant: boolean) => {
      "worklet";
      targetOpen.value = opening;
      cancelAnimation(progress);
      if (!animate || (!opening && instant)) {
        progress.value = opening ? 1 : 0;
        if (!opening) runOnJS(finishClose)();
        return;
      }
      progress.value = withTiming(
        opening ? 1 : 0,
        {
          duration: opening ? motionDuration.enter : motionDuration.exit,
          easing: opening
            ? Easing.bezier(...motionEasing.out)
            : Easing.bezier(...motionEasing.in),
        },
        (finished) => {
          if (finished && !opening) runOnJS(finishClose)();
        },
      );
    })(open, reduceMotion === false, closeInstant);
  }, [closeInstant, finishClose, mounted, open, panelReady, progress, reduceMotion, targetOpen]);

  // Android 返回键落在抽屉的 Dialog 窗口上:
  // - 打开态:转成关闭。
  // - 退场动画期间(open 已 false、Dialog 还没卸载)这颗键属于底层页面:不能调
  //   onClose——调用方记下的待执行动作会被它清掉;RN Modal 会吞掉原生 back,
  //   这里把 hardwareBackPress 补发回 app 的返回键监听链,等价于抽屉已卸载时
  //   的按下(无人消费时走系统默认返回)。
  const requestClose = useCallback(() => {
    if (openRef.current) {
      onClose();
      return;
    }
    DeviceEventEmitter.emit("hardwareBackPress");
  }, [onClose]);

  const closeFromGesture = useCallback(() => onClose(), [onClose]);
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(open)
        .activeOffsetX(-16)
        .failOffsetX(16)
        .failOffsetY([-16, 16])
        .onStart(() => {
          "worklet";
          cancelAnimation(progress);
          dragging.value = true;
          dragStartProgress.value = progress.value;
        })
        .onUpdate((event) => {
          "worklet";
          progress.value = Math.max(0, Math.min(1,
            dragStartProgress.value + event.translationX / panelWidth,
          ));
        })
        .onEnd((event) => {
          "worklet";
          const shouldClose =
            progress.value < 1 - DRAWER_CLOSE_DISTANCE_RATIO ||
            event.velocityX < DRAWER_CLOSE_VELOCITY;
          if (shouldClose) {
            runOnJS(closeFromGesture)();
          } else {
            progress.value = reduceMotion === false ? withTiming(1, {
              duration: motionDuration.fast,
              easing: Easing.bezier(...motionEasing.move),
            }) : 1;
          }
        })
        .onFinalize((_event, success) => {
          "worklet";
          const wasDragging = dragging.value;
          dragging.value = false;
          if (success || !wasDragging || !targetOpen.value) return;
          // Interrupted gestures must not strand the panel halfway open.
          progress.value = reduceMotion === false ? withTiming(1, {
            duration: motionDuration.fast,
            easing: Easing.bezier(...motionEasing.move),
          }) : 1;
        }),
    [closeFromGesture, dragging, dragStartProgress, open, panelWidth, progress, reduceMotion, targetOpen],
  );

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
  }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: (progress.value - 1) * panelWidth,
      },
    ],
  }));

  const openSettingsImmediately = useCallback(() => {
    onOpenSettings();
  }, [onOpenSettings]);

  const accountName = user?.name.trim() || user?.email?.trim() || t('settings.header.notSignedIn');
  const isOrg = user?.membershipKind === 'org';
  const accountEmail = user?.email?.trim();
  const orgName = isOrg ? user?.orgName?.trim() : null;
  const requestLogout = () => {
    if (loggingOut) return;
    confirmLogout(t, hasRunningTasks, onLogout);
  };

  if (!mounted) return null;

  const overlay = (
    <View
      accessibilityViewIsModal
      pointerEvents="auto"
      style={styles.overlay}
      testID="home.chromeDrawer"
    >
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable
          accessibilityLabel={t("devices.list.a11y.closeMenu")}
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
            { width: panelWidth },
            panelStyle,
          ]}
          testID="home.chromeMenu.panel"
          onLayout={() => setPanelReady(true)}
        >
          <View style={[styles.panelContent, {
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingTop: insets.top + spacing.xl,
          }]}>
            <View style={styles.accountRow} testID="home.chromeDrawer.account">
              {/* Default letter avatar; the organisation logo is only the small icon below. */}
              <MobileUserAvatar name={accountName} />
              <View style={styles.accountTexts}>
                <Text numberOfLines={1} style={styles.accountName}>{accountName}</Text>
                {accountEmail && accountEmail !== accountName ? (
                  <Text numberOfLines={1} style={styles.accountEmail}>{accountEmail}</Text>
                ) : null}
                {orgName ? (
                  <View style={styles.organizationRow}>
                    {user?.orgLogoUrl ? (
                      <Image source={{ uri: user.orgLogoUrl }} style={styles.organizationLogo} />
                    ) : (
                      <Building2 color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
                    )}
                    <Text numberOfLines={1} style={styles.organizationName}>{orgName}</Text>
                  </View>
                ) : null}
              </View>
            </View>

            <View style={styles.divider} />
            {onModeChange ? <HomeModeSwitch mode={mode} onModeChange={onModeChange} /> : null}

            <Pressable
              accessibilityLabel={t("devices.list.a11y.openSearch")}
              accessibilityRole="button"
              onPress={onOpenSearch}
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              testID="home.chromeDrawer.search"
            >
              <Search
                color={colors.textSecondary}
                size={iconSize.md}
                strokeWidth={iconStroke.regular}
              />
              <Text numberOfLines={1} style={styles.menuLabel}>
                {t("devices.list.menu.search")}
              </Text>
            </Pressable>

            {onOpenPlugins ? <Pressable accessibilityRole="button" accessibilityLabel={t('plugins.title')}
              onPress={onOpenPlugins} style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]} testID="home.chromeDrawer.plugins">
              <Plug color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              <Text numberOfLines={1} style={styles.menuLabel}>{t('plugins.title')}</Text>
              <PluginMenuUnreadDot active={open} />
            </Pressable> : null}

            <Pressable
              accessibilityLabel={t('devices.management.title')}
              accessibilityRole="button"
              onPress={onOpenDevices}
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              testID="home.chromeDrawer.devices"
            >
              <Monitor color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              <Text numberOfLines={1} style={styles.menuLabel}>{t('devices.management.title')}</Text>
            </Pressable>

            <Pressable
              accessibilityLabel={t("devices.list.a11y.openSettings")}
              accessibilityRole="button"
              onPress={openSettingsImmediately}
              ref={settingsButtonRef}
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              testID="devices.settingsButton"
            >
              <Settings
                color={colors.textSecondary}
                size={iconSize.md}
                strokeWidth={iconStroke.regular}
              />
              <Text numberOfLines={1} style={styles.menuLabel}>
                {t("devices.list.menu.settings")}
              </Text>
            </Pressable>

            <Pressable
              accessibilityLabel={t('devices.list.accounts.title')}
              accessibilityRole="button"
              onPress={onOpenAccounts}
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              testID="home.chromeDrawer.accounts"
            >
              <UsersRound color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
              <Text numberOfLines={1} style={styles.menuLabel}>{t('devices.list.accounts.title')}</Text>
            </Pressable>

            <View style={styles.menuDivider} />

            <Pressable
              accessibilityLabel={loggingOut
                ? t('settings.account.loggingOutAccessibility')
                : t('settings.account.logout')}
              accessibilityRole="button"
              accessibilityState={{ busy: loggingOut || undefined, disabled: loggingOut || undefined }}
              disabled={loggingOut}
              onPress={requestLogout}
              style={({ pressed }) => [
                styles.menuRow,
                pressed && styles.pressed,
              ]}
              testID="home.chromeDrawer.logout"
            >
              {/* 退出中只显示转圈(标签保留给读屏),不换成「正在退出」文字。 */}
              {loggingOut ? (
                <ActivityIndicator color={colors.destructive} size="small" />
              ) : (
                <>
                  <LogOut color={colors.destructive} size={iconSize.md} strokeWidth={iconStroke.regular} />
                  <Text numberOfLines={1} style={[styles.menuLabel, styles.dangerMenuLabel]}>
                    {t('settings.account.logout')}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );

  const content = (
    <GestureHandlerRootView style={styles.overlayHost}>
      {overlay}
    </GestureHandlerRootView>
  );

  if (Platform.OS === "ios") {
    return (
      <FullWindowOverlay unstable_accessibilityContainerViewIsModal>
        {content}
      </FullWindowOverlay>
    );
  }

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={requestClose}
      statusBarTranslucent
      transparent
      visible
    >
      {content}
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlayHost: {
      flex: 1,
    },
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
      backgroundColor: colors.surfaceElevated,
      borderTopRightRadius: radius.container,
      borderBottomRightRadius: radius.container,
      // Owner-approved floating-layer exception, confined to this navigation drawer.
      boxShadow: [{ offsetX: spacing.xs, offsetY: 0, blurRadius: spacing.xl, color: colors.homeDrawerShadow }],
      bottom: 0,
      left: 0,
      position: "absolute",
      top: 0,
    },
    panelContent: {
      flex: 1,
      borderTopRightRadius: radius.container,
      borderBottomRightRadius: radius.container,
      overflow: "hidden",
    },
    accountRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing.md,
      minHeight: 64,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    accountTexts: {
      flex: 1,
      gap: spacing.xs,
      minWidth: 0,
    },
    accountName: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.title,
    },
    accountEmail: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    organizationRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
    },
    organizationLogo: {
      width: iconSize.sm,
      height: iconSize.sm,
      borderRadius: radius.pill,
    },
    organizationName: {
      flexShrink: 1,
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    divider: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginHorizontal: spacing.lg,
    },
    menuDivider: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginHorizontal: spacing.lg,
      marginVertical: spacing.xs,
    },
    menuRow: {
      alignItems: "center",
      borderRadius: radius.container,
      flexDirection: "row",
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
    dangerMenuLabel: {
      color: colors.destructive,
    },
    pressed: mobileInteractionStyles.pressed,
  });
