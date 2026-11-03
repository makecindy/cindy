import { HStack, RNHostView, Text } from '@expo/ui/swift-ui';
import {
  fixedSize,
  font,
  foregroundStyle,
  frame,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { CircleAlert } from 'lucide-react-native';
import { iconSize, iconStroke, spacing, typeScale, useTheme } from '@/theme';

/** Error row inside an existing SwiftUI section; the section owns its card surface. */
export function NativeErrorNotice({
  message,
  testID,
}: {
  message: string;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <HStack alignment="top" spacing={spacing.sm}>
      <RNHostView matchContents>
        <View
          accessibilityElementsHidden
          style={{ width: iconSize.sm, height: iconSize.sm }}
        >
          <CircleAlert
            color={colors.statusError}
            size={iconSize.sm}
            strokeWidth={iconStroke.regular}
          />
        </View>
      </RNHostView>
      <Text
        testID={testID}
        modifiers={[
          font({ size: typeScale.footnote, weight: 'regular' }),
          foregroundStyle(colors.textSecondary),
          fixedSize({ horizontal: false, vertical: true }),
          frame({ maxWidth: Infinity, alignment: 'leading' }),
        ]}
      >
        {message}
      </Text>
    </HStack>
  );
}
