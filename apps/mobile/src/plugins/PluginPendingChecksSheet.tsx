import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SheetModal } from "@/session/SheetModal";
import { Text } from "@/components/AppText";
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { ScrollFade, ScrollThumb, useScrollOverflow } from "@/components/ScrollOverflow";
import { CONSENT_FADE_HEIGHT } from "./pluginConsentPresentation";
import type { PluginSlotEntry, PluginSlotHolder } from "./pluginManagementSlot";
import { PLUGIN_NOT_OPENED_TEXT } from "./pluginOperationOpens";
import { retryPluginCheckReadback, tellPluginConclusion, type PluginCheckConclusion, type PluginPendingCheck } from "./usePluginManagement";

/** One line of the list: an operation holding its computer's slot, a pending check, or both (the same operation). */
export interface PluginOperationLine {
  key: string;
  entry: PluginSlotEntry;
  who: PluginSlotHolder;
  check?: PluginPendingCheck;
  /**
   * A success the person has not been shown yet (`key` is its operation id; maintainer review 03:52), with where its
   * read of the computer is: shown as it ended so far ("could not read" with "Read again", reading, or the result).
   */
  concluded?: PluginCheckConclusion["readback"];
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
 * offline, with the reason), or stop following it on this phone (nothing is sent to the computer). One whose receipt
 * the computer no longer has and that nothing on the computer can prove (`unprovable`: an uninstall, a page approval)
 * shows what the computer has now and offers only "Stop tracking": checking again could not settle it.
 */
export function PluginPendingChecksSheet({ visible, lines, conclusions, isOnline, canOpen, onDecide, onClose, onOpenChecked, onShowInstalled }: {
  visible: boolean;
  lines: PluginOperationLine[];
  conclusions: PluginCheckConclusion[];
  isOnline(deviceId: string): boolean;
  /** The computer is still listed for this account (only there can an instance be opened). */
  canOpen(deviceId: string): boolean;
  /** "View and decide": opens the consent once its operation holds the computer's slot; false when it cannot. */
  onDecide(operationId: string): boolean;
  onClose(): void;
  /** "Open plugin": the page reads the computer once more and opens only what that read proves. */
  onOpenChecked(operationId: string): void;
  /** "Go to Installed": closes the list and shows the installed segment of the record's computer (V2.10 ③). */
  onShowInstalled(who: PluginSlotHolder): void;
}) {
  const { t } = useTranslation(), styles = useThemedStyles(makeStyles), { colors } = useTheme();
  const listArea = useScrollOverflow();
  // Lines seen while open stay until it closes, so a check that ends here shows how it ended.
  const seen = useRef(new Map<string, PluginOperationLine>());
  // A consent that could not be opened (another operation holds the computer's slot), per operation.
  const [blocked, setBlocked] = useState<string[]>([]);
  // Successes drawn here as settled: the person has seen how they ended once the list closes (they leave the notice).
  const settledSeen = useRef(new Set<string>());
  if (!visible) seen.current.clear();
  useEffect(() => {
    if (!visible) { setBlocked([]); return; }
    return () => { for (const operationId of settledSeen.current) tellPluginConclusion(operationId); settledSeen.current.clear(); };
  }, [visible]);
  for (const line of lines) seen.current.set(line.key, line);
  const shown = [...seen.current.values()];
  const live = new Set(lines.filter((line) => !line.concluded).map((line) => line.key));
  const status = (line: PluginOperationLine) => {
    const check = line.check;
    if (!check) return t("plugins.checks.status.preparing");
    if (!isOnline(line.who.deviceId)) return t("plugins.checks.status.offline", { device: line.who.deviceName });
    if (check.awaitingYou) return t("plugins.checks.status.awaitingYou");
    // The receipt is gone and nothing on the computer names this operation: what is there now, and why it stays open.
    if (check.unprovable) return t("plugins.checks.status.unprovable." + KIND[line.entry] + "."
      + (!check.unprovable.present ? "absent" : check.unprovable.pagesApproved === undefined ? "present"
        : check.unprovable.pagesApproved ? "approved" : "notApproved"));
    if (check.state.busy && check.state.outcome === "unknown") return t("plugins.checks.status.checking");
    if (check.waiting || check.state.outcome === "unknown") return t("plugins.checks.status.waiting");
    return t(check.state.outcome === "confirmation" ? "plugins.checks.status.confirmation" : "plugins.checks.status.running");
  };
  /**
   * How a line that left the list ended (dispatcher L-1, L-3): a success says whether the list's own read of the
   * computer found the instance (only then "Open", and only on a computer still listed), is still reading, did not find
   * it, or failed to read ("Read again"); an uninstall has nothing to open.
   */
  const ended = (line: PluginOperationLine): { text: string; open?: string; readAgain?: string; openUnavailable?: boolean; showInstalled?: boolean } => {
    const operationId = line.check?.operationId ?? (line.concluded ? line.key : undefined);
    const conclusion = operationId ? conclusions.find((item) => item.operationId === operationId) : undefined;
    if (!conclusion) return { text: t(line.check ? "plugins.checks.result.untracked" : "plugins.checks.result.ended") };
    if (conclusion.result === "notInstalled") return { text: t("plugins.market.unconfirmedNotInstalled") };
    if (conclusion.result === "mismatch") return { text: t("plugins.market.unconfirmedMismatch") };
    if (conclusion.result === "legacy") return { text: t("plugins.market.unconfirmedLegacy"), showInstalled: true };
    if (conclusion.result !== "succeeded" && conclusion.result !== "installed") return { text: t("plugins.checks.result." + conclusion.result) };
    if (conclusion.entry === "uninstall") return { text: t("plugins.checks.result.uninstalled") };
    const done = t("plugins.checks.result." + conclusion.result);
    // "Stop tracking" on one that could not be read.
    if (conclusion.told && conclusion.readback === "failed") return { text: t("plugins.checks.result.untracked") };
    if (conclusion.readback !== "pending" && conclusion.readback !== "failed" && conclusion.readback !== "none") settledSeen.current.add(conclusion.operationId);
    switch (conclusion.readback) {
      case "verified":
        return canOpen(conclusion.who.deviceId) ? { text: done, open: conclusion.operationId }
          : { text: done, openUnavailable: true };
      case "pending": return { text: t("plugins.checks.result.readingBack") };
      // The success stands as a past result; the computer's facts now do not name this operation's instance.
      case "gone": case "unconfirmed": return { text: t(PLUGIN_NOT_OPENED_TEXT[conclusion.readback]) };
      // An older computer gives no evidence (V2.10 ③): the person opens it from the installed list.
      case "legacy": return { text: t(PLUGIN_NOT_OPENED_TEXT.legacy), showInstalled: true };
      case "failed": return { text: t("plugins.checks.result.succeededUnread"), readAgain: conclusion.operationId };
      default: return { text: done };
    }
  };
  return (
    <SheetModal nativePresentation visible={visible} onRequestClose={onClose} onBackdropPress={onClose}>
      {visible ? <View style={styles.sheet} testID="plugins.checks">
        {/* Says what is in it: unfinished operations while any is listed, how they ended once none is (dispatcher N-6). */}
        <Text style={styles.title} accessibilityRole="header">{t(live.size ? "plugins.checks.title" : "plugins.checks.titleEnded")}</Text>
        {/* More lines than fit: a fade over the lower edge and a scroll thumb that stays visible (dispatcher Q-1). */}
        <View style={styles.listArea}>
        <ScrollView contentContainerStyle={[styles.list, listArea.thumbGutter]} showsVerticalScrollIndicator={false} testID="plugins.checks.list"
          onLayout={listArea.onLayout} onContentSizeChange={listArea.onContentSizeChange} onScroll={listArea.onScroll} scrollEventThrottle={64}>
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
                      {check.awaitingYou ? (
                        // Read-only until the person opens it: the same confirmation sheet, after taking the slot.
                        <Pressable testID="plugins.checks.decide" accessibilityRole="button" disabled={!online || check.state.busy}
                          accessibilityState={{ disabled: !online || check.state.busy }}
                          onPress={() => { if (!onDecide(check.operationId)) setBlocked((current) => [...current, check.operationId]); }}
                          style={[styles.button, styles.primary, (!online || check.state.busy) && styles.unavailable]}>
                          <Text style={[styles.label, styles.primaryText]}>{t("plugins.checks.decide")}</Text>
                        </Pressable>
                      ) : check.unprovable ? null : (
                        <Pressable testID="plugins.checks.verify" accessibilityRole="button"
                          disabled={!online || check.state.busy}
                          accessibilityState={{ disabled: !online || check.state.busy }}
                          onPress={() => { void check.verify(); }}
                          style={[styles.button, styles.primary, (!online || check.state.busy) && styles.unavailable]}>
                          <Text style={[styles.label, styles.primaryText]}>{t("plugins.management.checkResult")}</Text>
                        </Pressable>
                      )}
                      <Pressable testID="plugins.checks.stop" accessibilityRole="button" disabled={!check.canStop}
                        accessibilityState={{ disabled: !check.canStop }}
                        onPress={() => { check.stop(); }}
                        style={[styles.button, !check.canStop && styles.unavailable]}>
                        <Text style={styles.label}>{t("plugins.checks.stop")}</Text>
                      </Pressable>
                    </View>
                    {blocked.includes(check.operationId) && check.awaitingYou
                      ? <Text testID="plugins.checks.decideBlocked" style={styles.status}>{t("plugins.checks.decideBlocked")}</Text> : null}
                    <Text style={styles.hint}>{t("plugins.checks.stopHint")}</Text>
                  </>
                ) : over?.showInstalled ? (
                  // Only the installed list (its segment), never a particular instance: nothing proves which one it is.
                  <View style={styles.actions}>
                    <Pressable testID="plugins.checks.showInstalled" accessibilityRole="button" onPress={() => onShowInstalled(line.who)}
                      style={styles.button}>
                      <Text style={styles.label}>{t("plugins.checks.showInstalled")}</Text>
                    </Pressable>
                  </View>
                ) : over?.open || over?.readAgain ? (
                  <View style={styles.actions}>
                    {over.open ? (
                      <Pressable testID="plugins.checks.open" accessibilityRole="button" disabled={!online}
                        accessibilityState={{ disabled: !online }}
                        onPress={() => onOpenChecked(over.open!)} style={[styles.button, styles.primary, !online && styles.unavailable]}>
                        <Text style={[styles.label, styles.primaryText]}>{t("plugins.checks.open")}</Text>
                      </Pressable>
                    ) : (
                      <>
                        <Pressable testID="plugins.checks.readAgain" accessibilityRole="button" disabled={!online}
                          accessibilityState={{ disabled: !online }}
                          onPress={() => { void retryPluginCheckReadback(over.readAgain!); }} style={[styles.button, styles.primary, !online && styles.unavailable]}>
                          <Text style={[styles.label, styles.primaryText]}>{t("plugins.checks.readAgain")}</Text>
                        </Pressable>
                        {/* One that cannot be read (its computer is away for good) can always be let go: nothing is sent. */}
                        <Pressable testID="plugins.checks.stop" accessibilityRole="button"
                          onPress={() => tellPluginConclusion(over.readAgain!)} style={styles.button}>
                          <Text style={styles.label}>{t("plugins.checks.stop")}</Text>
                        </Pressable>
                      </>
                    )}
                  </View>
                ) : null}
                {!check && (over?.open || over?.readAgain) && !online ? (
                  // Why the button is unavailable: the computer left this account's list, or is not connected now.
                  <Text testID="plugins.checks.unreachable" style={styles.hint}>{canOpen(line.who.deviceId)
                    ? t("plugins.checks.status.offline", { device: line.who.deviceName })
                    : t("plugins.checks.openUnavailable", { device: line.who.deviceName })}</Text>
                ) : null}
                {!check && over?.readAgain ? <Text style={styles.hint}>{t("plugins.checks.stopHint")}</Text> : null}
                {check || over?.showInstalled || over?.open || over?.readAgain ? null : over?.openUnavailable ? (
                  <Text testID="plugins.checks.openUnavailable" style={styles.hint}>{t("plugins.checks.openUnavailable", { device: line.who.deviceName })}</Text>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
        {listArea.more ? <ScrollFade testID="plugins.checks.listFade" color={colors.surfaceElevated} height={CONSENT_FADE_HEIGHT} /> : null}
        <ScrollThumb overflow={listArea} testID="plugins.checks.listThumb" />
        </View>
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
  listArea: { flexShrink: 1 },
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
