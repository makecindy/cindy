import { Host } from '@expo/ui';
import { Button, HStack, Image, ProgressView, RNHostView, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel, accessibilityAddTraits, buttonStyle, contentShape, disabled as disabledModifier,
  font, foregroundStyle, frame, lineLimit, shapes,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { useTheme } from '@/theme';
import { useNativeGlassButtonStyle } from '@/platform/chrome/nativeGlassButtonStyle.ios';
import type { LoginNativeButtonProps } from './LoginNativeButton';

export const hasNativeLoginButtons = true;

/** Login's scaled layout owns the frame; SwiftUI owns activation and feedback.
 * RNHostView is reserved for existing brand artwork, never an inner Pressable. */
export function LoginNativeButton({ label, onPress, disabled, busy, testID,
  width, height, fontSize, style, variant = 'secondary', subtitle, children, trailingArtwork,
  artworkSize = fontSize, showLabel = !children, accessibilityLabel: spokenLabel, selected,
}: LoginNativeButtonProps) {
  const { colors, mode } = useTheme();
  const prominent = variant === 'primary' || variant === 'circle';
  const inert = !!(disabled || busy);
  const foreground = inert ? colors.textSecondary : prominent ? colors.ctaText : colors.textPrimary;
  const glassStyle = useNativeGlassButtonStyle({
    shape: variant === 'circle' ? 'circle' : 'capsule', prominent: prominent && (!inert || variant === 'circle'),
    dimensions: { width, height },
  });
  return <Host colorScheme={mode} seedColor={colors.cta} ignoreSafeArea="all"
    style={[{ width: width ?? '100%', height }, style]}>
    <Button testID={testID} onPress={() => { if (!inert) onPress?.(); }} modifiers={[
      ...(variant === 'text'
        ? [buttonStyle('borderless'), frame({ width, height, ...(width == null ? { maxWidth: Infinity } : {}) }), contentShape(shapes.capsule())]
        : glassStyle),
      font({ size: fontSize, weight: prominent ? 'bold' : 'regular' }),
      foregroundStyle(foreground), accessibilityLabel(spokenLabel ?? label), disabledModifier(inert),
      ...(selected ? [accessibilityAddTraits(['isSelected'])] : []),
    ]}>
      <HStack spacing={fontSize / 2}>
        {children ? <VStack modifiers={[frame({ width: artworkSize, height: artworkSize })]}>
          <RNHostView><View pointerEvents="none" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>{children}</View></RNHostView>
        </VStack> : null}
        {showLabel ? <VStack modifiers={width ? [frame({ maxWidth: width - artworkSize * 3 })] : []}>
          <Text modifiers={[lineLimit(1)]}>{label}</Text>
          {subtitle ? <Text modifiers={[font({ size: fontSize * 5 / 6 }), foregroundStyle(colors.textSecondary), lineLimit(1)]}>{subtitle}</Text> : null}
        </VStack> : null}
        {busy ? <ProgressView /> : null}
        {trailingArtwork ? <VStack modifiers={[frame({ width: artworkSize, height: artworkSize })]}>
          <RNHostView><View pointerEvents="none" style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>{trailingArtwork}</View></RNHostView>
        </VStack> : null}
        {selected ? <Image systemName="checkmark" size={fontSize} /> : null}
      </HStack>
    </Button>
  </Host>;
}
