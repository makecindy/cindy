import { Stack } from "expo-router";
import { ChevronDown, Ellipsis, Menu } from "lucide-react-native";
import { Pressable, StyleSheet, View } from "react-native";
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
import { lineHeight, spacing } from "@/theme/tokens";

/**
 * 首页 iOS 顶栏走系统 UINavigationBar。
 * 实底 surface,和列表同色;不要透明磨砂。Android 不渲染。
 */
export function HomeNativeStackHeader({
  displayA11y,
  displayActions,
  menuA11y,
  onDisplayAction,
  onOpenDeviceMenu,
  onOpenDisplaySettings,
  onOpenMenu,
  onSelectScope,
  scopeActions,
  showRemoteGuide,
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
  onSelectScope(id: string): void;
  scopeActions: readonly NativePullDownAction[];
  showRemoteGuide: boolean;
  title: string;
  titleA11y: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nativeMenus = usesNativePullDownMenu();

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
        <View style={styles.titleCluster}>
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          <ChevronDown
            color={colors.textSecondary}
            size={iconSize.xs}
            strokeWidth={iconStroke.medium}
          />
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
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.textPrimary,
          headerTransparent: false,
        }}
      />
      <Stack.Header
        style={{
          backgroundColor: colors.surface,
          color: colors.textPrimary,
          shadowColor: "transparent",
        }}
      />
      <Stack.Title asChild>{titleNode}</Stack.Title>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View>
          <Pressable
            accessibilityLabel={menuA11y}
            accessibilityRole="button"
            onPress={onOpenMenu}
            style={({ pressed }) => [styles.iconHit, pressed && styles.pressed]}
            testID="home.chromeMenu"
          >
            <Menu
              color={colors.textPrimary}
              size={iconSize.xl}
              strokeWidth={iconStroke.regular}
            />
          </Pressable>
        </Stack.Toolbar.View>
      </Stack.Toolbar>
      {showRemoteGuide ? null : (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.View>
            <NativePullDownMenu
              actions={displayActions}
              onAction={onDisplayAction}
            >
              <Pressable
                accessibilityLabel={displayA11y}
                accessibilityRole="button"
                onPress={nativeMenus ? () => undefined : onOpenDisplaySettings}
                style={({ pressed }) => [
                  styles.iconHit,
                  pressed && styles.pressed,
                ]}
                testID="home.displaySettingsButton"
              >
                <Ellipsis
                  color={colors.textPrimary}
                  size={iconSize.xl}
                  strokeWidth={iconStroke.regular}
                />
              </Pressable>
            </NativePullDownMenu>
          </Stack.Toolbar.View>
        </Stack.Toolbar>
      )}
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    iconHit: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    pressed: { opacity: 0.72 },
    title: {
      color: colors.textPrimary,
      flexShrink: 1,
      fontSize: typeScale.listTitle,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.listTitleCompact,
    },
    titleCluster: {
      alignItems: "center",
      flexDirection: "row",
      flexShrink: 1,
      gap: spacing.xs,
      maxWidth: 220,
      minWidth: 0,
    },
    titleHit: {
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
      minWidth: 44,
    },
  });
