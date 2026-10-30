import { Pressable, StyleSheet, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  iconSize,
  iconStroke,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from "@/theme/tokens";
import type { RemoteSession } from "./types";
import type { useSessionMenuUsage } from "./useSessionMenuUsage";
import { isSubscriptionUsageSource } from "./readSessionMenuAccountUsage";
import {
  accountUsageRows,
  formatSessionUsageMoney,
  sessionUsageAmounts,
} from "./sessionUsagePresentation";
import { formatModelShortLabel } from "./messageActions";

/**
 * 用量卡上的模型名:优先调用方从模型目录解析出的展示名;目录里找不到时把原始 id
 * 去掉路由前缀(如 `anthropic/`)再走与降级提示行同口径的短标签;都不行才回退原始 id。
 */
export function sessionUsageModelLabel(
  model: string | null | undefined,
  modelLabel?: string | null,
): string {
  const explicit = modelLabel?.trim();
  if (explicit) return explicit;
  const raw = model?.trim() ?? "";
  if (!raw) return "";
  const withoutRoutePrefix = raw.replace(/^[a-z0-9][a-z0-9.-]*\//i, "");
  return formatModelShortLabel(withoutRoutePrefix) || raw;
}

export function SessionUsageSummary({
  session,
  usage,
  contextUsage,
  onPress,
  detail = false,
  translucent = false,
  providerName,
  modelLabel,
}: {
  session: RemoteSession;
  usage: ReturnType<typeof useSessionMenuUsage>;
  contextUsage: unknown;
  onPress?: () => void;
  detail?: boolean;
  translucent?: boolean;
  providerName?: string;
  /** 模型目录里的用户可读展示名;缺席时按 sessionUsageModelLabel 兜底。 */
  modelLabel?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const amounts = sessionUsageAmounts(session, usage.estimate);
  const account = usage.account;
  const source = account?.source;
  const sourceLabel = providerName?.trim() || (
    !account?.accountOnly &&
    source &&
    source !== "api" &&
    source !== "unavailable"
      ? t(`session.menu.usage.source.${source}`)
      : null);
  // Overall and model-specific limits both constrain the task; never hide an exhausted one.
  const rows = accountUsageRows(account, t, i18n.language);
  const rawContext =
    contextUsage && typeof contextUsage === "object"
      ? (contextUsage as Record<string, unknown>)
      : {};
  // Session counters are live pushes; an earlier detail read must not freeze this summary.
  const contextTokens = [
    session.contextTokens,
    rawContext.totalTokens,
    rawContext.contextTokens,
  ].find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  const contextWindow = [
    session.contextWindow,
    rawContext.rawMaxTokens,
    rawContext.maxTokens,
    rawContext.maxContextTokens,
    rawContext.contextWindow,
  ].find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  const context =
    typeof contextTokens === "number" && typeof contextWindow === "number"
      ? `${Math.round(Math.min(100, Math.max(0, (contextTokens / contextWindow) * 100)))}%`
      : t("session.menu.usage.unavailable");
  const amountText = amounts.total
    ? formatSessionUsageMoney(amounts.total)
    : amounts.mixed
      ? t("session.menu.usage.seeDetails")
      : usage.loading
        ? t("session.menu.reading")
        : usage.estimateFailed
          ? t("session.menu.usage.unavailable")
          : t("session.menu.noSessionSpend");
  const caption =
    amounts.mixed || (!amounts.total && account?.accountOnly)
      ? t("session.menu.usage.taskUsage")
      : amounts.total?.kind === "value-estimate" ||
          (!amounts.total && isSubscriptionUsageSource(source))
        ? t("session.menu.usage.taskValue")
        : t("session.menu.usage.taskCost");
  const stale =
    usage.accountFailed ||
    (account?.updatedAt != null && Date.now() - account.updatedAt > 5 * 60_000);
  const content = (
    <>
      <View style={styles.heading}>
        <Text style={styles.source} numberOfLines={2}>
          {sessionUsageModelLabel(session.model, modelLabel)}{sourceLabel ? ` · ${sourceLabel}` : ""}
          {account?.plan && !account.accountOnly ? ` · ${account.plan}` : ""}
        </Text>
      </View>
      {rows.map((row, index) => (
        <View key={index} style={styles.quotaRow}>
          <View style={styles.row}>
            <Text style={styles.label}>{row.label}</Text>
            <Text style={[styles.value, row.warning && styles.warning]}>
              {row.value}
            </Text>
          </View>
          {row.detail ? <Text style={styles.note}>{row.detail}</Text> : null}
        </View>
      ))}
      {rows.length === 0 && source !== "api" ? (
        <Text style={styles.note}>
          {usage.loading && !usage.accountFailed
            ? t("session.menu.reading")
            : t("session.menu.usage.quotaUnavailable")}
        </Text>
      ) : null}
      {account?.updatedAt != null && stale ? (
        <Text style={styles.note}>
          {t("session.menu.usage.lastUpdated", {
            time: new Date(account.updatedAt).toLocaleString(i18n.language, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}
        </Text>
      ) : null}
      <View style={styles.metrics}>
        <View style={styles.metric}>
          <Text style={styles.label}>{caption}</Text>
          <Text style={styles.value}>{amountText}</Text>
        </View>
        {!detail ? (
          <View style={styles.metric}>
            <Text style={styles.label}>{t("session.menu.contextLabel")}</Text>
            <Text style={styles.value}>{context}</Text>
          </View>
        ) : null}
      </View>
      {usage.estimateFailed && amounts.total ? (
        <Text style={styles.note}>
          {t("session.menu.usage.valueUnavailable")}
        </Text>
      ) : null}
      {detail ? (
        <>
          {amounts.actual && amounts.actual.amount > 0 ? (
            <View style={styles.row}>
              <Text style={styles.label}>
                {t("session.menu.usage.actualCost")}
              </Text>
              <Text style={styles.value}>
                {formatSessionUsageMoney(amounts.actual)}
              </Text>
            </View>
          ) : null}
          {amounts.estimate && amounts.estimate.amount > 0 ? (
            <View style={styles.row}>
              <Text style={styles.label}>
                {t("session.menu.usage.estimatedValue")}
              </Text>
              <Text style={styles.value}>
                {formatSessionUsageMoney(amounts.estimate)}
              </Text>
            </View>
          ) : null}
          {amounts.estimate && amounts.estimate.amount > 0 ? (
            <Text style={styles.note}>
              {t("session.menu.usage.valueExplanation")}
            </Text>
          ) : null}
          {typeof session.totalTokenUsage === "number" ? (
            <View style={styles.row}>
              <Text style={styles.label}>
                {t("session.menu.usage.totalTokens")}
              </Text>
              <Text style={styles.value}>
                {session.totalTokenUsage.toLocaleString(i18n.language)}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}
    </>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("session.menu.sessionInfo")}
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        translucent && styles.translucent,
        styles.entry,
        pressed && styles.pressed,
      ]}
      testID="session.menuUsageRow"
    >
      <View style={styles.entryContent}>{content}</View>
      <ChevronRight
        accessible={false}
        color={colors.textTertiary}
        size={iconSize.md}
        strokeWidth={iconStroke.regular}
      />
    </Pressable>
  ) : (
    <View style={[styles.container, translucent && styles.translucent]} testID="session.usageDetails">
      {content}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.container,
      backgroundColor: colors.sheetActionSurface,
      borderColor: colors.sheetActionBorder,
      borderWidth: StyleSheet.hairlineWidth,
      minHeight: 44,
    },
    translucent: { backgroundColor: colors.surfaceTranslucent, borderWidth: 0 },
    entry: { flexDirection: "row", alignItems: "center" },
    entryContent: { flex: 1, minWidth: 0, gap: spacing.sm },
    heading: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    source: {
      flex: 1,
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    quotaRow: { gap: spacing.xs },
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      alignItems: "center",
      gap: spacing.xs,
    },
    label: {
      color: colors.textTertiary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
    },
    value: {
      color: colors.textPrimary,
      fontSize: typeScale.caption,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.medium,
      flexShrink: 1,
    },
    // 成句说明:§3「说明、提示」档 13/18 · 400 · textSecondary。
    note: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    metrics: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: spacing.sm,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.md,
    },
    metric: { flexGrow: 1, flexBasis: 0, minWidth: 100, gap: spacing.xs },
    warning: { color: colors.errorText },
    pressed: { opacity: 0.72 },
  });
