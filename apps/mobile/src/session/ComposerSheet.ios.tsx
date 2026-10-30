import { iconSize } from '@/theme';
import { useState } from 'react';
import { Host } from "@expo/ui";
import {
  BottomSheet,
  Form,
  List,
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
  environment,
  opacity,
  scrollDisabled,
  contentShape,
  containerRelativeFrame,
  onGeometryChange,
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
  listStyle,
  scrollDismissesKeyboard,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { ScrollView as RNScrollView, View, useWindowDimensions } from "react-native";
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
  backDisabled = false,
  backLabel,
  headerTrailing,
  children,
  aboveContent,
  aboveContentTitle,
  footer,
  testID,
  nativeContent,
  contentScrolls,
  nativeList,
  nativeEditMode,
  nativeHeader,
  nativeRoot,
  preventDismiss = false,
}: ComposerSheetProps) {
  const { mode, colors } = useTheme();
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const [sheetWidth, setSheetWidth] = useState(0);
  // UIKit disables the medium detent in compact-height landscape. Never bind
  // selection to an unavailable detent, including after rotating an open sheet.
  const landscape = width > height;
  const editModeModifiers = nativeEditMode === undefined
    ? []
    : [environment('editMode', nativeEditMode ? 'active' : 'inactive')];
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
            modifiers={[
              frame({ maxWidth: Infinity, maxHeight: Infinity }),
              containerRelativeFrame({ axes: 'horizontal' }),
              onGeometryChange(size => { if (size.width > 0) setSheetWidth(size.width); }),
            ]}
          >
            {title || onBack ? <HStack
              modifiers={[
                padding({ top: 12, leading: 20, trailing: 20, bottom: 8 }),
                frame({ minHeight: 52 }),
              ]}
            >
              {onBack ? (
                <Button onPress={onBack} modifiers={[buttonStyle("plain"), disabled(backDisabled), accessibilityLabel(backLabel ?? t("interaction.contextSheet.backAccessibility"))]}>
                  <Image size={iconSize.lg} systemName="chevron.left" modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]} />
                </Button>
              ) : null}
              <Spacer />
              <Text modifiers={[font({ textStyle: "headline" })]}>{title}</Text>
              <Spacer />
              {headerTrailing ?? (onBack ? <Spacer modifiers={[frame({ width: 44 })]} /> : null)}
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
              // Constrain the photo strip to the presented sheet, which can be
              // narrower than the window on Duo/iPad and in landscape.
              <RNHostView matchContents>
                <View style={{ width: sheetWidth, paddingHorizontal: 20, paddingTop: aboveContentTitle ? 0 : 24 }}>
                  {sheetWidth > 0 ? aboveContent : null}
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
                    modifiers={[...editModeModifiers, containerRelativeFrame({ axes: 'horizontal' }), scrollContentBackground("hidden")]}
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
                      modifiers={[...editModeModifiers, containerRelativeFrame({ axes: 'horizontal' }), scrollContentBackground("hidden")]}
                    >
                      {children}
                    </Form>
                  </VStack>
                ) : null}
              </ZStack>
            ) : nativeContent && nativeList ? (
              <List testID={testID} modifiers={[
                ...editModeModifiers,
                containerRelativeFrame({ axes: 'horizontal' }),
                listStyle("plain"),
                scrollContentBackground("hidden"),
                scrollDismissesKeyboard("interactively"),
              ]}>
                {children}
              </List>
            ) : nativeContent ? (
              <Form testID={testID} modifiers={[
                ...editModeModifiers,
                containerRelativeFrame({ axes: 'horizontal' }),
                scrollContentBackground("hidden"),
                ...(aboveContent ? [padding({ top: -12 })] : []),
              ]}>
                {children}
              </Form>
            ) : contentScrolls ? (
              <RNHostView>
                <View style={{ flex: 1 }} testID={testID}>
                  <RNScrollView
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="interactive"
                    contentContainerStyle={{
                      paddingHorizontal: 16,
                      paddingBottom: 16,
                    }}
                  >
                    {children}
                  </RNScrollView>
                  {footer ? (
                    <View style={{ padding: 16 }}>{footer}</View>
                  ) : null}
                </View>
              </RNHostView>
            ) : (
              <>
                {/* Native scrolling keeps the viewport aligned with the sheet detent. */}
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
