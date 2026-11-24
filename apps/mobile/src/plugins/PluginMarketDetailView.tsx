import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import {
  fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors,
} from "@/theme";
import { PluginNotice } from "./PluginNotice";
import { PluginMarketIcon } from "./PluginMarketIcon";
import { PluginToolChips } from "./PluginToolChips";
import {
  pluginMarketFacts, pluginMarketOrigin, pluginMarketPublisherKey, pluginMarketSubtitle, pluginMarketTools,
} from "./pluginMarketCatalog";
import type { PluginMarketDetailState, PluginMarketModel } from "./usePluginMarket";

export interface PluginMarketDetailViewProps {
  detail: PluginMarketDetailState;
  market: PluginMarketModel;
}

/** Android market detail: the installed detail's hierarchy, with Install in place of the switch. */
export function PluginMarketDetailView({ detail, market }: PluginMarketDetailViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [toolsOverflow, setToolsOverflow] = useState(false);
  const item = detail.item;
  const state = market.rowState(item);
  const origin = pluginMarketOrigin(item);
  const publisher = pluginMarketPublisherKey(item);
  const tools = pluginMarketTools(detail.detail?.manifest);
  const device = detail.target.deviceName;
  const online = market.online && market.target?.deviceId === detail.target.deviceId;
  const pending = state.kind === "waiting" || state.kind === "installing";
  const primary = state.kind === "unknown" ? t("plugins.management.checkResult")
    : state.kind === "failed" ? t("plugins.retry") : t("plugins.market.install");
  const disabled = state.kind === "conflict" || (state.kind === "unknown" ? !online : !market.canInstall || !online);
  return (
    <ScrollView testID="plugins.market.detail" contentContainerStyle={styles.content}>
      {!online ? <PluginNotice icon="offline" testID="plugins.market.detailOffline" title={t("plugins.market.offline", { device })} /> : null}
      {detail.failed ? (
        <PluginNotice icon="warning" testID="plugins.market.detailFailed" title={t("plugins.loadFailed")}
          actions={[{ label: t("plugins.retry"), onPress: market.retryDetail, disabled: !online }]} />
      ) : null}
      {state.kind === "unknown" ? (
        <PluginNotice icon="warning" testID="plugins.market.resultUnknown" title={t("plugins.notice.title.resultUnknown")}
          detail={t("plugins.market.resultUnknownDetail")} />
      ) : null}
      <View style={styles.hero}>
        <PluginMarketIcon item={item} variant="hero" />
        <View style={styles.identityText}>
          <View style={styles.inline}>
            <Text style={[styles.title, styles.shrink]}>{item.name}</Text>
            {origin ? <Text style={styles.badge}>{t("plugins.market.filter." + origin)}</Text> : null}
          </View>
          <Text style={styles.note}>{pluginMarketSubtitle(item, t)}</Text>
        </View>
      </View>
      {pending ? (
        <View style={[styles.button, styles.secondary, styles.inline]} testID="plugins.market.detailProgress">
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.buttonText}>{t(state.kind === "waiting" ? "plugins.market.waiting" : "plugins.market.installing")}</Text>
        </View>
      ) : state.kind !== "conflict" ? (
        <Pressable testID="plugins.market.detailInstall" accessibilityRole="button" disabled={disabled}
          accessibilityState={{ disabled }}
          onPress={() => state.kind === "unknown" ? market.checkResult() : market.install(item, detail.detail)}
          style={[styles.button, styles.primary, disabled && styles.unavailable]}>
          <Text style={[styles.buttonText, styles.primaryText]}>{primary}</Text>
        </Pressable>
      ) : null}
      <Text style={[styles.note, styles.center]}>{t("plugins.market.installDestination", { device })}</Text>
      {state.kind === "failed" ? <Text style={styles.note}>{t(state.messageKey)}</Text> : null}
      {state.kind === "conflict" ? <Text style={styles.note}>{t("plugins.market.conflict")}</Text> : null}
      {publisher ? <Text style={styles.body}>{t(publisher)}</Text> : null}
      {item.description ? <Text style={styles.body}>{item.description}</Text> : null}
      {detail.loading ? <ActivityIndicator testID="plugins.market.detailLoading" color={colors.textSecondary} /> : null}
      {tools.length ? (
        <View style={styles.section} testID="plugins.market.tools">
          <View style={styles.inline}>
            <Text style={[styles.heading, styles.shrink]}>{t("plugins.detail.tools") + " · " + tools.length}</Text>
            {toolsOverflow ? (
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: toolsExpanded }}
                onPress={() => setToolsExpanded(!toolsExpanded)} style={styles.toggle}>
                <Text style={styles.toggleText}>{t(toolsExpanded ? "plugins.detail.showLess" : "plugins.detail.showAll")}</Text>
              </Pressable>
            ) : null}
          </View>
          <PluginToolChips key={item.pluginId} tools={tools} expanded={toolsExpanded} onOverflowChange={setToolsOverflow} />
        </View>
      ) : null}
      <View style={styles.section}>
        <Text style={styles.heading}>{t("plugins.market.securityTitle")}</Text>
        <View style={styles.card}><Text style={styles.note}>{t("plugins.market.securityBody")}</Text></View>
      </View>
      <View style={styles.section} testID="plugins.market.facts">
        <Text style={styles.heading}>{t("plugins.detail.details")}</Text>
        {pluginMarketFacts(item, t).map((fact) => (
          <View key={fact.key} style={styles.fact}>
            <Text style={styles.note}>{fact.title}</Text>
            <Text style={[styles.note, styles.shrink, styles.right]}>{fact.value}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { paddingHorizontal: spacing.lg + spacing.xs, paddingVertical: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
    hero: { flexDirection: "row", alignItems: "center", gap: spacing.lg, paddingTop: spacing.sm },
    identityText: { flex: 1, gap: spacing.xs },
    inline: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    shrink: { flexShrink: 1 },
    center: { textAlign: "center" },
    right: { textAlign: "right", flex: 1 },
    title: { fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold, color: c.textPrimary },
    badge: {
      fontSize: typeScale.micro, lineHeight: lineHeight.micro, fontWeight: fontWeight.semibold, color: c.textSecondary,
      backgroundColor: c.surfaceChip, borderRadius: radius.pill, paddingHorizontal: spacing.sm, overflow: "hidden",
    },
    note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
    body: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: c.textSecondary },
    heading: { fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, fontWeight: fontWeight.semibold, color: c.textPrimary },
    section: { gap: spacing.md, paddingTop: spacing.lg },
    card: { padding: spacing.lg, borderRadius: radius.container, backgroundColor: c.surfaceElevated },
    fact: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 44,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    button: { minHeight: 48, borderRadius: radius.pill, alignItems: "center", justifyContent: "center",
      paddingHorizontal: spacing.lg, gap: spacing.sm },
    primary: { backgroundColor: c.cta },
    secondary: { backgroundColor: c.surfaceChip, flexDirection: "row" },
    primaryText: { color: c.ctaText },
    buttonText: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold, color: c.textPrimary },
    unavailable: { opacity: 0.5 },
    toggle: { minWidth: 44, minHeight: 44, alignItems: "flex-end", justifyContent: "center" },
    toggleText: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular, color: c.textSecondary },
  });
