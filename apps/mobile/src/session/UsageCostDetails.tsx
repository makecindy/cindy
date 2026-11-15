import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  usageCostTotals,
  type UsageCostRow,
} from "@cindy/maker-shared/usage-cost-details";
import { Text } from "@/components/AppText";
import { useThemedStyles, type ThemeColors } from "@/theme";
import { typeScale, lineHeight, fontWeight, spacing } from "@/theme/tokens";
import { formatSessionUsageMoney } from "./sessionUsagePresentation";

export function UsageCostDetails({
  rows,
}: {
  rows: UsageCostRow[] | null | undefined;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.content} testID="usage-cost-details">
      <Text style={styles.title}>{t("message.usageCost.title")}</Text>
      {rows == null ? (
        <Text style={styles.note}>
          {t(
            rows === undefined
              ? "message.usageCost.loading"
              : "message.usageCost.unavailable",
          )}
        </Text>
      ) : (
        ["conversation", "additional"].map((category) => {
          const group = rows.filter((row) => row.category === category);
          if (!group.length) return null;
          return (
            <View key={category} style={styles.content}>
              <View style={styles.row}>
                <Text style={styles.name}>
                  {t(`message.usageCost.${category}`)}
                </Text>
                <Text style={styles.amount}>
                  {usageCostTotals(group)
                    .map(formatSessionUsageMoney)
                    .join(" · ")}
                </Text>
              </View>
              {group.map((row, index) => (
                <View key={index}>
                  <View style={styles.row}>
                    <Text style={styles.model}>
                      {row.model || t("message.usageCost.unknownModel")}
                    </Text>
                    <Text style={styles.amount}>
                      {formatSessionUsageMoney(row.money)}
                    </Text>
                  </View>
                  <Text style={styles.note}>
                    {(row.providerName ||
                      (row.providerId !== "xd" ? row.providerId : "")) &&
                    row.providerName !==
                      t(
                        `message.usageCost.source.${row.billingSource ?? "unknown"}`,
                      )
                      ? `${row.providerName || row.providerId} · `
                      : ""}
                    {t(
                      `message.usageCost.source.${row.billingSource ?? "unknown"}`,
                    )}
                    {" · "}
                    {t(
                      row.money.kind === "value-estimate"
                        ? "message.usageCost.estimate"
                        : "message.usageCost.charged",
                    )}
                  </Text>
                </View>
              ))}
            </View>
          );
        })
      )}
      {rows?.length === 0 ? (
        <Text style={styles.note}>{t("message.usageCost.unavailable")}</Text>
      ) : null}
      <Text style={styles.note}>{t("message.usageCost.explanation")}</Text>
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    content: { gap: spacing.sm },
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
    },
    name: {
      color: colors.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.medium,
    },
    model: {
      flexShrink: 1,
      color: colors.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
    },
    amount: {
      color: colors.textSecondary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
    },
    note: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
  });
