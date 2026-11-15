import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { TEAMMATE_AVATAR, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { useTheme, radius } from '@/theme';

export function TeammateStatusDot({ status }: { status: TeammateStatus }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (status === 'idle') return null;
  const color = { running: colors.statusAccent, awaiting: colors.statusAwaiting,
    done: colors.statusDone, error: colors.statusError, unread: colors.botUnread }[status];
  return <View testID={`teammate.status.${status}`} accessibilityRole="image"
    accessibilityLabel={t(`devices.companions.avatarStatus.${status}`)}
    style={{ position: 'absolute', right: -1, bottom: -1, padding: TEAMMATE_AVATAR.border,
      borderRadius: radius.pill, backgroundColor: colors.surface }}>
    <View style={{ width: TEAMMATE_AVATAR.dot, height: TEAMMATE_AVATAR.dot,
      borderRadius: radius.pill, backgroundColor: color }} />
  </View>;
}
