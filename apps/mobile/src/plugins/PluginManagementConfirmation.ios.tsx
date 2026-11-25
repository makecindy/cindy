import { Button, Divider, ScrollView, Text, VStack, HStack } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  disabled,
  fixedSize,
  font,
  foregroundStyle,
  frame,
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
import { planConsentSheet, pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    { colors } = useTheme();
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.state.expectedSource) : undefined;
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Two layouts by one rule (`planConsentSheet`, the same as Android), from measured content heights only: regular,
  // with the summary pinned in the footer above the buttons, when the identity block (title, computer, source,
  // repository, source notes) and the summary's heading with two items fit; compact otherwise, with the whole summary in
  // the scrolled list right after the identity block and only the buttons in the footer. The usable height is the
  // window minus the top inset and the sheet's own header (title row and drag handle, which grow with text size).
  // No "keep scrolling" text on iOS: the scroll indicators stay visible instead, so nothing takes room from the text.
  // A SwiftUI ScrollView takes all the height it is offered, so the pinned summary gets an explicit height: its
  // measured content height, capped by the plan.
  const [measured, setMeasured] = useState({ identity: 0, heading: 0, actions: 0 });
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  const measure = (key: keyof typeof measured) => (size: { height: number }) => {
    const height = Math.ceil(size.height);
    if (height > 0) setMeasured((current) => current[key] === height ? current : { ...current, [key]: height });
  };
  const measureLine = (index: number) => (size: { height: number }) => {
    const height = Math.ceil(size.height);
    if (height > 0) setLineHeights((current) => current[index] === height ? current : Object.assign([...current], { [index]: height }));
  };
  const sheetHeader = Math.ceil(64 * Math.min(Math.max(fontScale, 1), 2)) + 10;
  const lineCount = info?.highRisk?.lines.length ?? 0;
  const plan = planConsentSheet({
    available: Math.floor(windowHeight - insets.top - sheetHeader) - spacing.sm * 2 /* list padding */
      - spacing.sm * 3 /* footer spacing */ - spacing.xs - 12 /* footer bottom */ - insets.bottom - measured.actions,
    identity: measured.identity, heading: measured.heading,
    lines: Array.from({ length: lineCount }, (_, index) => lineHeights[index] ?? 0) /* 0 = not measured yet */, gap: spacing.xs,
  });
  const compact = plan.mode === "compact";
  const [summaryHeight, setSummaryHeight] = useState(0);
  // Large text: the buttons stack so each label shows in full (as the plugin notices do).
  const stacked = fontScale > 1.2;
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
  const answerButton = (accept: boolean) => (
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
          // The label wraps rather than truncates at large text sizes.
          fixedSize({ horizontal: false, vertical: true }),
        ]}
      >
        {t("plugins.management." + (accept ? "allow" : "reject"))}
      </Text>
    </Button>
  );
  const summaryHeading = info?.highRisk ? (
    <Text
      testID="plugins.management.highRiskTitle"
      modifiers={[
        // Same size as the list's permission titles, one step heavier.
        font({ textStyle: "subheadline", weight: "semibold" }),
        foregroundStyle(colors.textPrimary),
        // Wraps rather than truncates.
        fixedSize({ horizontal: false, vertical: true }),
        onGeometryChange(measure("heading")),
      ]}
    >
      {info.highRisk.title}
    </Text>
  ) : null;
  const summaryItems = info?.highRisk?.lines.map((line, index) => (
    <Text
      key={index}
      modifiers={[
        font({ textStyle: "footnote" }),
        foregroundStyle(colors.textPrimary),
        fixedSize({ horizontal: false, vertical: true }),
        onGeometryChange(measureLine(index)),
      ]}
    >
      {line}
    </Text>
  ));
  return (
    <ComposerSheet
      visible={visible}
      onClose={() => answer(false)}
      title={t("plugins.notice.title.confirmation")}
      nativeContent
      // Open large when the summary, a source-change notice or an accessibility text size needs the room (at the medium
      // detent an upward swipe expands the sheet instead of scrolling the list).
      largeOnly={!!info?.highRisk || !!info?.originSourceChanged || fontScale >= 1.35}
      testID="plugins.managementConfirmation"
      footer={
        // The pinned high-risk text lives in the footer, which stays visible at the medium detent too.
        <VStack alignment="leading" spacing={spacing.sm}>
          {/* Regular: a separator, then the pinned summary (every item in full, scrolling inside its height with the
              indicator visible; full details are in the scrolled list). Compact: only the buttons stay here. */}
          {!compact && info?.highRisk ? <Divider /> : null}
          {!compact && info?.highRisk ? (
            <VStack testID="plugins.management.highRisk" alignment="leading" spacing={spacing.xs}>
              {summaryHeading}
              <ScrollView testID="plugins.management.highRiskScroll"
                modifiers={[frame({ height: plan.mode === "regular" ? Math.min(plan.summaryLines, summaryHeight || plan.summaryLines) : undefined }),
                  scrollIndicators("visible")]}>
                <VStack alignment="leading" spacing={spacing.xs}
                  modifiers={[frame({ maxWidth: Infinity, alignment: "leading" }),
                    onGeometryChange((size) => { if (size.height > 0) setSummaryHeight(size.height); })]}>
                  {summaryItems}
                </VStack>
              </ScrollView>
            </VStack>
          ) : null}
          {stacked ? (
            <VStack testID="plugins.management.actions" spacing={spacing.sm} modifiers={[onGeometryChange(measure("actions"))]}>
              {[true, false].map((accept) => answerButton(accept))}
            </VStack>
          ) : (
          <HStack testID="plugins.management.actions" spacing={spacing.md} modifiers={[onGeometryChange(measure("actions"))]}>
            {[false, true].map((accept) => answerButton(accept))}
          </HStack>
          )}
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
        {/* Compact: the whole summary right after the identity block, in the same scrolled list. */}
        {compact && info?.highRisk ? <Divider /> : null}
        {compact && info?.highRisk ? (
          <VStack testID="plugins.management.highRisk" alignment="leading" spacing={spacing.xs}>
            {summaryHeading}
            {summaryItems}
          </VStack>
        ) : null}
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
