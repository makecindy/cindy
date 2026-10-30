import { iconSize } from '@/theme';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { Button, HStack, Image, RNHostView, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  contentShape,
  shapes,
  autocorrectionDisabled,
  buttonStyle,
  frame,
  textInputAutocapitalization,
} from "@expo/ui/swift-ui/modifiers";
import { useEffect } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { ComposerNativeRow } from "./ComposerNativeRow";
import type { ModelPickerNativeHeaderProps } from "./ModelPickerNativeHeader";
export function ModelPickerNativeHeader(p: ModelPickerNativeHeaderProps) {
  const { t } = useTranslation();
  const text = useNativeState(p.query);
  useEffect(() => {
    if (text.get() !== p.query) text.set(p.query);
  }, [p.query, text]);
  return (
    <>
      {p.agentContent ? (
        <Section>
          <RNHostView matchContents>
            <View>{p.agentContent}</View>
          </RNHostView>
        </Section>
      ) : null}
      <Section>
        <HStack>
          <Image size={iconSize.lg} systemName="magnifyingglass" />
          <TextField
            text={text}
            onTextChange={p.onChangeQuery}
            placeholder={t("models.picker.searchPlaceholder")}
            modifiers={[
              autocorrectionDisabled(),
              textInputAutocapitalization("never"),
              frame({ maxWidth: Infinity }),
            ]}
            testID={`${p.testID}.search`}
          />
          {p.query ? (
            <Button onPress={() => { text.set(""); p.onChangeQuery(""); }}
              modifiers={[buttonStyle("plain"), accessibilityLabel(t("devices.detail.search.clearA11y"))]}>
              <Image size={iconSize.lg} systemName="xmark.circle.fill" modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]} />
            </Button>
          ) : null}
        </HStack>
      </Section>
      {p.onPermission ? (
        <Section>
          <ComposerNativeRow
            title={t("models.picker.permissionTitle")}
            subtitle={p.permissionLabel}
            disabled={p.permissionDisabled}
            onPress={p.onPermission}
            testID={`${p.testID}.permissionTrigger`}
          />
        </Section>
      ) : null}
      {p.noResults ? (
        <Section>
          <Text>{t("models.picker.noResults")}</Text>
        </Section>
      ) : null}
    </>
  );
}
