import { Button, Divider, Text, VStack, HStack } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  disabled,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { ComposerSheet } from "@/session/ComposerSheet";
import { spacing, useTheme } from "@/theme";
import {
  usePluginConsent,
  type PluginManagementConfirmationProps,
} from "./usePluginConsent";
import { pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    { colors } = useTheme();
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.state.expectedSource) : undefined;
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
            // Bounded summary (a heading and at most five two-line items); full details are in the scrolled list.
            <VStack testID="plugins.management.highRisk" alignment="leading" spacing={spacing.xs}>
              <Text
                modifiers={[
                  // Same size as the list's permission titles, one step heavier.
                  font({ textStyle: "subheadline", weight: "semibold" }),
                  foregroundStyle(colors.textPrimary),
                  lineLimit(1),
                ]}
              >
                {info.highRisk.title}
              </Text>
              {info.highRisk.lines.map((line, index) => (
                <Text
                  key={index}
                  modifiers={[
                    font({ textStyle: "footnote" }),
                    foregroundStyle(colors.textPrimary),
                    lineLimit(2),
                  ]}
                >
                  {line}
                </Text>
              ))}
            </VStack>
          ) : null}
          <HStack spacing={spacing.md}>
            {[false, true].map((accept) => (
              <Button
                key={String(accept)}
                testID={"plugins.management." + (accept ? "allow" : "reject")}
                onPress={() => answer(accept)}
                modifiers={[
                  buttonStyle(accept ? "borderedProminent" : "bordered"),
                  ...(accept ? [tint(colors.cta), foregroundStyle(colors.ctaText)] : []),
                  disabled(
                    !props.active || props.state.busy || !props.state.online
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
        <Text
          modifiers={[
            font({ textStyle: "headline" }),
            foregroundStyle(colors.textPrimary),
          ]}
        >
          {info?.title ?? ""}
        </Text>
        {/* Where it goes and where it comes from first, in primary text, so they stay in view with the
            pinned high-risk summary at the medium detent; the explanations follow in secondary text. */}
        {body(info?.device, true)}
        {body(info?.origin, true)}
        {body(info?.repository, true)}
        {body(info?.sourceChanged, true)}
        {body(info?.trust, true)}
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
