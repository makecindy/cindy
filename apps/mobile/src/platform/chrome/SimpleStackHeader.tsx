import { Stack } from "expo-router";
import { useTranslation } from 'react-i18next';
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
 * 简单页在 iOS 打开系统导航栏;Android 继续自绘 ScreenHeader(外观走安卓)。
 * 不变量:顶栏只放单行 title。iOS UINavigationBar 的 compact 标题槽没有
 * eyebrow / subtitle,Android 的交互与信息跟随 iOS,同样不显示。
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
  onBack,
  title,
  titleTestID,
  syncing,
}: {
  action?: MainWindowAction;
  right?: ReactNode;
  backTestID?: string;
  /**
   * @deprecated 两端都不渲染(iOS 系统顶栏无此槽,Android 跟随 iOS)。
   * 仅为存量调用点保留类型兼容;新代码不要传,需要的信息放进页面内容。
   */
  eyebrow?: string;
  onBack?: () => void;
  /** @deprecated 同 eyebrow:两端都不渲染,仅保留类型兼容。 */
  subtitle?: string | null;
  title: string;
  titleTestID?: string;
  syncing?: boolean;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeNativeTitleStyles);

  if (!usesNativeStackHeader()) {
    return (
      <ScreenHeader
        action={action}
        right={right}
        backTestID={backTestID}
        onBack={onBack}
        title={title}
        titleTestID={titleTestID}
        syncing={syncing}
      />
    );
  }

  return (
    <>
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
        headerRight: right ? () => right : action
          ? () => <MainWindowActionButton action={action} density="compact" />
          : undefined,
      }}
    />
    {onBack ? <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="chevron.backward" onPress={onBack} accessibilityLabel={t('shared.back')} />
    </Stack.Toolbar> : null}
    </>
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
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.body,
    },
  });
