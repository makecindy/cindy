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
  ScrollView,
  Spacer,
  Text,
  VStack,
  ZStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  accessibilityElement,
  accessibilityHidden,
  disabled,
  opacity,
  scrollDisabled,
  contentShape,
  shapes,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  padding,
  presentationDetents,
  interactiveDismissDisabled,
  presentationDragIndicator,
  scrollContentBackground,
  scrollDismissesKeyboard,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { View, useWindowDimensions } from "react-native";
import { useTheme } from "@/theme";
import type { ComposerSheetProps } from "./ComposerSheet";
import { CompanionNativeContent } from "./CompanionNativeContent.ios";

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
  nativeRoot,
  preventDismiss = false,
}: ComposerSheetProps) {
  const { mode, colors } = useTheme();
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  // UIKit disables the medium detent in compact-height landscape. Never bind
  // selection to an unavailable detent, including after rotating an open sheet.
  const landscape = width > height;
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
          if (!open && visible) onClose();
        }}
        onDismiss={onClosed}
      >
        <Group
          modifiers={[
            presentationDetents(landscape ? ["large"] : ["medium", "large"], { selection: landscape ? "large" : "medium" }),
            presentationDragIndicator("visible"),
            interactiveDismissDisabled(preventDismiss),
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
            {!nativeRoot && nativeHeader}
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
            {nativeContent && nativeRoot ? (
              <ZStack
                modifiers={[frame({ maxWidth: Infinity, maxHeight: Infinity })]}
              >
                <VStack
                  spacing={0}
                  modifiers={[
                    frame({ maxWidth: Infinity, maxHeight: Infinity }),
                    opacity(nativeRoot.active ? 1 : 0),
                    disabled(!nativeRoot.active),
                    scrollDisabled(!nativeRoot.active),
                    accessibilityElement(
                      nativeRoot.active ? "contain" : "ignore",
                    ),
                    accessibilityHidden(!nativeRoot.active),
                  ]}
                >
                  {nativeRoot.header}
                  <Form
                    testID={testID ? `${testID}.list` : undefined}
                    modifiers={[scrollContentBackground("hidden")]}
                  >
                    {nativeRoot.content}
                  </Form>
                </VStack>
                {!nativeRoot.active ? (
                  <VStack
                    spacing={0}
                    modifiers={[
                      frame({ maxWidth: Infinity, maxHeight: Infinity }),
                    ]}
                  >
                    {nativeHeader}
                    <Form
                      testID={testID}
                      modifiers={[scrollContentBackground("hidden")]}
                    >
                      {children}
                    </Form>
                  </VStack>
                ) : null}
              </ZStack>
            ) : nativeContent ? (
              <Form testID={testID} modifiers={[
                scrollContentBackground("hidden"),
                ...(aboveContent ? [padding({ top: -12 })] : []),
              ]}>
                {children}
              </Form>
            ) : (
              <>
                {/* Let SwiftUI own the viewport at every sheet detent instead
                    of scrolling inside a full-height RN bridge that can be
                    clipped by the medium presentation. */}
                <ScrollView modifiers={[scrollDismissesKeyboard("interactively")]}>
                  <CompanionNativeContent>
                    <View testID={testID} style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                      {children}
                    </View>
                  </CompanionNativeContent>
                </ScrollView>
                {footer ? (
                  <CompanionNativeContent>
                    <View style={{ padding: 16 }}>{footer}</View>
                  </CompanionNativeContent>
                ) : null}
              </>
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
