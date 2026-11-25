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
import { pinnedHighRiskRows, pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.state.expectedSource) : undefined;
  const { fontScale } = useWindowDimensions();
  // Hard height bound for the pinned summary, by text size alone (see pinnedHighRiskRows).
  const pinned = info?.highRisk ? pinnedHighRiskRows(info.highRisk.lines, fontScale, t) : undefined;
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={() => answer(false)}
      onBackdropPress={() => answer(false)}
    >
      <View style={styles.sheet} testID="plugins.managementConfirmation">
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>
            {t("plugins.notice.title.confirmation")}
          </Text>
          <Text style={styles.title}>{info?.title}</Text>
          {/* Where it goes and where it comes from first, in primary text, so they stay in view with the
              pinned high-risk summary on short screens; the explanations follow in secondary text. */}
          {[info?.device, info?.origin, info?.repository, info?.sourceChanged, info?.trust]
            .filter(Boolean)
            .map((text, index) => (
              <Text key={"lead" + index} style={styles.lead}>
                {text}
              </Text>
            ))}
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
          // Bounded summary (a heading and at most five two-line items); full details are in the scrolled list.
          <View testID="plugins.management.highRisk" style={styles.highRisk}>
            <Text numberOfLines={1} style={styles.highRiskTitle}>{info.highRisk.title}</Text>
            {pinned!.rows.map((line, index) => (
              <Text key={index} numberOfLines={pinned!.lineLimit} style={styles.highRiskBody}>{line}</Text>
            ))}
          </View>
        ) : null}
        <View style={styles.actions}>
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
