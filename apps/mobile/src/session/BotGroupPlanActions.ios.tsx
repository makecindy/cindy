import { Host } from '@expo/ui';
import { Button, HStack, ProgressView, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, background, buttonStyle, contentShape, disabled, font, foregroundStyle, frame, opacity, padding, shapes } from '@expo/ui/swift-ui/modifiers';
import type { MainWindowAction } from '@/components/MobilePrimitives';
import { spacing, typeScale, useTheme } from '@/theme';

/** Native card buttons: a 38pt capsule inside a 44pt tappable label. */
export function BotGroupPlanActions({ actions }: { actions: readonly MainWindowAction[] }) {
  const { colors, mode } = useTheme();
  return <Host colorScheme={mode} matchContents ignoreSafeArea="all">
    <HStack spacing={spacing.xs}>
      {actions.map(action => {
        const primary = action.tone === 'primary';
        const unavailable = Boolean(action.disabled || action.busy || !action.onPress);
        return <Button key={action.testID ?? action.label}
          testID={action.testID} onPress={() => { if (!unavailable) action.onPress?.(); }} modifiers={[
            buttonStyle('plain'), font({ size: typeScale.bodySmall, weight: 'medium' }),
            foregroundStyle(primary ? colors.ctaText : colors.textPrimary), opacity(unavailable ? 0.45 : 1),
            accessibilityLabel(action.accessibilityLabel ?? action.label), disabled(unavailable),
          ]}>
          <HStack modifiers={[
            padding({ horizontal: spacing.md }), frame({ height: 38 }), frame({ minWidth: 44 }),
            background(primary ? colors.cta : colors.surfaceChip, shapes.capsule()),
            // Keep the extra touch area inside the native Button label, outside its visible capsule.
            frame({ minHeight: 44 }), contentShape(shapes.rectangle()),
          ]}>
            {action.busy ? <ProgressView /> : <Text>{action.label}</Text>}
          </HStack>
        </Button>;
      })}
    </HStack>
  </Host>;
}
