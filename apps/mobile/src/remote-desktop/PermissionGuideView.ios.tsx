import { Host } from "@expo/ui";
import {
  Button,
  Divider,
  LabeledContent,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  background,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  multilineTextAlignment,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";
import { Text as AppText } from "@/components/AppText";
import { radius, spacing, textStyles, useTheme } from "@/theme";
import { useLiquidGlassAvailable } from "@/session/useLiquidGlassAvailable";
import type { PermissionGuideViewProps } from "./PermissionGuideView";

export function PermissionGuideView(props: PermissionGuideViewProps) {
  const { colors, mode } = useTheme();
  const glass = useLiquidGlassAvailable();
  const primaryStyle = buttonStyle(
    glass ? "glassProminent" : "borderedProminent",
  );
  return (
    <View
      style={{
        padding: spacing.md,
        gap: spacing.md,
        backgroundColor: colors.surface,
      }}
    >
      <Host
        matchContents={{ vertical: true }}
        colorScheme={mode}
        seedColor={colors.cta}
        ignoreSafeArea="all"
      >
        <VStack
          alignment="leading"
          spacing={spacing.md}
          modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
        >
          <Text
            modifiers={[
              font({ textStyle: "title2", weight: "medium" }),
              foregroundStyle(colors.textPrimary),
              accessibilityAddTraits(["isHeader"]),
            ]}
          >
            {props.title}
          </Text>
          <Text
            modifiers={[
              font({ textStyle: "subheadline" }),
              foregroundStyle(colors.textSecondary),
            ]}
          >
            {props.intro}
          </Text>
          {props.rows.length > 0 && (
            <VStack
              spacing={spacing.md}
              modifiers={[
                padding({ all: spacing.md }),
                background(
                  colors.surfaceElevated,
                  shapes.roundedRectangle({ cornerRadius: radius.container }),
                ),
              ]}
            >
              {props.rows.map((row, index) => (
                <VStack key={row.label} spacing={spacing.md}>
                  {index > 0 && <Divider />}
                  <LabeledContent
                    label={
                      <Text modifiers={[foregroundStyle(colors.textPrimary)]}>
                        {row.label}
                      </Text>
                    }
                  >
                    <Text modifiers={[foregroundStyle(colors.textSecondary)]}>
                      {row.value}
                    </Text>
                  </LabeledContent>
                </VStack>
              ))}
            </VStack>
          )}
          {props.guideLabel && (
            <Button
              onPress={props.onGuide}
              modifiers={[
                primaryStyle,
                buttonBorderShape("capsule"),
                controlSize("large"),
                disabled(props.pending),
              ]}
            >
              <Text
                modifiers={[
                  fixedSize({ horizontal: false, vertical: true }),
                  multilineTextAlignment("center"),
                  frame({ maxWidth: Infinity, minHeight: 24 }),
                ]}
              >
                {props.guideLabel}
              </Text>
            </Button>
          )}
          <Button
            onPress={props.onReconnect}
            modifiers={[
              props.guideLabel ? buttonStyle("plain") : primaryStyle,
              buttonBorderShape("capsule"),
              controlSize("large"),
            ]}
          >
            <Text
              modifiers={[
                fixedSize({ horizontal: false, vertical: true }),
                multilineTextAlignment("center"),
                frame({ maxWidth: Infinity, minHeight: 44 }),
              ]}
            >
              {props.reconnectLabel}
            </Text>
          </Button>
        </VStack>
      </Host>
      {props.notice && (
        <AppText
          accessibilityRole="alert"
          style={{ ...textStyles.caption, color: colors.textSecondary }}
        >
          {props.notice}
        </AppText>
      )}
    </View>
  );
}
