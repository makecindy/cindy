import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { SheetModal } from "@/session/SheetModal";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import {
  usePluginConsent,
  type PluginManagementConfirmationProps,
} from "./usePluginConsent";
import { useState } from "react";
import { CONSENT_SIDE_BY_SIDE_MIN_WIDTH, planConsentSheet, pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.state.expectedSource) : undefined;
  const { height: windowHeight, width: windowWidth, fontScale } = useWindowDimensions();
  // Two layouts by one rule (`planConsentSheet`, the same as iOS), from measured content heights only: regular, with the
  // summary pinned above the buttons, when the identity block (titles, computer, source, repository, source notes) and
  // the summary's heading with two items fit; compact otherwise, with everything in one scroll area above fixed buttons.
  // A scroll area with more below shows a text-free fade over its lower edge, with the scrollbar always visible
  // (dispatcher J-1, K-2): neither takes room, so neither can change the plan.
  const [measured, setMeasured] = useState({ identity: 0, heading: 0, actions: 0 });
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  const measure = (key: keyof typeof measured) => (event: { nativeEvent: { layout: { height: number } } }) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    setMeasured((current) => current[key] === height ? current : { ...current, [key]: height });
  };
  const measureLine = (index: number) => (event: { nativeEvent: { layout: { height: number } } }) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    setLineHeights((current) => current[index] === height ? current : Object.assign([...current], { [index]: height }));
  };
  const sheetPadding = spacing.lg + spacing.xs;
  const lineCount = info?.highRisk?.lines.length ?? 0;
  const plan = planConsentSheet({
    available: Math.floor(windowHeight * 0.85) - sheetPadding * 2 - spacing.md /* list bottom padding */
      - (info?.highRisk ? spacing.md * 2 + spacing.xs : 0) /* summary padding, gap under its heading */ - measured.actions,
    identity: measured.identity, heading: measured.heading,
    lines: Array.from({ length: lineCount }, (_, index) => lineHeights[index] ?? 0) /* 0 = not measured yet */, gap: spacing.xs,
  });
  const compact = plan.mode === "compact";
  const list = useScrollOverflow(), summary = useScrollOverflow();
  // Large text on a narrow screen: the buttons stack so each label shows in full (as the plugin notices do). Wide enough
  // (landscape, tablets) they stay side by side, labels wrapping inside them, so the text keeps more room (K-3).
  const stacked = fontScale > 1.2 && windowWidth < CONSENT_SIDE_BY_SIDE_MIN_WIDTH;
  const heading = info?.highRisk ? (
    // The heading wraps rather than truncates.
    <Text testID="plugins.management.highRiskTitle" style={styles.highRiskTitle} onLayout={measure("heading")}>{info.highRisk.title}</Text>
  ) : null;
  const summaryLines = info?.highRisk?.lines.map((line, index) => (
    <Text key={index} style={styles.highRiskBody} onLayout={measureLine(index)}>{line}</Text>
  ));
  // Over the scroll area's lower edge while more is below: bands of the sheet's own surface color, more opaque toward
  // the edge (one token, so it follows light and dark mode). No text; it takes no room and no touches.
  const fade = (testID: string) => (
    <View testID={testID} pointerEvents="none" style={styles.fade} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {FADE_STEPS.map((opacity) => <View key={opacity} style={[styles.fadeBand, { opacity }]} />)}
    </View>
  );
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={() => answer(false)}
      onBackdropPress={() => answer(false)}
    >
      <View style={styles.sheet} testID="plugins.managementConfirmation">
        <View style={styles.listArea}>
          <ScrollView contentContainerStyle={styles.content} testID="plugins.management.list" persistentScrollbar
            accessibilityHint={t("plugins.management.scrollHint")}
            onLayout={list.onLayout} onContentSizeChange={list.onContentSizeChange} onScroll={list.onScroll}
            scrollEventThrottle={64}>
            {/* The identity block: where it goes and where it comes from first, in primary text; the first thing shown
                in either layout. The explanations follow in secondary text. */}
            <View testID="plugins.management.identity" style={styles.identity} onLayout={measure("identity")}>
              <Text style={styles.title}>
                {t("plugins.notice.title.confirmation")}
              </Text>
              <Text style={styles.title}>{info?.title}</Text>
              {[info?.device, info?.origin, info?.repository, info?.originSourceChanged, info?.sourceChanged, info?.trust]
                .filter(Boolean)
                .map((text, index) => (
                  <Text key={"lead" + index} style={styles.lead}>
                    {text}
                  </Text>
                ))}
            </View>
            {/* Compact: the whole summary right after the identity block, in the same scroll area. */}
            {compact && info?.highRisk ? (
              <View testID="plugins.management.highRisk" style={[styles.highRisk, styles.highRiskInline]}>
                {heading}
                <View style={styles.highRiskLines}>{summaryLines}</View>
              </View>
            ) : null}
            {[info?.sourceNotice, info?.version, info?.identity]
              .filter(Boolean)
              .map((text, index) => (
                <Text key={"note" + index} style={styles.body}>
                  {text}
                </Text>
              ))}
            {info?.permissions.map((permission, index) => (
              <View key={index} style={styles.permission}>
                <Text style={styles.label}>{permission.title}</Text>
                {permission.detail ? (
                  <Text style={styles.body}>{permission.detail}</Text>
                ) : null}
              </View>
            ))}
            {[info?.unchanged, info?.oauth].filter(Boolean).map((text, index) => (
              <Text key={index} style={styles.body}>
                {text}
              </Text>
            ))}
          </ScrollView>
          {list.more ? fade("plugins.management.listFade") : null}
        </View>
        {/* Regular: outside the scroll area, always visible above the buttons. */}
        {!compact && info?.highRisk ? (
          <View testID="plugins.management.highRisk" style={styles.highRisk}>
            {heading}
            <View>
              {/* Scrolls inside its height; the bar stays visible and the fade shows while items are hidden below. */}
              <ScrollView testID="plugins.management.highRiskScroll" nestedScrollEnabled persistentScrollbar
                accessibilityHint={t("plugins.management.scrollHint")}
                style={{ maxHeight: plan.mode === "regular" ? plan.summaryLines : undefined }}
                onLayout={summary.onLayout} onContentSizeChange={summary.onContentSizeChange} onScroll={summary.onScroll}
                scrollEventThrottle={64}
                contentContainerStyle={styles.highRiskLines}>
                {summaryLines}
              </ScrollView>
              {summary.more ? fade("plugins.management.highRiskFade") : null}
            </View>
          </View>
        ) : null}
        <View testID="plugins.management.actions" style={[styles.actions, stacked && styles.stackedActions]} onLayout={measure("actions")}>
          {[false, true].map((accept) => (
            <Pressable
              key={String(accept)}
              testID={"plugins.management." + (accept ? "allow" : "reject")}
              accessibilityRole="button"
              disabled={
                !props.active || props.state.busy || !!props.state.answerHeld || !props.state.online
                || (accept && info?.allowBlocked === true)
              }
              onPress={() => answer(accept)}
              style={[styles.button, stacked && styles.stackedButton, accept && styles.primary, accept && info?.allowBlocked && styles.unavailable]}
            >
              <Text style={[styles.label, styles.buttonLabel, accept && styles.primaryText]}>
                {t("plugins.management." + (accept ? "allow" : "reject"))}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </SheetModal>
  );
}
const FADE_HEIGHT = 24;
const FADE_STEPS = [0.15, 0.35, 0.6, 0.85];
/** Whether a scroll area has more below what it shows (from its own scroll metrics; display only). */
function useScrollOverflow() {
  const [area, setArea] = useState({ visible: 0, content: 0, atEnd: false });
  return {
    more: area.content > area.visible + 1 && !area.atEnd,
    onLayout: (event: { nativeEvent: { layout: { height: number } } }) => {
      const visible = Math.ceil(event.nativeEvent.layout.height);
      setArea((current) => current.visible === visible ? current : { ...current, visible });
    },
    onContentSizeChange: (_width: number, height: number) => {
      const content = Math.ceil(height);
      setArea((current) => current.content === content ? current : { ...current, content });
    },
    onScroll: (event: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const atEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - 2;
      setArea((current) => current.atEnd === atEnd ? current : { ...current, atEnd });
    },
  };
}
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    sheet: {
      maxHeight: "85%",
      backgroundColor: c.surfaceElevated,
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      padding: spacing.lg + spacing.xs,
    },
    content: { gap: spacing.md, paddingBottom: spacing.md },
    identity: { gap: spacing.md },
    permission: { gap: spacing.xs },
    title: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
    },
    label: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
    body: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      color: c.textSecondary,
    },
    lead: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      color: c.textPrimary,
    },
    // A hairline separates the scrolled list from the pinned summary, so a list title resting right above it
    // does not read as a repeat.
    highRisk: {
      gap: spacing.xs,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    // Same size as the list's permission titles, one step heavier.
    highRiskTitle: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
    },
    highRiskLines: { gap: spacing.xs },
    highRiskBody: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      color: c.textPrimary,
    },
    actions: { flexDirection: "row", gap: spacing.sm },
    // Large text: Allow first, each button the full width, labels wrapping instead of truncating.
    stackedActions: { flexDirection: "column-reverse" },
    stackedButton: { flex: 0, paddingVertical: spacing.sm },
    // The list takes what the pinned summary and the buttons leave (flex, from their real heights: K-1); the fade floats
    // over its lower edge.
    listArea: { flexShrink: 1 },
    fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: FADE_HEIGHT },
    fadeBand: { flex: 1, backgroundColor: c.surfaceElevated },
    // Compact: the summary inside the scroll area, separated by the same hairline.
    highRiskInline: { paddingBottom: 0 },
    unavailable: { opacity: 0.5 },
    button: {
      flex: 1,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: c.surfaceChip,
    },
    primary: { backgroundColor: c.cta },
    primaryText: { color: c.ctaText },
    buttonLabel: { textAlign: "center" },
  });
