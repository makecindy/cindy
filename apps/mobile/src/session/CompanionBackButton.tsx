import { ChevronLeft } from 'lucide-react-native';
import { iconSize, iconStroke, useTheme } from '@/theme';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';

/** Non-iOS fallback matching ScreenBackButton's icon metrics. */
export function CompanionBackButton({ label, onPress }: { label: string; onPress(): void }) {
  const { colors } = useTheme();
  return <HomeHeaderGlassButton testID="companion.back" accessibilityLabel={label} onPress={onPress}>
    <ChevronLeft size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
  </HomeHeaderGlassButton>;
}
