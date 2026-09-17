import { iconSize } from '@/theme';
import { Host } from "@expo/ui";
import {
  BottomSheet,
  Form,
  Button,
  Group,
  HStack,
  Image,
  RNHostView,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  contentShape,
  shapes,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  padding,
  presentationDetents,
  presentationDragIndicator,
  scrollContentBackground,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { useTheme } from "@/theme";
import type { ComposerSheetProps } from "./ComposerSheet";

/** One native presentation; secondary pages replace content without a second backdrop. */
export function ComposerSheet({
  visible,
  onClose,
  onClosed,
  title,
  onBack,
  backLabel,
  children,
  aboveContent,
  aboveContentTitle,
  footer,
  testID,
  nativeContent,
  nativeHeader,
}: ComposerSheetProps) {
  const { mode, colors } = useTheme();
  const { t } = useTranslation();
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      pointerEvents="none"
      style={{ position: "absolute" }}
    >
      <BottomSheet
        isPresented={visible}
        onIsPresentedChange={(open) => {
          if (!open) onClose();
        }}
        onDismiss={onClosed}
      >
        <Group
          modifiers={[
            presentationDetents(["medium", "large"], { selection: "medium" }),
            presentationDragIndicator("visible"),
          ]}
        >
          <VStack
            spacing={0}
            modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}
          >
            {title || onBack ? <HStack
              modifiers={[
                padding({ top: 12, leading: 20, trailing: 20, bottom: 8 }),
                frame({ minHeight: 52 }),
              ]}
            >
              {onBack ? (
                <Button onPress={onBack} modifiers={[buttonStyle("plain"), accessibilityLabel(backLabel ?? t("interaction.contextSheet.backAccessibility"))]}>
                  <Image size={iconSize.lg} systemName="chevron.left" modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]} />
                </Button>
              ) : null}
              <Spacer />
              <Text modifiers={[font({ textStyle: "headline" })]}>{title}</Text>
              <Spacer />
              {onBack ? <Spacer modifiers={[frame({ width: 44 })]} /> : null}
            </HStack> : null}
            {nativeHeader}
            {aboveContent && aboveContentTitle ? (
              <Text modifiers={[
                font({ textStyle: "subheadline" }),
                foregroundStyle(colors.textSecondary),
                frame({ maxWidth: Infinity, alignment: "leading" }),
                padding({ top: 24, leading: 36, trailing: 36, bottom: 12 }),
              ]}>{aboveContentTitle}</Text>
            ) : null}
            {aboveContent ? (
              <RNHostView matchContents>
                <View style={{ paddingHorizontal: 20, paddingTop: aboveContentTitle ? 0 : 24 }}>
                  {aboveContent}
                </View>
              </RNHostView>
            ) : null}
            {nativeContent ? (
              <Form testID={testID} modifiers={[
                scrollContentBackground("hidden"),
                ...(aboveContent ? [padding({ top: -12 })] : []),
              ]}>
                {children}
              </Form>
            ) : (
              <RNHostView>
                <View style={{ flex: 1 }} testID={testID}>
                  <ScrollView
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="interactive"
                    contentContainerStyle={{
                      paddingHorizontal: 16,
                      paddingBottom: 16,
                    }}
                  >
                    {children}
                  </ScrollView>
                  {footer ? (
                    <View style={{ padding: 16 }}>{footer}</View>
                  ) : null}
                </View>
              </RNHostView>
            )}
            {nativeContent && footer ? (
              <Group
                modifiers={[padding({ leading: 20, trailing: 20, bottom: 12 })]}
              >
                {footer}
              </Group>
            ) : null}
          </VStack>
        </Group>
      </BottomSheet>
    </Host>
  );
}
