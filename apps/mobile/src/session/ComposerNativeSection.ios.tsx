import { useContext } from 'react';
import { Section, Text } from '@expo/ui/swift-ui';
import { font, foregroundStyle, listRowBackground } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/theme';
import type { ComposerNativeSectionProps } from './ComposerNativeSection';
import { ComposerSectionSettingsHeader } from './composerSectionHeader';
export function ComposerNativeSection({ title, ...props }: ComposerNativeSectionProps) {
  const { colors } = useTheme();
  const smallHeader = useContext(ComposerSectionSettingsHeader) && !!title;
  return (
    <Section
      {...props}
      title={smallHeader ? undefined : title}
      header={smallHeader ? (
        <Text modifiers={[font({ textStyle: 'footnote', weight: 'semibold' }), foregroundStyle(colors.textTertiary)]}>
          {title}
        </Text>
      ) : undefined}
      modifiers={[listRowBackground(colors.surfaceTranslucent)]}
    />
  );
}
