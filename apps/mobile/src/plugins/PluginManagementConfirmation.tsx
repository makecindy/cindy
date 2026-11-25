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
import { pinnedHighRiskMaxHeight, pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.state.expectedSource) : undefined;
  const { height: windowHeight } = useWindowDimensions();
  // The summary's lines are shown in full; beyond its bound they scroll inside (a ScrollView hugs shorter content).
  // The bound keeps the identity block (titles, computer, source, repository, source notes) and the buttons in view
  // without scrolling, from their measured heights; the sheet itself is at most 85% of the window.
  const [measured, setMeasured] = useState({ identity: 0, heading: 0, actions: 0 });
  const measure = (key: keyof typeof measured) => (event: { nativeEvent: { layout: { height: number } } }) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    setMeasured((current) => current[key] === height ? current : { ...current, [key]: height });
  };
  const sheetPadding = spacing.lg + spacing.xs;
  const summaryCap = pinnedHighRiskMaxHeight({ available: Math.floor(windowHeight * 0.85),
    chrome: sheetPadding * 2 + spacing.md /* list bottom padding */ + spacing.md * 2 + spacing.xs /* summary padding, gap */,
    ...measured });
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={() => answer(false)}
      onBackdropPress={() => answer(false)}
    >
      <View style={styles.sheet} testID="plugins.managementConfirmation">
        <ScrollView contentContainerStyle={styles.content}>
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
        {/* Outside the scroll area: always visible above the buttons, even on short screens. */}
        {info?.highRisk ? (
          // Bounded summary: every line in full, scrolling inside its height bound; full details are in the scrolled list.
          <View testID="plugins.management.highRisk" style={styles.highRisk}>
            <Text numberOfLines={1} style={styles.highRiskTitle} onLayout={measure("heading")}>{info.highRisk.title}</Text>
            {/* Scrolls inside its bound; the bar stays visible so the hidden lines are discoverable. */}
            <ScrollView testID="plugins.management.highRiskScroll" nestedScrollEnabled persistentScrollbar
              style={{ maxHeight: summaryCap }}
              contentContainerStyle={styles.highRiskLines}>
              {info.highRisk.lines.map((line, index) => (
                <Text key={index} style={styles.highRiskBody}>{line}</Text>
              ))}
            </ScrollView>
          </View>
        ) : null}
        <View testID="plugins.management.actions" style={styles.actions} onLayout={measure("actions")}>
          {[false, true].map((accept) => (
            <Pressable
              key={String(accept)}
              testID={"plugins.management." + (accept ? "allow" : "reject")}
              accessibilityRole="button"
              disabled={
                !props.active || props.state.busy || !props.state.online
                || (accept && info?.allowBlocked === true)
              }
              onPress={() => answer(accept)}
              style={[styles.button, accept && styles.primary, accept && info?.allowBlocked && styles.unavailable]}
            >
              <Text style={[styles.label, accept && styles.primaryText]}>
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
    unavailable: { opacity: 0.5 },
    button: {
      flex: 1,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
      backgroundColor: c.surfaceChip,
    },
    primary: { backgroundColor: c.cta },
    primaryText: { color: c.ctaText },
  });
