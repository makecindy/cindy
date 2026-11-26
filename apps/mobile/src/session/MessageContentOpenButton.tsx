import { useContext, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { MessageContentLongPressContext } from './messageContentLongPress';

export function MessageContentOpenButton({
  accessibilityLabel,
  children,
  busy = false,
  disabled = false,
  presentationOnly = false,
  onPress,
  style,
  testID,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  presentationOnly?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const interactionDisabled = busy || disabled || !onPress;
  const onLongPress = useContext(MessageContentLongPressContext);
  if (presentationOnly) return (
      <View style={style} testID={testID}>{children}</View>
    );
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: interactionDisabled, busy }}
      disabled={interactionDisabled}
      onPress={interactionDisabled ? undefined : onPress}
      onLongPress={interactionDisabled ? undefined : onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        style,
        pressed && styles.pressed,
        interactionDisabled && !busy && styles.disabled,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.42 },
});
