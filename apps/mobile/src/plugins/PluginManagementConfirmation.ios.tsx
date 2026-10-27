import { Button, Text, VStack, HStack } from "@expo/ui/swift-ui";
import {
  buttonStyle,
  disabled,
  fixedSize,
  font,
  foregroundStyle,
  frame,
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
  const info = consent ? pluginConsentPresentation(consent, t) : undefined;
  const body = (text?: string) =>
    text ? (
      <Text
        modifiers={[
          font({ textStyle: "footnote" }),
          foregroundStyle(colors.textSecondary),
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
      testID="plugins.managementConfirmation"
      footer={
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
                  !props.active || props.state.busy || !props.state.online,
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
        {body(props.deviceName)}
        {body(info?.identity)}
        {body(info?.origin)}
        {body(info?.version)}
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
