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
import { layoutConsentSheet, pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.state.expectedSource) : undefined;
  const { height: windowHeight, fontScale } = useWindowDimensions();
  // The sheet (at most 85% of the window) shares its height between the identity block at the top of the list and
  // the pinned summary by one rule (`layoutConsentSheet`, the same as iOS): the summary keeps its heading and two full
  // lines, the identity block (titles, computer, source, repository, source notes) comes next, the rest of the summary
  // last. Every part is measured on screen; what does not fit scrolls, with a hint below the summary or the list.
  const [measured, setMeasured] = useState({ identity: 0, heading: 0, actions: 0, hint: 0, listHint: 0 });
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
  // The list scrolls under the summary; its hint shows while the list is longer than its room, until its end is reached.
  const [list, setList] = useState({ content: 0, atEnd: false });
  const allocation = layoutConsentSheet({
    available: Math.floor(windowHeight * 0.85) - sheetPadding * 2 - spacing.md /* list bottom padding */
      - (info?.highRisk ? spacing.md * 2 + spacing.xs : 0) /* summary padding, gap under its heading */ - measured.actions,
    identity: measured.identity, heading: measured.heading, lines: Array.from({ length: lineCount }, (_, index) => lineHeights[index] ?? 0) /* 0 = not measured yet */, gap: spacing.xs,
    summaryHint: measured.hint, listHint: measured.listHint, hintGap: spacing.xs,
    listContent: Math.max(0, list.content - spacing.md /* its bottom padding, already counted */),
  });
  const listClipped = allocation.listClipped && !list.atEnd;
  // Large text: the buttons stack so each label shows in full (as the plugin notices do).
  const stacked = fontScale > 1.2;
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={() => answer(false)}
      onBackdropPress={() => answer(false)}
    >
      <View style={styles.sheet} testID="plugins.managementConfirmation">
        <ScrollView contentContainerStyle={styles.content} testID="plugins.management.list"
          onContentSizeChange={(_width, height) => { const content = Math.ceil(height); setList((current) => current.content === content ? current : { ...current, content }); }}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            const atEnd = contentOffset.y + layoutMeasurement.height >= contentSize.height - 2;
            setList((current) => current.atEnd === atEnd ? current : { ...current, atEnd });
          }}
          scrollEventThrottle={64}>
          {/* The identity block: where it goes and where it comes from first, in primary text, kept in view with the
              pinned summary on short screens (measured for its bound); the explanations follow in secondary text. */}
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
        {listClipped ? <Text testID="plugins.management.listMore" style={[styles.hint, styles.listHint]} onLayout={measure("listHint")}>{t("plugins.management.listMore")}</Text> : null}
        {/* Outside the scroll area: always visible above the buttons, even on short screens. */}
        {info?.highRisk ? (
          // Bounded summary: every line in full, scrolling inside its share; full details are in the scrolled list.
          <View testID="plugins.management.highRisk" style={styles.highRisk}>
            {/* The heading wraps rather than truncates. */}
            <Text testID="plugins.management.highRiskTitle" style={styles.highRiskTitle} onLayout={measure("heading")}>{info.highRisk.title}</Text>
            {/* Scrolls inside its share; the bar stays visible and a hint says so when lines are hidden. */}
            <ScrollView testID="plugins.management.highRiskScroll" nestedScrollEnabled persistentScrollbar
              style={{ maxHeight: allocation.summaryLines }}
              contentContainerStyle={styles.highRiskLines}>
              {info.highRisk.lines.map((line, index) => (
                <Text key={index} style={styles.highRiskBody} onLayout={measureLine(index)}>{line}</Text>
              ))}
            </ScrollView>
            {allocation.clipped ? <Text testID="plugins.management.highRiskMore" style={styles.hint} onLayout={measure("hint")}>{t("plugins.management.highRiskMore")}</Text> : null}
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
    listHint: { marginTop: spacing.xs },
    hint: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      color: c.textSecondary,
    },
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
