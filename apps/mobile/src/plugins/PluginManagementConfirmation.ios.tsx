import { Button, Divider, ScrollView, Text, VStack, HStack } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  disabled,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  onGeometryChange,
  padding,
  scrollIndicators,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { ComposerSheet } from "@/session/ComposerSheet";
import { spacing, useTheme } from "@/theme";
import {
  usePluginConsent,
  type PluginManagementConfirmationProps,
} from "./usePluginConsent";
import { useState } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pinnedHighRiskMaxHeight, pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    { colors } = useTheme();
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.state.expectedSource) : undefined;
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The summary's lines are shown in full; beyond its bound they scroll inside. The bound keeps the identity block
  // (title, computer, source, repository, source notes), the summary heading and the buttons in view without
  // scrolling, from their measured heights. The sheet opens large when it has a summary: the window minus the top
  // inset and the sheet's own header (title row and drag handle, which grow with text size).
  // A SwiftUI ScrollView takes all the height it is offered, so it gets an explicit height: the measured content
  // height, capped by the bound.
  const [measured, setMeasured] = useState({ identity: 0, heading: 0, actions: 0 });
  const measure = (key: keyof typeof measured) => (size: { height: number }) => {
    const height = Math.ceil(size.height);
    if (height > 0) setMeasured((current) => current[key] === height ? current : { ...current, [key]: height });
  };
  const sheetHeader = Math.ceil(64 * Math.min(Math.max(fontScale, 1), 2)) + 10;
  const summaryCap = pinnedHighRiskMaxHeight({ available: Math.floor(windowHeight - insets.top - sheetHeader),
    chrome: spacing.sm * 2 /* list padding */ + spacing.sm * 3 /* footer spacing */ + spacing.xs + 12 /* footer bottom */ + insets.bottom,
    ...measured });
  const [summaryHeight, setSummaryHeight] = useState(0);
  const body = (text?: string, lead = false) =>
    text ? (
      <Text
        modifiers={[
          font({ textStyle: "footnote" }),
          foregroundStyle(lead ? colors.textPrimary : colors.textSecondary),
          fixedSize({ horizontal: false, vertical: true }),
        ]}
      >
        {text}
      </Text>
    ) : null;
  return (
    <ComposerSheet
      visible={visible}
      onClose={() => answer(false)}
      title={t("plugins.notice.title.confirmation")}
      nativeContent
      // With high-risk items the whole list must be reachable before Allow; at the medium detent an upward swipe
      // expands the sheet instead of scrolling, so open large.
      largeOnly={!!info?.highRisk}
      testID="plugins.managementConfirmation"
      footer={
        // The pinned high-risk text lives in the footer, which stays visible at the medium detent too.
        <VStack alignment="leading" spacing={spacing.sm}>
          {/* A separator between the scrolled list and the pinned summary, so a list title resting right above
              the summary does not read as a repeat. */}
          {info?.highRisk ? <Divider /> : null}
          {info?.highRisk ? (
            // Bounded summary: every line in full, scrolling inside its height bound; full details are in the scrolled list.
            <VStack testID="plugins.management.highRisk" alignment="leading" spacing={spacing.xs}>
              <Text
                modifiers={[
                  // Same size as the list's permission titles, one step heavier.
                  font({ textStyle: "subheadline", weight: "semibold" }),
                  foregroundStyle(colors.textPrimary),
                  lineLimit(1),
                  onGeometryChange(measure("heading")),
                ]}
              >
                {info.highRisk.title}
              </Text>
              {/* Scrolls inside its bound; the indicator stays visible so the hidden lines are discoverable. */}
              <ScrollView testID="plugins.management.highRiskScroll"
                modifiers={[frame({ height: Math.min(summaryCap, summaryHeight || summaryCap) }), scrollIndicators("visible")]}>
                <VStack alignment="leading" spacing={spacing.xs}
                  modifiers={[frame({ maxWidth: Infinity, alignment: "leading" }),
                    onGeometryChange((size) => { if (size.height > 0) setSummaryHeight(size.height); })]}>
                  {info.highRisk.lines.map((line, index) => (
                    <Text
                      key={index}
                      modifiers={[
                        font({ textStyle: "footnote" }),
                        foregroundStyle(colors.textPrimary),
                        fixedSize({ horizontal: false, vertical: true }),
                      ]}
                    >
                      {line}
                    </Text>
                  ))}
                </VStack>
              </ScrollView>
            </VStack>
          ) : null}
          <HStack testID="plugins.management.actions" spacing={spacing.md} modifiers={[onGeometryChange(measure("actions"))]}>
            {[false, true].map((accept) => (
              <Button
                key={String(accept)}
                testID={"plugins.management." + (accept ? "allow" : "reject")}
                onPress={() => answer(accept)}
                modifiers={[
                  buttonStyle(accept ? "borderedProminent" : "bordered"),
                  ...(accept ? [tint(colors.cta), foregroundStyle(colors.ctaText)] : []),
                  disabled(
                    !props.active || props.state.busy || !!props.state.answerHeld || !props.state.online
                      || (accept && info?.allowBlocked === true),
                  ),
                  frame({ maxWidth: Infinity, minHeight: 44 }),
                ]}
              >
                <Text
                  modifiers={[
                    font({ textStyle: "subheadline", weight: "medium" }),
                    ...(accept ? [foregroundStyle(colors.ctaText)] : []),
                  ]}
                >
                  {t("plugins.management." + (accept ? "allow" : "reject"))}
                </Text>
              </Button>
            ))}
          </HStack>
        </VStack>
      }
    >
      <VStack
        alignment="leading"
        spacing={spacing.md}
        modifiers={[padding({ vertical: spacing.sm })]}
      >
        {/* The identity block: where it goes and where it comes from first, in primary text, kept in view with the
            pinned summary (measured for its bound); the explanations follow in secondary text. */}
        <VStack testID="plugins.management.identity" alignment="leading" spacing={spacing.md}
          modifiers={[onGeometryChange(measure("identity"))]}>
          <Text
            modifiers={[
              font({ textStyle: "headline" }),
              foregroundStyle(colors.textPrimary),
            ]}
          >
            {info?.title ?? ""}
          </Text>
          {body(info?.device, true)}
          {body(info?.origin, true)}
          {body(info?.repository, true)}
          {body(info?.originSourceChanged, true)}
          {body(info?.sourceChanged, true)}
          {body(info?.trust, true)}
        </VStack>
        {body(info?.sourceNotice)}
        {body(info?.version)}
        {body(info?.identity)}
        {info?.permissions.map((permission, index) => (
          <VStack key={index} alignment="leading" spacing={spacing.xs}>
            <Text
              modifiers={[
                font({ textStyle: "subheadline", weight: "medium" }),
                foregroundStyle(colors.textPrimary),
                fixedSize({ horizontal: false, vertical: true }),
              ]}
            >
              {permission.title}
            </Text>
            {body(permission.detail)}
          </VStack>
        ))}
        {body(info?.unchanged)}
        {body(info?.oauth)}
      </VStack>
    </ComposerSheet>
  );
}
