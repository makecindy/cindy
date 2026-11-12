import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { Host } from "@expo/ui";
import {
  BottomSheet,
  Button,
  Group,
  HStack,
  Spacer,
  Text,
  TextField,
  VStack,
  useNativeState,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  autocorrectionDisabled,
  background,
  buttonStyle,
  disabled,
  font,
  foregroundStyle,
  frame,
  labelStyle,
  padding,
  presentationDragIndicator,
  shapes,
  submitLabel,
  textInputAutocapitalization,
} from "@expo/ui/swift-ui/modifiers";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { spacing, useTheme } from "@/theme";
import type { SessionSearchNativeProps } from "./SessionSearchNative";

export function SessionSearchNative(props: SessionSearchNativeProps) {
  const { colors, mode } = useTheme();
  return (
    <Host
      colorScheme={mode}
      seedColor={colors.textPrimary}
      pointerEvents="none"
      style={{ position: "absolute" }}
    >
      <BottomSheet
        fitToContents
        isPresented={props.visible}
        onIsPresentedChange={(presented) => {
          if (!presented) props.onClose();
        }}
      >
        <Group modifiers={[presentationDragIndicator("visible")]}>
          <SearchContent {...props} />
        </Group>
      </BottomSheet>
    </Host>
  );
}

function SearchContent({
  query,
  counter,
  hasHits,
  loadEarlier,
  onChangeQuery,
  onMove,
  onLoadEarlier,
}: SessionSearchNativeProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const glassStyle = useNativeGlassButtonStyle({ shape: "circle" });
  const text = useNativeState(query);
  useEffect(() => {
    if (text.get() !== query) text.set(query);
  }, [query, text]);
  return (
    <VStack
      spacing={spacing.sm}
      modifiers={[
        padding({
          top: spacing.lg,
          leading: spacing.lg,
          trailing: spacing.lg,
          bottom: spacing.lg,
        }),
        frame({
          maxWidth: Infinity,
          alignment: "topLeading",
        }),
      ]}
    >
      <Text modifiers={[font({ textStyle: "headline" })]}>
        {t("session.screen.searchTitle")}
      </Text>
      <HStack
        spacing={spacing.sm}
        modifiers={[
          padding({ leading: spacing.md, trailing: spacing.sm }),
          frame({ minHeight: 48 }),
          background(colors.surfaceTranslucent, shapes.capsule()),
        ]}
      >
        <TextField
          text={text}
          autoFocus
          placeholder={t("session.screen.searchPlaceholder")}
          onTextChange={onChangeQuery}
          testID="session.searchInput"
          modifiers={[
            autocorrectionDisabled(),
            textInputAutocapitalization("never"),
            submitLabel("search"),
            accessibilityLabel(t("session.screen.searchPlaceholder")),
            frame({ maxWidth: Infinity }),
          ]}
        />
        {query ? (
          <Button
            label={t("devices.detail.search.clearA11y")}
            systemImage="xmark.circle.fill"
            onPress={() => {
              text.set("");
              onChangeQuery("");
            }}
            modifiers={[
              labelStyle("iconOnly"),
              buttonStyle("plain"),
              frame({ width: 44, height: 44 }),
            ]}
          />
        ) : null}
      </HStack>
      <HStack>
        <Text
          testID="session.searchCounter"
          modifiers={[
            font({ textStyle: "subheadline" }),
            foregroundStyle(colors.textSecondary),
          ]}
        >
          {counter}
        </Text>
        <Spacer />
        <Button
          label={t("session.screen.searchPrevious")}
          systemImage="chevron.up"
          onPress={() => onMove("previous")}
          testID="session.searchPreviousButton"
          modifiers={[
            labelStyle("iconOnly"),
            ...glassStyle,
            disabled(!hasHits),
            frame({ width: 44, height: 44 }),
          ]}
        />
        <Button
          label={t("session.screen.searchNext")}
          systemImage="chevron.down"
          onPress={() => onMove("next")}
          testID="session.searchNextButton"
          modifiers={[
            labelStyle("iconOnly"),
            ...glassStyle,
            disabled(!hasHits),
            frame({ width: 44, height: 44 }),
          ]}
        />
      </HStack>
      {loadEarlier.visible ? (
        <Button
          label={loadEarlier.label}
          onPress={onLoadEarlier}
          testID="session.searchLoadEarlierButton"
          modifiers={[
            buttonStyle("bordered"),
            disabled(loadEarlier.disabled),
            accessibilityLabel(loadEarlier.accessibilityLabel),
          ]}
        />
      ) : null}
    </VStack>
  );
}
