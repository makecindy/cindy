import { Button, Host, Image, ProgressView } from '@expo/ui/swift-ui';
import { accessibilityLabel, accessibilityHidden, background, buttonStyle, contentShape, disabled as disabledModifier,
  frame, labelStyle, shapes } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/theme';
import type { AudioPlayerButtonProps } from './AudioPlayerButton';

export function AudioPlayerButton({ symbol, label, disabled = false, loading = false, primary = false,
  size, width, height, onPress, testID }: AudioPlayerButtonProps) {
  const { colors, mode } = useTheme();
  const fg = loading || disabled ? colors.textTertiary : primary ? colors.ctaText : colors.textPrimary;
  const shape = shapes.circle();
  return (
    <Host colorScheme={mode} ignoreSafeArea="all" style={{ width, height }}>
      <Button onPress={onPress} testID={testID} modifiers={[
        labelStyle('iconOnly'), buttonStyle('plain'), disabledModifier(disabled), accessibilityLabel(label),
      ]}>
        {loading
          ? <ProgressView modifiers={[frame({ width, height }), contentShape(shape), background(colors.surfaceChip, shape)]} />
          : <Image systemName={symbol} size={size} color={fg} modifiers={[
              frame({ width, height }), contentShape(shape), accessibilityHidden(),
              ...(primary ? [background(colors.cta, shape)] : []),
            ]} />}
      </Button>
    </Host>
  );
}
