import { iconSize } from '@/theme';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import {
  Children,
  Fragment,
  createContext,
  isValidElement,
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
  shapes,
} from "@expo/ui/swift-ui/modifiers";
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

function nativeChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return null;
    if (child.type === Fragment) return nativeChildren(child.props.children);
    if (
      child.type === ContextSheetGroup ||
      child.type === ContextSheetRow ||
      child.type === ContextSheetFooterButton
    )
      return child;
    return (
      <RNHostView matchContents>
        <View>{child}</View>
      </RNHostView>
    );
  });
}
export function ContextSheet(props: ContextSheetProps) {
  const pending = useRef<(() => void) | null>(null);
  return (
    <DismissAction.Provider
      value={(action) => {
        pending.current = action;
        props.onClose();
      }}
    >
      <ComposerSheet
        {...props}
        nativeContent
        onClosed={() => {
          const action = pending.current;
          pending.current = null;
          action?.();
        }}
        footer={props.footer}
      >
        {nativeChildren(props.children)}
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
  return <Section title={label}>{nativeChildren(children)}</Section>;
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
  return (
    <Button
      onPress={props.onPress}
      testID={props.testID}
      modifiers={[
        buttonStyle("glassProminent"),
        disable(!!props.disabled || !!props.busy),
        frame({ maxWidth: Infinity, minHeight: 44 }),
      ]}
    >
      {props.busy ? <ProgressView /> : <Text>{props.label}</Text>}
    </Button>
  );
}
