import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { iconSize, useTheme } from '@/theme';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
} from "react";
import { Button, HStack, Image, RNHostView, ProgressView, Spacer, Text } from '@expo/ui/swift-ui';
import {
  accessibilityHint,
  buttonStyle,
  contentShape,
  disabled as disable,
  frame,
  foregroundStyle,
  listRowInsets,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type {
  ContextSheetProps,
  ContextSheetRowProps,
  ContextSheetFooterButtonProps,
} from "./ContextSheet";
import { ComposerSheet } from "./ComposerSheet";
const DismissAction = createContext<(action: () => void) => void>((action) =>
  action(),
);

export function ContextSheet(props: ContextSheetProps) {
  const { t } = useTranslation();
  const pending = useRef<(() => void) | null>(null);
  const { colors } = useTheme();
  return (
    <DismissAction.Provider
      value={(action) => {
        pending.current = action;
        props.onClose();
      }}
    >
      <ComposerSheet
        {...props}
        title={props.onBack ? props.title : ''}
        aboveContent={props.media}
        aboveContentTitle={t("session.common.groupAdd")}
        nativeContent
        onClosed={() => {
          const action = pending.current;
          pending.current = null;
          action?.();
        }}
        footer={props.footer}
      >
        {props.children}
        {props.error ? (
          <Section>
            <Text modifiers={[foregroundStyle(colors.errorText)]}>{props.error}</Text>
          </Section>
        ) : null}
      </ComposerSheet>
    </DismissAction.Provider>
  );
}
export function ContextSheetGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return <Section title={label || undefined}>{children}</Section>;
}
export function ContextSheetRow(props: ContextSheetRowProps) {
  const dismiss = useContext(DismissAction);
  return (
    <Button
      onPress={() =>
        props.dismissBeforePress ? dismiss(props.onPress) : props.onPress()
      }
      testID={props.testID}
      modifiers={[
        buttonStyle("plain"),
        listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }),
        disable(!!props.disabled || !!props.busy),
        ...(props.accessibilityHint
          ? [accessibilityHint(props.accessibilityHint)]
          : []),
      ]}
    >
      <HStack
        modifiers={[
          frame({ maxWidth: Infinity, minHeight: 44 }),
          contentShape(shapes.rectangle()),
        ]}
      >
        <RNHostView matchContents>
          <View style={{ width: 28, height: 28, justifyContent: "center" }}>
            {props.icon}
          </View>
        </RNHostView>
        <Text>{props.label}</Text>
        <Spacer />
        {props.busy ? (
          <ProgressView />
        ) : props.trailing && props.trailing !== "chevron" ? (
          <RNHostView matchContents>
            <View>{props.trailing}</View>
          </RNHostView>
        ) : props.trailing === "chevron" ? (
          <Image size={iconSize.lg} systemName="chevron.right" />
        ) : null}
      </HStack>
    </Button>
  );
}
export function ContextSheetFooterButton(props: ContextSheetFooterButtonProps) {
  const glassStyle = useNativeGlassButtonStyle({ prominent: true });
  return (
    <Button
      onPress={props.onPress}
      testID={props.testID}
      modifiers={[
        ...glassStyle,
        disable(!!props.disabled || !!props.busy),
        frame({ maxWidth: Infinity, minHeight: 44 }),
      ]}
    >
      {props.busy ? <ProgressView /> : <Text>{props.label}</Text>}
    </Button>
  );
}
