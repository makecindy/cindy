import { useNativeGlassButtonStyle } from "@/platform/chrome/nativeGlassButtonStyle.ios";
import { iconSize, useTheme } from '@/theme';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { Button, HStack, Image, Picker, RNHostView, ProgressView, Spacer, Text, TextField, VStack, useNativeState } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityHint,
  accessibilityLabel,
  buttonStyle,
  contentShape,
  disabled as disable,
  font,
  frame,
  foregroundStyle,
  lineLimit,
  listRowInsets,
  onLongPressGesture,
  onTapGesture,
  pickerStyle,
  shapes,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import type {
  ContextSheetChoiceRowProps,
  ContextSheetProps,
  ContextSheetRowProps,
  ContextSheetFooterButtonProps,
  ContextSheetTextFieldProps,
} from "./ContextSheet";
import { ComposerSheet } from "./ComposerSheet";
const DismissAction = createContext<(action: () => void) => void>((action) =>
  action(),
);

export function ContextSheet(props: ContextSheetProps) {
  const { t } = useTranslation();
  const pending = useRef<(() => void) | null>(null);
  const { colors } = useTheme();
  // Reopening during the dismiss animation drops the previous row action, so a later
  // ordinary close cannot replay a stale picker.
  useEffect(() => {
    if (props.visible) pending.current = null;
  }, [props.visible]);
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
  const { colors } = useTheme();
  const labelModifiers = props.destructive ? [foregroundStyle(colors.destructive)] : [];
  const press = () => (props.dismissBeforePress ? dismiss(props.onPress) : props.onPress());
  const inactive = !!props.disabled || !!props.busy;
  const content = (extraModifiers: ReturnType<typeof frame>[]) => (
    <HStack
      modifiers={[
        frame({ maxWidth: Infinity, minHeight: 44 }),
        contentShape(shapes.rectangle()),
        ...extraModifiers,
      ]}
    >
      <RNHostView matchContents>
        <View style={{ width: 28, height: 28, justifyContent: "center" }}>
          {props.icon}
        </View>
      </RNHostView>
      {props.detail ? (
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[...labelModifiers, lineLimit(1)]}>{props.label}</Text>
          <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary), lineLimit(1)]}>{props.detail}</Text>
        </VStack>
      ) : (
        <Text modifiers={labelModifiers}>{props.label}</Text>
      )}
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
  );
  const accessibility = props.accessibilityHint ? [accessibilityHint(props.accessibilityHint)] : [];
  if (props.onLongPress) {
    // 带长按的行(协同 Worker):SwiftUI Button 与长按手势会互相抢,改用同一视图上的
    // 点按 + 长按手势,点按直接执行,长按弹出管理操作。
    const longPress = props.onLongPress;
    return content([
      listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }),
      disable(inactive),
      accessibilityAddTraits(['isButton']),
      ...accessibility,
      ...(inactive ? [] : [onTapGesture(press), onLongPressGesture(longPress)]),
    ]);
  }
  return (
    <Button
      onPress={press}
      testID={props.testID}
      modifiers={[
        buttonStyle("plain"),
        listRowInsets({ top: 4, bottom: 4, leading: 16, trailing: 16 }),
        disable(inactive),
        ...accessibility,
      ]}
    >
      {content([])}
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

export function ContextSheetNote({ text, tone = 'secondary', testID }: {
  text: string;
  tone?: 'secondary' | 'error';
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Text testID={testID} modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(tone === 'error' ? colors.errorText : colors.textSecondary)]}>
      {text}
    </Text>
  );
}

export function ContextSheetChoiceRow<T extends string>(props: ContextSheetChoiceRowProps<T>) {
  return (
    <Picker
      label={props.label}
      selection={props.value ?? ''}
      onSelectionChange={(next: string | number) => {
        const option = props.options.find((item) => item.id === String(next));
        if (option) props.onChange(option.id);
      }}
      modifiers={[pickerStyle(props.options.length <= 3 ? 'segmented' : 'menu'), disable(!!props.disabled)]}
      testID={props.testID}
    >
      {props.options.map((option) => (
        <Text key={option.id} modifiers={[tag(option.id)]}>{option.label}</Text>
      ))}
    </Picker>
  );
}

export function ContextSheetTextField(props: ContextSheetTextFieldProps) {
  const text = useNativeState(props.value);
  useEffect(() => { if (text.get() !== props.value) text.set(props.value); }, [props.value, text]);
  return (
    <TextField
      text={text}
      onTextChange={props.onChange}
      axis={props.multiline ? 'vertical' : 'horizontal'}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      testID={props.testID}
      modifiers={[
        disable(!!props.disabled),
        accessibilityLabel(props.accessibilityLabel),
        ...(props.multiline ? [lineLimit({ min: 3, max: 6 })] : []),
      ]}
    />
  );
}
