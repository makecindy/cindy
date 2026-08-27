import { Stack } from "expo-router";
import { Platform, StyleSheet, View } from "react-native";
import type { Edge } from "react-native-safe-area-context";
import { Text } from "@/components/AppText";
import {
  MainWindowActionButton,
  ScreenBackButton,
  ScreenHeader,
  type MainWindowAction,
} from "@/components/MobilePrimitives";
import {
  fontWeight,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { lineHeight } from "@/theme/tokens";

/** 简单页在 iOS 打开系统导航栏;Android 继续自绘 ScreenHeader。 */
export function usesNativeStackHeader(): boolean {
  return Platform.OS === "ios";
}

/** iOS 系统顶栏已吃掉顶部安全区,根 SafeAreaView 不要再垫 top。 */
export function simpleScreenSafeAreaEdges(): readonly Edge[] | undefined {
  return Platform.OS === "ios" ? ["left", "right", "bottom"] : undefined;
}

export function SimpleStackHeader({
  action,
  backTestID,
  eyebrow,
  onBack,
  subtitle,
  title,
  titleTestID,
}: {
  action?: MainWindowAction;
  backTestID?: string;
  eyebrow?: string;
  onBack?: () => void;
  subtitle?: string | null;
  title: string;
  titleTestID?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeNativeTitleStyles);

  if (!usesNativeStackHeader()) {
    return (
      <ScreenHeader
        action={action}
        backTestID={backTestID}
        eyebrow={eyebrow}
        onBack={onBack}
        subtitle={subtitle}
        title={title}
        titleTestID={titleTestID}
      />
    );
  }

  return (
    <Stack.Screen
      options={{
        headerShown: true,
        headerShadowVisible: false,
        headerBackVisible: false,
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.textPrimary,
        headerTitle: () => (
          <View style={styles.wrap} testID={titleTestID}>
            {eyebrow ? (
              <Text numberOfLines={1} style={styles.eyebrow}>
                {eyebrow}
              </Text>
            ) : null}
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} style={styles.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        ),
        headerLeft: onBack
          ? () => (
              <ScreenBackButton
                compact
                onPress={onBack}
                testID={backTestID ?? "screen.backButton"}
              />
            )
          : undefined,
        headerRight: action
          ? () => <MainWindowActionButton action={action} density="compact" />
          : undefined,
      }}
    />
  );
}

const makeNativeTitleStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      alignItems: "center",
      maxWidth: 220,
    },
    eyebrow: {
      color: colors.textTertiary,
      fontSize: typeScale.micro,
      fontWeight: fontWeight.medium,
      letterSpacing: 0.4,
      lineHeight: lineHeight.caption,
      textTransform: "uppercase",
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: typeScale.caption,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
  });
