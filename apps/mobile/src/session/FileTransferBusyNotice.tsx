/**
 * FileTransferBusyNotice —— 文件浏览页 / 预览页底部「正在从电脑导出…」的进行中提示。
 *
 * 导出期间一直显示(不自动消失),带「取消」:与桌面下载提示条的取消按钮同一语义,
 * 点了就停止导出,不再弹分享单,也不提示失败。
 */
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";

import { Text } from "@/components/AppText";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { lineHeight, spacing, typeScale } from "@/theme/tokens";

export function FileTransferBusyNotice({
  label,
  onCancel,
  testID,
}: {
  label: string;
  onCancel: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={styles.row} testID={testID}>
      <ActivityIndicator color={colors.textTertiary} size="small" />
      <Text style={styles.label}>{label}</Text>
      <MainWindowActionButton
        action={{
          label: t("files.browser.cancel"),
          onPress: onCancel,
          testID: testID ? `${testID}.cancel` : undefined,
        }}
        density="compact"
      />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      alignItems: "center",
      alignSelf: "center",
      flexDirection: "row",
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    label: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
  });
