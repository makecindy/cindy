import { useRef } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SheetModal } from "@/session/SheetModal";
import { Text } from "@/components/AppText";
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from "@/theme";
import type { PluginSlotEntry, PluginSlotHolder } from "./pluginManagementSlot";
import type { PluginCheckConclusion, PluginPendingCheck } from "./usePluginManagement";

/** One line of the list: an operation holding its computer's slot, a pending check, or both (the same operation). */
export interface PluginOperationLine {
  key: string;
  entry: PluginSlotEntry;
  who: PluginSlotHolder;
  check?: PluginPendingCheck;
}
const KIND: Record<PluginSlotEntry, string> = {
  "market-install": "marketInstall", update: "update", uninstall: "uninstall", "page-approval": "pageApproval",
  enable: "enable", "task-settings": "taskSettings",
};

/**
 * The page's unfinished operations (maintainer review 18:45), drawn from what each one kept (plugin, computer, entry,
 * operation), never from the directory or the market list: an item a filter, a later page or the installed filter
 * hides, a market removed since, or a computer not selected still has its line here. A pending check offers the two
 * things the person can do: look up the original operation ("Check result", unavailable while its computer is
 * offline, with the reason), or stop following it on this phone (nothing is sent to the computer).
 */
export function PluginPendingChecksSheet({ visible, lines, conclusions, isOnline, onClose, onOpenInstalled }: {
  visible: boolean;
  lines: PluginOperationLine[];
  conclusions: PluginCheckConclusion[];
  isOnline(deviceId: string): boolean;
  onClose(): void;
  onOpenInstalled(who: PluginSlotHolder, instanceKey: string): void;
}) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles);
  // Lines seen while open stay until it closes, so a check that ends here shows how it ended.
  const seen = useRef(new Map<string, PluginOperationLine>());
  if (!visible) seen.current.clear();
  for (const line of lines) seen.current.set(line.key, line);
  const shown = [...seen.current.values()];
  const live = new Set(lines.map((line) => line.key));
  const status = (line: PluginOperationLine) => {
    const check = line.check;
    if (!check) return t("plugins.checks.status.preparing");
    if (!isOnline(line.who.deviceId)) return t("plugins.checks.status.offline", { device: line.who.deviceName });
    if (check.state.busy && check.state.outcome === "unknown") return t("plugins.checks.status.checking");
    if (check.waiting || check.state.outcome === "unknown") return t("plugins.checks.status.waiting");
    return t(check.state.outcome === "confirmation" ? "plugins.checks.status.confirmation" : "plugins.checks.status.running");
  };
  const ended = (line: PluginOperationLine) => {
    const conclusion = line.check ? conclusions.find((item) => item.operationId === line.check!.operationId) : undefined;
    if (!conclusion) return { text: t(line.check ? "plugins.checks.result.untracked" : "plugins.checks.result.ended") };
    const text = conclusion.result === "notInstalled" ? t("plugins.market.unconfirmedNotInstalled")
      : conclusion.result === "mismatch" ? t("plugins.market.unconfirmedMismatch")
        : t("plugins.checks.result." + conclusion.result);
    return { text, instanceKey: conclusion.result === "installed" || conclusion.result === "succeeded" ? conclusion.instanceKey : undefined };
  };
  return (
    <SheetModal nativePresentation visible={visible} onRequestClose={onClose} onBackdropPress={onClose}>
      {visible ? <View style={styles.sheet} testID="plugins.checks">
        <Text style={styles.title} accessibilityRole="header">{t("plugins.checks.title")}</Text>
        <ScrollView contentContainerStyle={styles.list}>
          {shown.map((line) => {
            const check = live.has(line.key) ? line.check : undefined;
            const online = isOnline(line.who.deviceId);
            const over = !live.has(line.key) ? ended(line) : undefined;
            return (
              <View key={line.key} testID={"plugins.checks.item." + (line.check?.operationId ?? line.key)} style={styles.item}>
                <Text style={styles.name}>{line.who.name}</Text>
                <Text style={styles.meta}>{line.who.deviceName + " · " + t("plugins.checks.kind." + KIND[line.entry])}</Text>
                <Text testID="plugins.checks.status" style={styles.status}>{over ? over.text : status(line)}</Text>
                {check ? (
                  <>
                    <View style={styles.actions}>
                      <Pressable testID="plugins.checks.verify" accessibilityRole="button"
                        disabled={!online || check.state.busy}
                        accessibilityState={{ disabled: !online || check.state.busy }}
                        onPress={() => { void check.verify(); }}
                        style={[styles.button, styles.primary, (!online || check.state.busy) && styles.unavailable]}>
                        <Text style={[styles.label, styles.primaryText]}>{t("plugins.management.checkResult")}</Text>
                      </Pressable>
                      <Pressable testID="plugins.checks.stop" accessibilityRole="button" disabled={!check.canStop}
                        accessibilityState={{ disabled: !check.canStop }}
                        onPress={() => { check.stop(); }}
                        style={[styles.button, !check.canStop && styles.unavailable]}>
                        <Text style={styles.label}>{t("plugins.checks.stop")}</Text>
                      </Pressable>
                    </View>
                    <Text style={styles.hint}>{t("plugins.checks.stopHint")}</Text>
                  </>
                ) : over?.instanceKey ? (
                  <View style={styles.actions}>
                    <Pressable testID="plugins.checks.open" accessibilityRole="button"
                      onPress={() => onOpenInstalled(line.who, over.instanceKey!)} style={[styles.button, styles.primary]}>
                      <Text style={[styles.label, styles.primaryText]}>{t("plugins.checks.open")}</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
        <Pressable testID="plugins.checks.close" accessibilityRole="button" onPress={onClose} style={styles.button}>
          <Text style={styles.label}>{t("plugins.checks.close")}</Text>
        </Pressable>
      </View> : null}
    </SheetModal>
  );
}

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  sheet: {
    maxHeight: "85%", gap: spacing.md, backgroundColor: c.surfaceElevated,
    borderTopLeftRadius: radius.container, borderTopRightRadius: radius.container, padding: spacing.lg + spacing.xs,
  },
  title: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.semibold, color: c.textPrimary },
  list: { gap: spacing.lg },
  item: { gap: spacing.xs },
  name: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.semibold, color: c.textPrimary },
  meta: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: c.textSecondary },
  status: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: c.textPrimary },
  hint: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: c.textSecondary },
  // Wraps to a second row when both labels do not fit (large text, long translations).
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs },
  button: {
    flexGrow: 1, minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md,
    borderRadius: radius.pill, backgroundColor: c.surfaceChip,
  },
  primary: { backgroundColor: c.cta },
  primaryText: { color: c.ctaText },
  label: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, color: c.textPrimary, textAlign: "center" },
  unavailable: { opacity: 0.5 },
});
