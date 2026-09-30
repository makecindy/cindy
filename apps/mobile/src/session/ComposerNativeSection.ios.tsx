import { Section } from '@expo/ui/swift-ui';
import { listRowBackground } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/theme';
import type { ComposerNativeSectionProps } from './ComposerNativeSection';
export function ComposerNativeSection(props: ComposerNativeSectionProps) {
  const { colors } = useTheme();
  return <Section {...props} modifiers={[listRowBackground(colors.surfaceTranslucent)]} />;
}
