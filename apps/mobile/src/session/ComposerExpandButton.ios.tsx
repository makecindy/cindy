import { iconSize } from '@/theme';
import { Host } from '@expo/ui';
import { Button, Image } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, contentShape, frame, shapes } from '@expo/ui/swift-ui/modifiers';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/theme';
import type { ComposerExpandButtonProps } from './ComposerExpandButton';
export function ComposerExpandButton({ onPress }: ComposerExpandButtonProps) {
  const { t } = useTranslation();
  const { colors, mode } = useTheme();
  return <Host colorScheme={mode} seedColor={colors.textSecondary} style={{ width: 44, height: 44 }}>
    <Button onPress={onPress} testID="session.composerExpandButton" modifiers={[buttonStyle('plain'), accessibilityLabel(t('message.renderer.expand'))]}>
      <Image size={iconSize.lg} systemName="arrow.up.left.and.arrow.down.right" modifiers={[frame({ width: 44, height: 44 }), contentShape(shapes.rectangle())]} />
    </Button>
  </Host>;
}
