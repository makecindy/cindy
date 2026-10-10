import { memo, useState, type ComponentProps, type ReactNode } from "react";
import { Stack } from "expo-router";
import { HomeHeaderGlassButton } from "@/session/HomeHeaderGlassButton";
import { QuietSyncIndicator } from '@/components/QuietSyncIndicator';
import { useDelayedConnectionNotice } from '@/components/ConnectionNoticeOverlay';
import { ChevronDown, Menu } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/AppText";
import {
  NativePullDownMenu,
  usesNativePullDownMenu,
  type NativePullDownAction,
} from "@/platform/chrome/NativePullDownMenu";
import { usesNativeStackHeader } from "@/platform/chrome/SimpleStackHeader";
import {
  fontWeight,
  iconSize,
  iconStroke,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { lineHeight, navigationChrome, spacing } from "@/theme/tokens";

/**
 * 首页 iOS 顶栏走系统 UINavigationBar。
 * 透明导航栏;设备标题使用与任务标题相同的轻磨砂胶囊。Android 不渲染。
 *
 * memo:系统顶栏(react-native-screens)每次选项变化都会整组重建 bar button item,展开中的
 * 菜单随之关闭。调用方须传稳定的 props(菜单内容无实质变化时保持同一引用),避免后台同步
 * 之类的无关重渲染把用户正在看的菜单关掉。
 */
export const HomeNativeStackHeader = memo(function HomeNativeStackHeader({
  displayA11y,
  displayActions,
  menuA11y,
  onDisplayAction,
  onOpenDeviceMenu,
  onOpenMenu,
  onOpenRemoteDesktop,
  remoteDesktopA11y,
  onSelectScope,
  scopeActions,
  showRemoteGuide,
  syncing = false,
  keepMenuTopLeft = false,
  title,
  titleA11y,
}: {
  displayA11y: string;
  displayActions: readonly NativePullDownAction[];
  menuA11y: string;
  onDisplayAction(id: string): void;
  onOpenDeviceMenu(): void;
  onOpenMenu(): void;
  onOpenRemoteDesktop?: () => void;
  remoteDesktopA11y: string;
  onSelectScope(id: string): void;
  scopeActions: readonly NativePullDownAction[];
  showRemoteGuide: boolean;
  syncing?: boolean;
  keepMenuTopLeft?: boolean;
  title: string;
  titleA11y: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nativeMenus = usesNativePullDownMenu();
  const { width } = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const barWidth = width - insets.left - insets.right;
  // UIKit owns where the title view sits and moves it whenever the toolbar
  // changes, without telling React, so the title never reads its position.
  // It only picks the title view's width; UIKit then places it predictably:
  // - a view that fits between mirrored side margins is centered on the bar;
  // - a view spanning the gap between the leading and trailing items is pinned
  //   against the trailing items (UIKit measured that gap at 204pt of 402 with
  //   one leading and two trailing items, see navigationTitleWidth).
  // With one item per side both are the same centered view. With the extra
  // remote-desktop action, a name that fits the mirrored width stays centered;
  // a longer one takes the gap, right-aligned, and grows into the spare room
  // beside the menu before it ellipsizes. Mirrored margins add UIKit's title
  // clearance, otherwise iOS 26 shifts the title toward the leading edge. The
  // cap keeps wide windows, whose bar margins differ, from clipping both ends.
  const trailingItems = showRemoteGuide ? 0 : onOpenRemoteDesktop ? 2 : 1;
  const mirroredWidth = Math.max(navigationChrome.target, Math.min(360,
    barWidth - (navigationChrome.target * Math.max(1, trailingItems) + spacing.lg * 2 + spacing.md) * 2));
  const gapWidth = Math.max(navigationChrome.target, Math.min(360,
    barWidth - navigationChrome.target * (1 + trailingItems) - spacing.lg * 4 - spacing.xs));
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
  // One delayed visibility for the glyph and its measured footprint, so a short
  // sync that never shows the glyph never moves the title either.
  const syncVisible = useDelayedConnectionNotice(syncing);
  const pinnedTrailing = trailingItems > 1
    && naturalWidth != null
    && naturalWidth > mirroredWidth - spacing.xs * 2;
  const titleWidth = showRemoteGuide ? Math.min(220, mirroredWidth)
    : trailingItems > 1 && !pinnedTrailing ? mirroredWidth : gapWidth;

  if (!usesNativeStackHeader()) return null;

  const titleNode = showRemoteGuide ? (
    <View style={styles.titleHit} testID="devices.title">
      <Text numberOfLines={1} style={styles.title}>
        Cindy
      </Text>
    </View>
  ) : (
    <NativePullDownMenu actions={scopeActions} onAction={onSelectScope}>
      <Pressable
        accessibilityLabel={titleA11y}
        accessibilityRole="button"
        onPress={nativeMenus ? undefined : onOpenDeviceMenu}
        onPressIn={nativeMenus ? undefined : onOpenDeviceMenu}
        style={({ pressed }) => [styles.titleHit, pinnedTrailing && styles.titleHitTrailing, pressed && styles.pressed]}
        testID="devices.title"
      >
        {/* The title sits directly on the bar: no capsule material behind it. */}
        <View style={styles.titleCluster}>
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          <ChevronDown
            color={colors.textSecondary}
            size={iconSize.xs}
            strokeWidth={iconStroke.medium}
          />
          <QuietSyncIndicator active={syncVisible} immediate />
        </View>
      </Pressable>
    </NativePullDownMenu>
  );
  // Unconstrained, invisible copy: its width decides centered vs pinned and
  // must not depend on the width that decision picks.
  const titleMeasure = showRemoteGuide ? null : (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.titleMeasureBox}
    >
      <View
        onLayout={(event) => setNaturalWidth(event.nativeEvent.layout.width)}
        style={styles.titleMeasureRow}
      >
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <ChevronDown size={iconSize.xs} strokeWidth={iconStroke.medium} />
        {/* Same footprint as the sync glyph, without a second accessible spinner. */}
        {syncVisible ? <View style={styles.titleMeasureSync} /> : null}
      </View>
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerBackVisible: false,
          headerShadowVisible: false,
          headerShown: true,
          headerStyle: { backgroundColor: "transparent" },
          headerTintColor: colors.textPrimary,
          headerTransparent: true,
          headerTitle: () => (
            <View style={[styles.titleFrame, { width: titleWidth }]}>
              {titleMeasure}
              {titleNode}
            </View>
          ),
        }}
      />
      <Stack.Header
        style={{
          backgroundColor: "transparent",
          color: colors.textPrimary,
          shadowColor: "transparent",
        }}
      />
      <Stack.Toolbar placement="left">
        {keepMenuTopLeft ? (
          // This home-only custom item stays at the top left on Duo. Hosting it
          // in the native bar keeps its hit target above the transparent header.
          <Stack.Toolbar.View hidesSharedBackground>
            <HomeHeaderGlassButton accessibilityLabel={menuA11y} onPress={onOpenMenu} testID="home.chromeMenu">
              <Menu color={colors.textPrimary} size={iconSize.action} strokeWidth={iconStroke.regular} />
            </HomeHeaderGlassButton>
          </Stack.Toolbar.View>
        ) : (
          <Stack.Toolbar.Button icon="line.3.horizontal" accessibilityLabel={menuA11y} onPress={onOpenMenu} />
        )}
      </Stack.Toolbar>
      {showRemoteGuide ? null : (
        <Stack.Toolbar placement="right">
          {onOpenRemoteDesktop ? <Stack.Toolbar.Button icon={require("../../../assets/navigation/monitor.png")} iconRenderingMode="template"
            accessibilityLabel={remoteDesktopA11y} onPress={onOpenRemoteDesktop} /> : null}
          <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={displayA11y}>
            {displayMenuItems(displayActions, onDisplayAction)}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      )}
    </>
  );
});

function displayMenuItems(actions: readonly NativePullDownAction[], onAction: (id: string) => void): ReactNode {
  return actions.map(action => action.subactions?.length ? (
    <Stack.Toolbar.Menu key={action.id} title={action.title} inline={action.displayInline}
      subtitle={action.subtitle}
      icon={action.image as ComponentProps<typeof Stack.Toolbar.Menu>['icon']}
      disabled={action.disabled} destructive={action.destructive}>
      {displayMenuItems(action.subactions, onAction)}
    </Stack.Toolbar.Menu>
  ) : (
    <Stack.Toolbar.MenuAction key={action.id} disabled={action.disabled}
      destructive={action.destructive} isOn={action.state === 'on'} subtitle={action.subtitle}
      icon={action.image as ComponentProps<typeof Stack.Toolbar.MenuAction>['icon']}
      unstable_keepPresented={action.keepPresented} onPress={() => onAction(action.id)}>
      {action.title}
    </Stack.Toolbar.MenuAction>
  ));
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    pressed: { opacity: 0.72 },
    titleFrame: {
      flexShrink: 1,
      justifyContent: "center",
      height: navigationChrome.target,
    },
    title: {
      color: colors.textPrimary,
      flexShrink: 1,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.title,
    },
    titleCluster: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 1,
      gap: spacing.xs,
      maxWidth: "100%",
      minWidth: 0,
    },
    titleHit: {
      paddingHorizontal: spacing.xs,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      minWidth: 44,
    },
    titleHitTrailing: { alignItems: "flex-end" },
    titleMeasureBox: {
      left: 0,
      opacity: 0,
      position: "absolute",
      top: 0,
      width: 2000,
    },
    titleMeasureRow: {
      alignItems: "center",
      alignSelf: "flex-start",
      flexDirection: "row",
      gap: spacing.xs,
    },
    titleMeasureSync: { height: iconSize.md, width: iconSize.md },
  });
