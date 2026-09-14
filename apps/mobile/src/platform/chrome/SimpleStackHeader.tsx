import { Stack } from "expo-router";
import { QuietSyncIndicator } from '@/components/QuietSyncIndicator';
import type { ReactNode } from "react";
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

/**
 * 简单页在 iOS 打开系统导航栏;Android 继续自绘 ScreenHeader。
 * 不变量:iOS UINavigationBar 的 compact 标题槽只放单行 title。
 * eyebrow / subtitle 仍传给 Android ScreenHeader,不进系统顶栏。
 */
export function usesNativeStackHeader(): boolean {
  return Platform.OS === "ios";
}

/** iOS 系统顶栏已吃掉顶部安全区,根 SafeAreaView 不要再垫 top。 */
export function simpleScreenSafeAreaEdges(): readonly Edge[] | undefined {
  return Platform.OS === "ios" ? ["left", "right", "bottom"] : undefined;
}

export function SimpleStackHeader({
  action,
  right,
  backTestID,
  eyebrow,
  onBack,
  subtitle,
  title,
  titleTestID,
  syncing,
}: {
  action?: MainWindowAction;
  right?: ReactNode;
  backTestID?: string;
  eyebrow?: string;
  onBack?: () => void;
  subtitle?: string | null;
  title: string;
  titleTestID?: string;
  syncing?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeNativeTitleStyles);

  if (!usesNativeStackHeader()) {
    return (
      <ScreenHeader
        action={action}
        right={right}
        backTestID={backTestID}
        eyebrow={eyebrow}
        onBack={onBack}
        subtitle={subtitle}
        title={title}
        titleTestID={titleTestID}
        syncing={syncing}
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
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            {syncing !== undefined ? <QuietSyncIndicator active={syncing} /> : null}
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
        headerRight: right ? () => right : action
          ? () => <MainWindowActionButton action={action} density="compact" />
          : undefined,
      }}
    />
  );
}

const makeNativeTitleStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: "center",
      maxWidth: 220,
    },
    title: {
      flexShrink: 1,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
  });
