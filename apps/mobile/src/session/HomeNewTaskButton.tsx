import { View } from 'react-native';
import { SquarePen } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { iconSize, iconStroke, useTheme } from '@/theme';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';

const HOME_NEW_TASK_SIZE = 55;

/** Shared home/detail floating action: keep the circle, artwork and placement together. */
export function HomeNewTaskButton({ onPress, bottomInset, disabled = false }: {
  onPress(): void; bottomInset: number; disabled?: boolean;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return <View style={{ position: 'absolute', right: 20, bottom: 45 + bottomInset, width: HOME_NEW_TASK_SIZE, height: HOME_NEW_TASK_SIZE }}>
    <HomeHeaderGlassButton accessibilityLabel={t('devices.list.a11y.newRemoteConversation')}
      onPress={onPress} disabled={disabled} prominent size={HOME_NEW_TASK_SIZE} artworkSize={iconSize.xxl}
      testID="home.newChatButton">
      <SquarePen color={colors.ctaText} size={iconSize.xxl} strokeWidth={iconStroke.regular} />
    </HomeHeaderGlassButton>
  </View>;
}
