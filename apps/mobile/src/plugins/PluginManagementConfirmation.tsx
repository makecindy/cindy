import { Pressable, ScrollView, StyleSheet, View } from "react-native";
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
import { pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t) : undefined;
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
          {[props.deviceName, info?.identity, info?.trust, info?.origin, info?.version]
            .filter(Boolean)
            .map((text, index) => (
              <Text key={index} style={styles.body}>
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
        <View style={styles.actions}>
          {[false, true].map((accept) => (
            <Pressable
              key={String(accept)}
              testID={"plugins.management." + (accept ? "allow" : "reject")}
              accessibilityRole="button"
              disabled={
                !props.active || props.state.busy || !props.state.online
              }
              onPress={() => answer(accept)}
              style={[styles.button, accept && styles.primary]}
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
    actions: { flexDirection: "row", gap: spacing.sm },
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
