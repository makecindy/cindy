import type { ComponentProps, ReactNode } from "react";
import { Stack } from "expo-router";
import { HomeHeaderGlassButton } from "@/session/HomeHeaderGlassButton";
import { QuietSyncIndicator } from '@/components/QuietSyncIndicator';
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
 */
export function HomeNativeStackHeader({
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
  onOpenDisplaySettings(): void;
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
  // Keep the native title view's width independent of the selected device and
  // sync indicator. The guide only has the left menu; otherwise reserve the
  // two-action toolbar. Mirror that space, outer margin and UIKit's title
  // clearance on both sides. Without the extra clearance, iOS 26 moves
  // an otherwise centered title toward the leading edge to avoid the toolbar.
  const actionCount = showRemoteGuide ? 1 : 2;
  const sideSpace = navigationChrome.target * actionCount + spacing.lg * 2 + spacing.md;
  const titleWidth = Math.max(navigationChrome.target,
    Math.min(220, width - insets.left - insets.right - sideSpace * 2));

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
        style={({ pressed }) => [styles.titleHit, pressed && styles.pressed]}
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
          <QuietSyncIndicator active={syncing} />
        </View>
      </Pressable>
    </NativePullDownMenu>
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
}


function displayMenuItems(actions: readonly NativePullDownAction[], onAction: (id: string) => void): ReactNode {
  return actions.map(action => action.subactions?.length ? (
    <Stack.Toolbar.Menu key={action.id} title={action.title} inline={action.displayInline}
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
  });
