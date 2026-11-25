import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  fontWeight, iconSize, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors,
} from "@/theme";
import { SheetModal } from "@/session/SheetModal";
import { SheetSurface } from "@/session/SheetSurface";
import { NewTaskSelectionRow } from "@/session/NewTaskSelectionRow";
import { computeContextSheetSnapHeights, type ContextSheetSnap } from "@/session/contextSheetModel";
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
  // Android system alerts show at most three buttons; the choices use the same bottom sheet and rows as
  // the new-task computer picker, so every option, Back and the backdrop work.
  const [picker, setPicker] = useState<"device" | "filter" | null>(null);
  const [snap, setSnap] = useState<ContextSheetSnap>("half");
  const insets = useSafeAreaInsets(), { height } = useWindowDimensions();
  const heights = useMemo(() => computeContextSheetSnapHeights({ screenHeight: height, safeAreaTopInset: insets.top }),
    [height, insets.top]);
  const open = (kind: "device" | "filter") => { setSnap("half"); setPicker(kind); };
  const close = () => setPicker(null);
  const chooseDevice = () => { if (market.targets.length > 1 && !market.installBusy) open("device"); };
  const chooseFilter = () => open("filter");
  const sheet = (
    <SheetModal nativePresentation visible={picker !== null} onRequestClose={close} onBackdropPress={close}>
      <SheetSurface title={t(picker === "device" ? "plugins.computer" : "plugins.market.filterLabel")} onClose={close}
        heights={heights} snap={snap} onSnapChange={setSnap} bottomInset={insets.bottom} testID="plugins.market.picker">
        {picker === "device" ? market.targets.map((host) => (
          <NewTaskSelectionRow key={host.deviceId} testID={`plugins.market.computer.${host.deviceId}`} title={host.deviceName}
            selected={host.deviceId === market.target?.deviceId}
            onPress={() => { close(); market.selectDevice(host.deviceId); }} />
        )) : picker === "filter" ? market.filters.map((option) => (
          <NewTaskSelectionRow key={option.value} testID={`plugins.market.filter.${option.value}`}
            title={t("plugins.market.filter." + option.value)}
            value={option.count !== undefined ? String(option.count) : undefined} selected={option.value === market.filter}
            // Unselected rows reserve the check mark's width so the counts line up in one column.
            trailing={option.value === market.filter ? undefined : <View style={styles.checkSpace} />}
            onPress={() => { close(); market.setFilter(option.value); }} />
        )) : null}
      </SheetSurface>
    </SheetModal>
  );
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
        </View>
      );
    if (state.kind === "conflict" || state.kind === "installed") return <View style={styles.progress} />;
    const label = state.kind === "unknown" ? t("plugins.management.checkResult")
      : state.kind === "failed" ? t("plugins.retry") : t("plugins.market.install");
    const disabled = state.kind === "unknown" ? !market.online : state.kind === "sourceUnverified" || !market.canInstall;
    return (
      <Pressable accessibilityRole="button" testID={`plugins.market.install.${item.pluginId}`}
        accessibilityLabel={state.kind === "idle" ? t("plugins.market.installAria", { name: item.name }) : label}
        accessibilityState={{ disabled }} disabled={disabled} hitSlop={{ top: 4, bottom: 4 }}
        onPress={() => { if (state.kind === "unknown") void market.checkResult(item); else market.install(item); }}
        style={[styles.pill, disabled && styles.unavailable]}>
        <Text style={styles.pillText}>{label}</Text>
      </Pressable>
    );
  };
  const row = (item: ManagedMarketItem) => {
    const state = market.rowState(item);
    const origin = pluginMarketOrigin(item);
    const line = state.kind === "waiting" ? t("plugins.market.waiting")
      : state.kind === "installing" ? t("plugins.market.installing")
      : state.kind === "failed" ? t(state.messageKey)
      : state.kind === "conflict" ? t("plugins.market.conflict")
        : state.kind === "sourceUnverified" ? t("plugins.market.sourceUnverifiedShort")
        : state.kind === "installed" ? t("plugins.market.alreadyInstalled")
        : state.kind === "unknown" ? t("plugins.market.resultUnknownDetail") : item.description ?? "";
    return (
      <View key={item.pluginId} style={styles.row}>
        <Pressable accessibilityRole="button" testID={`plugins.market.row.${item.pluginId}`}
          accessibilityLabel={t("plugins.detailsFor", { name: item.name })}
          onPress={() => market.openDetail(item)} style={styles.rowMain}>
          <PluginMarketIcon item={item} variant="row" />
          <View style={styles.rowText}>
            {/* The name may take two lines; the source label follows it, or wraps below it when a long label (German
                "Benutzerdefiniert") would otherwise squeeze the name. */}
            <View style={styles.titleRow}>
              <Text numberOfLines={2} style={styles.rowTitle}>{item.name}</Text>
              {origin ? <Text style={styles.badge}>{t("plugins.market.filter." + origin)}</Text> : null}
            </View>
            {/* Every state keeps the same two-line description slot, so rows never change height. */}
            <View testID={`plugins.market.line.${item.pluginId}`}>
              {/* Two invisible lines of the taller description style reserve the height at any font scale. */}
              <View style={styles.reserve} pointerEvents="none" accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants">
                <Text style={styles.preview}>{"\u00a0\n\u00a0"}</Text>
              </View>
              {line ? <Text numberOfLines={2}
                style={[state.kind === "idle" ? styles.preview : styles.note, styles.lineOverlay]}>{line}</Text> : null}
            </View>
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
      {sheet}
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
    reserve: { opacity: 0 },
    lineOverlay: { position: "absolute", top: 0, left: 0, right: 0 },
    checkSpace: { width: iconSize.lg },
    titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", columnGap: spacing.sm, rowGap: spacing.xs },
    rowTitle: {
      flexShrink: 1, fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.medium, color: c.textPrimary,
    },
    badge: {
      fontSize: typeScale.micro, lineHeight: lineHeight.micro, fontWeight: fontWeight.semibold, color: c.textSecondary,
      backgroundColor: c.surfaceChip, borderRadius: radius.pill, paddingHorizontal: spacing.sm, overflow: "hidden",
      // Centre the 16pt label on the 26pt first title line.
      marginTop: (lineHeight.subtitle - lineHeight.micro) / 2,
    },
    preview: {
      fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: c.textSecondary,
    },
    note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
    meta: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textTertiary },
    // Same footprint as the install button in every state, so the text column keeps its width.
    progress: { minWidth: 64, minHeight: 36, alignItems: "center", justifyContent: "center" },
    pill: {
      minHeight: 36, minWidth: 64, paddingHorizontal: spacing.lg, borderRadius: radius.pill,
      alignItems: "center", justifyContent: "center", backgroundColor: c.surfaceChip,
    },
    pillText: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: c.textPrimary },
    unavailable: { opacity: 0.5 },
    more: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  });
