import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  fontWeight, iconSize, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors,
} from "@/theme";
import { PluginNotice } from "./PluginNotice";
import { PluginMarketIcon } from "./PluginMarketIcon";
import { pluginMarketOrigin } from "./pluginMarketCatalog";
import type { ManagedMarketItem } from "./pluginManagementTypes";
import type { PluginMarketModel } from "./usePluginMarket";

/**
 * Android market list inside the plugin directory's ScrollView. iOS renders the
 * same model with SwiftUI rows (`PluginMarketRows.ios.tsx`).
 */
export function PluginMarketSection({ market, onConnectComputer }: {
  market: PluginMarketModel;
  onConnectComputer(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const device = market.target?.deviceName ?? "";
  const chooseDevice = () => {
    if (market.targets.length < 2 || market.installBusy) return;
    Alert.alert(t("plugins.computer"), undefined, [
      ...market.targets.map((host) => ({ text: host.deviceName, onPress: () => market.selectDevice(host.deviceId) })),
      { text: t("plugins.cancel"), style: "cancel" as const },
    ]);
  };
  const chooseFilter = () => Alert.alert(t("plugins.market.filterLabel"), undefined, [
    ...market.filters.map((option) => ({
      text: t("plugins.market.filter." + option.value) + (option.count !== undefined ? " " + option.count : ""),
      onPress: () => market.setFilter(option.value),
    })),
    { text: t("plugins.cancel"), style: "cancel" as const },
  ]);
  const control = (label: string, onPress: () => void, testID: string, enabled = true) => (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !enabled }} testID={testID}
      onPress={onPress} disabled={!enabled} style={styles.control}>
      <Text numberOfLines={1} style={styles.controlText}>{label}</Text>
      {enabled ? <ChevronDown size={iconSize.sm} color={colors.textSecondary} /> : null}
    </Pressable>
  );
  const status = (() => {
    switch (market.status) {
      case "noComputer":
        return <PluginNotice testID="plugins.market.noComputer" title={t("plugins.noComputer")}
          actions={[{ label: t("plugins.connectComputer"), onPress: onConnectComputer }]} />;
      case "offline":
        return <PluginNotice testID="plugins.market.offline" icon="offline" title={t("plugins.market.offline", { device })} />;
      case "outdated":
        return <PluginNotice testID="plugins.market.outdated" icon="warning" title={t("plugins.market.outdated", { device })} />;
      case "failed":
        return <PluginNotice testID="plugins.market.failed" icon="warning" title={t("plugins.market.readFailed")}
          actions={[{ label: t("plugins.retry"), onPress: () => { void market.refresh(); }, testID: "plugins.market.retry" }]} />;
      case "loading":
        return <ActivityIndicator testID="plugins.market.loading" color={colors.textSecondary} />;
      default:
        return null;
    }
  })();
  const trailing = (item: ManagedMarketItem) => {
    const state = market.rowState(item);
    if (state.kind === "waiting" || state.kind === "installing")
      return (
        <View style={styles.progress} testID={`plugins.market.progress.${item.pluginId}`}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.note}>{t(state.kind === "waiting" ? "plugins.market.waiting" : "plugins.market.installing")}</Text>
        </View>
      );
    if (state.kind === "conflict" || state.kind === "installed") return null;
    const label = state.kind === "unknown" ? t("plugins.management.checkResult")
      : state.kind === "failed" ? t("plugins.retry") : t("plugins.market.install");
    const disabled = state.kind === "unknown" ? !market.online : !market.canInstall;
    return (
      <Pressable accessibilityRole="button" testID={`plugins.market.install.${item.pluginId}`}
        accessibilityLabel={state.kind === "idle" ? t("plugins.market.installAria", { name: item.name }) : label}
        accessibilityState={{ disabled }} disabled={disabled} hitSlop={{ top: 4, bottom: 4 }}
        onPress={() => { if (state.kind === "unknown") void market.checkResult(); else market.install(item); }}
        style={[styles.pill, disabled && styles.unavailable]}>
        <Text style={styles.pillText}>{label}</Text>
      </Pressable>
    );
  };
  const row = (item: ManagedMarketItem) => {
    const state = market.rowState(item);
    const origin = pluginMarketOrigin(item);
    const line = state.kind === "failed" ? t(state.messageKey)
      : state.kind === "conflict" ? t("plugins.market.conflict")
        : state.kind === "installed" ? t("plugins.market.alreadyInstalled")
        : state.kind === "unknown" ? t("plugins.market.resultUnknownDetail") : item.description ?? "";
    return (
      <View key={item.pluginId} style={styles.row}>
        <Pressable accessibilityRole="button" testID={`plugins.market.row.${item.pluginId}`}
          accessibilityLabel={t("plugins.detailsFor", { name: item.name })}
          onPress={() => market.openDetail(item)} style={styles.rowMain}>
          <PluginMarketIcon item={item} variant="row" />
          <View style={styles.rowText}>
            <View style={styles.inline}>
              <Text numberOfLines={1} style={styles.rowTitle}>{item.name}</Text>
              {origin ? <Text style={styles.badge}>{t("plugins.market.filter." + origin)}</Text> : null}
            </View>
            {line ? <Text numberOfLines={state.kind === "idle" ? 2 : 3}
              style={state.kind === "idle" ? styles.preview : styles.note}>{line}</Text> : null}
          </View>
        </Pressable>
        {trailing(item)}
      </View>
    );
  };
  return (
    <View style={styles.root} testID="plugins.market">
      <View style={styles.header}>
        {market.searching ? (
          <Text style={[styles.groupLabel, styles.flex]}>
            {t("plugins.market.title") + (market.total !== undefined ? " " + market.total : "")}
          </Text>
        ) : null}
        {market.target ? control(t("plugins.market.installTo", { device }), chooseDevice, "plugins.market.computer",
          market.targets.length > 1 && !market.installBusy) : null}
        {!market.searching && market.status === "ready" ? (
          <>
            <View style={styles.flex} />
            {control(t("plugins.market.filter." + market.filter), chooseFilter, "plugins.market.filter")}
          </>
        ) : null}
      </View>
      {status}
      {market.status === "ready" && market.notices.stale ? <Text style={styles.note}>{t("plugins.market.readFailed")}</Text> : null}
      {market.status === "ready" && market.notices.unavailable ? <Text style={styles.note}>{t("plugins.market.unavailable")}</Text> : null}
      {market.status === "ready" && market.notices.organizationKey ? <Text style={styles.note}>{t(market.notices.organizationKey)}</Text> : null}
      {market.status === "ready" && market.notices.unavailableCustomSources.length ? (
        <Text style={styles.note}>
          {t("plugins.market.customSourcesUnavailable", { names: market.notices.unavailableCustomSources.join(", ") })}
        </Text>
      ) : null}
      {market.status === "ready" && market.items.length ? (
        <View style={styles.groupCard}>{market.items.map(row)}</View>
      ) : null}
      {market.status === "ready" && !market.items.length && !market.hasMore && !market.loadingMore
        && !market.notices.unavailable ? <Text style={styles.preview}>{t("plugins.noResults")}</Text> : null}
      {market.status === "ready" && (market.loadingMore || market.refreshing)
        ? <ActivityIndicator color={colors.textSecondary} /> : null}
      {market.status === "ready" && market.hasMore && !market.loadingMore ? (
        <Pressable accessibilityRole="button" testID="plugins.market.loadMore" style={styles.more}
          onPress={market.loadMore}>
          <Text style={styles.controlText}>{t("plugins.market.loadMore")}</Text>
        </Pressable>
      ) : null}
      {market.status === "ready" && !market.hasMore && market.items.length && market.total !== undefined ? (
        <Text style={[styles.meta, styles.center]}>{t("plugins.market.allLoaded", { count: market.total })}</Text>
      ) : null}
    </View>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { gap: spacing.md },
    flex: { flex: 1 },
    center: { textAlign: "center" },
    header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44 },
    control: { flexDirection: "row", alignItems: "center", gap: spacing.xs, minHeight: 44, flexShrink: 1 },
    controlText: {
      flexShrink: 1, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: c.textPrimary,
    },
    groupLabel: {
      fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, color: c.textTertiary,
    },
    groupCard: { borderRadius: radius.container, backgroundColor: c.surfaceElevated, overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", paddingRight: spacing.md },
    rowMain: {
      flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 96,
      paddingHorizontal: spacing.md, paddingVertical: spacing.lg,
    },
    rowText: { flex: 1, gap: spacing.xs },
    inline: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    rowTitle: {
      flexShrink: 1, fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.medium, color: c.textPrimary,
    },
    badge: {
      fontSize: typeScale.micro, lineHeight: lineHeight.micro, fontWeight: fontWeight.semibold, color: c.textSecondary,
      backgroundColor: c.surfaceChip, borderRadius: radius.pill, paddingHorizontal: spacing.sm, overflow: "hidden",
    },
    preview: {
      fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: c.textSecondary,
    },
    note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
    meta: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textTertiary },
    progress: { flexDirection: "row", alignItems: "center", gap: spacing.xs, maxWidth: 120 },
    pill: {
      minHeight: 36, minWidth: 64, paddingHorizontal: spacing.lg, borderRadius: radius.pill,
      alignItems: "center", justifyContent: "center", backgroundColor: c.surfaceChip,
    },
    pillText: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: c.textPrimary },
    unavailable: { opacity: 0.5 },
    more: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  });
