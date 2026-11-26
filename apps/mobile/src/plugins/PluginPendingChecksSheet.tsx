import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SheetModal } from "@/session/SheetModal";
import { Text } from "@/components/AppText";
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { ScrollFade, ScrollThumb, useScrollOverflow } from "@/components/ScrollOverflow";
import { CONSENT_FADE_HEIGHT } from "./pluginConsentPresentation";
import { samePluginSlotHolder, type PluginSlotEntry, type PluginSlotHolder } from "./pluginManagementSlot";
import { PLUGIN_NOT_OPENED_TEXT } from "./pluginOperationOpens";
import { pluginConclusionSettled, pluginCheckConclusion, retryPluginCheckReadback, stopPluginConclusion, tellPluginConclusion, type PluginCheckConclusion, type PluginPendingCheck } from "./usePluginManagement";

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
  /** "Open plugin": the page opens, in the press itself, the instance this line shows as proven. */
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
  // Only what is still settled then counts (`tellPluginConclusion`): one being read again, or that could not be read
  // after all, stays listed.
  const settledSeen = useRef(new Set<string>());
  // "Open plugin" opens at once what its line shows. A success is a past result (the plugin may have been replaced
  // since), so one proven before the list was opened is read again, once, as the list opens (or as soon as its computer
  // can be read), and its line has no "Open plugin" until that read is back. One proven while the list is open was read
  // just now. After that, a plugin change notification from that computer or its coming back online takes "Open plugin"
  // away and the record reads it again (usePluginManagement `holdPluginConclusionsOn`; maintainer review 14:25 #1).
  const provenBefore = useRef<Set<string> | undefined>(undefined);
  const proven = (item: PluginCheckConclusion) => item.readback === "verified" && !item.told
    && (item.result === "succeeded" || item.result === "installed") && item.entry !== "uninstall";
  const readable = (deviceId: string) => canOpen(deviceId) && isOnline(deviceId);
  if (!visible) provenBefore.current = undefined;
  else provenBefore.current ??= new Set(conclusions.filter(proven).map((item) => item.operationId));
  useEffect(() => {
    for (const operationId of [...(provenBefore.current ?? [])]) {
      const conclusion = conclusions.find((item) => item.operationId === operationId);
      if (!conclusion || !proven(conclusion)) { provenBefore.current!.delete(operationId); continue; }
      if (!readable(conclusion.who.deviceId)) continue;
      provenBefore.current!.delete(operationId);
      // After this commit's effects: the page says whether the computer can be reached in its own effect, which runs
      // after this one. A read issued before that would count as issued while unreachable and, failing, be read twice.
      // A computer that just came back has its proven successes read again already (they are no longer "verified"): no
      // second read.
      queueMicrotask(() => { if (pluginCheckConclusion(operationId)?.readback === "verified") void retryPluginCheckReadback(operationId); });
    }
  });
  if (!visible) seen.current.clear();
  useEffect(() => {
    if (!visible) { setBlocked([]); return; }
    return () => { for (const operationId of settledSeen.current) tellPluginConclusion(operationId); settledSeen.current.clear(); };
  }, [visible]);
  for (const line of lines) seen.current.set(line.key, line);
  // An operation listed while it was getting ready (before its begin) and that then began is one line, its check's:
  // the earlier line is not kept beside it as "ended".
  for (const [key, line] of [...seen.current]) {
    if (key.startsWith("slot:") && !lines.includes(line) && lines.some((other) => other.check && samePluginSlotHolder(other.who, line.who))) seen.current.delete(key);
  }
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
    // The receipt is gone and the facts cannot settle it yet (the plugin is there, its installed record was not read).
    if (check.recordMissing) return t("plugins.checks.status.recordMissing");
    if (check.waiting || check.state.outcome === "unknown") return t("plugins.checks.status.waiting");
    return t(check.state.outcome === "confirmation" ? "plugins.checks.status.confirmation" : "plugins.checks.status.running");
  };
  /**
   * How a line that left the list ended (dispatcher L-1, L-3): a success says whether the list's own read of the
   * computer found the instance (only then "Open", and only on a computer still listed), is still reading, did not find
   * it, or failed to read ("Read again"); an uninstall has nothing to open.
   */
  const installedEntry = (deviceId: string) => canOpen(deviceId) ? { showInstalled: true } : { openUnavailable: true };
  const ended = (line: PluginOperationLine): { text: string; open?: string; readAgain?: string; stop?: string; openUnavailable?: boolean; showInstalled?: boolean } => {
    const operationId = line.check?.operationId ?? (line.concluded ? line.key : undefined);
    const conclusion = operationId ? conclusions.find((item) => item.operationId === operationId) : undefined;
    if (!conclusion) return { text: t(line.check ? "plugins.checks.result.untracked" : "plugins.checks.result.ended") };
    // Drawn with a known result (proven, why not, or not confirmed after its receipt was gone): seen once the list closes.
    if (pluginConclusionSettled(conclusion)) settledSeen.current.add(conclusion.operationId);
    if (conclusion.result === "notInstalled") return { text: t("plugins.market.unconfirmedNotInstalled") };
    if (conclusion.result === "mismatch") return { text: t("plugins.market.unconfirmedMismatch") };
    // "Go to Installed" only while its computer is in this account's list (maintainer review 14:25 #3): otherwise the
    // record stays, says that computer is not available, and offers no way to another computer's list.
    if (conclusion.result === "legacy") return { text: t("plugins.market.unconfirmedLegacy"), ...installedEntry(conclusion.who.deviceId) };
    if (conclusion.result !== "succeeded" && conclusion.result !== "installed") return { text: t("plugins.checks.result." + conclusion.result) };
    if (conclusion.entry === "uninstall") return { text: t("plugins.checks.result.uninstalled") };
    const done = t("plugins.checks.result." + conclusion.result);
    // "Stop tracking" on one that could not be read.
    if (conclusion.told && conclusion.readback === "failed") return { text: t("plugins.checks.result.untracked") };
    switch (conclusion.readback) {
      case "verified":
        // Already shown to the person elsewhere (its own view opened or showed it): nothing more to open from here.
        if (conclusion.told) return { text: done };
        if (!canOpen(conclusion.who.deviceId)) return { text: done, openUnavailable: true };
        // To be read again before it is offered (this render's effect, once the computer can be read).
        if (provenBefore.current?.has(conclusion.operationId) && isOnline(conclusion.who.deviceId))
          return { text: t("plugins.checks.result.readingBack"), stop: conclusion.operationId };
        return { text: done, open: conclusion.operationId };
      // Being read: nothing to do but wait, or stop following it (the read is dropped; nothing is sent).
      case "pending": return conclusion.told ? { text: done } : { text: t("plugins.checks.result.readingBack"), stop: conclusion.operationId };
      // The success stands as a past result; the computer's facts now do not name this operation's instance.
      case "gone": case "unconfirmed": return { text: t(PLUGIN_NOT_OPENED_TEXT[conclusion.readback]) };
      // An older computer gives no evidence (V2.10 ③): the person opens it from the installed list.
      case "legacy": return { text: t(PLUGIN_NOT_OPENED_TEXT.legacy), ...installedEntry(conclusion.who.deviceId) };
      case "failed": return { text: t("plugins.checks.result.succeededUnread"), readAgain: conclusion.operationId, stop: conclusion.operationId };
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
                ) : over?.open || over?.readAgain || over?.stop ? (
                  <View style={styles.actions}>
                    {over.open ? (
                      <Pressable testID="plugins.checks.open" accessibilityRole="button" disabled={!online}
                        accessibilityState={{ disabled: !online }}
                        onPress={() => onOpenChecked(over.open!)} style={[styles.button, styles.primary, !online && styles.unavailable]}>
                        <Text style={[styles.label, styles.primaryText]}>{t("plugins.checks.open")}</Text>
                      </Pressable>
                    ) : (
                      <>
                        {over.readAgain ? (
                          <Pressable testID="plugins.checks.readAgain" accessibilityRole="button" disabled={!online}
                            accessibilityState={{ disabled: !online }}
                            onPress={() => { void retryPluginCheckReadback(over.readAgain!); }} style={[styles.button, styles.primary, !online && styles.unavailable]}>
                            <Text style={[styles.label, styles.primaryText]}>{t("plugins.checks.readAgain")}</Text>
                          </Pressable>
                        ) : null}
                        {/* One not read (yet, or its computer is away for good) can always be let go: nothing is sent. */}
                        <Pressable testID="plugins.checks.stop" accessibilityRole="button"
                          onPress={() => stopPluginConclusion(over.stop!)} style={styles.button}>
                          <Text style={styles.label}>{t("plugins.checks.stop")}</Text>
                        </Pressable>
                      </>
                    )}
                  </View>
                ) : null}
                {!check && (over?.open || over?.readAgain) && !online ? (
                  // Why the button is unavailable: the computer left this account's list, or is not connected now.
                  <Text testID="plugins.checks.unreachable" style={styles.hint}>{!canOpen(line.who.deviceId)
                    ? t("plugins.checks.openUnavailable", { device: line.who.deviceName })
                    // A result already read only waits to be opened; one not read yet waits to be checked.
                    : t(over.open ? "plugins.checks.openOffline" : "plugins.checks.status.offline", { device: line.who.deviceName })}</Text>
                ) : null}
                {!check && over?.stop ? <Text style={styles.hint}>{t("plugins.checks.stopHint")}</Text> : null}
                {check || over?.showInstalled || over?.open || over?.readAgain || over?.stop ? null : over?.openUnavailable ? (
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
