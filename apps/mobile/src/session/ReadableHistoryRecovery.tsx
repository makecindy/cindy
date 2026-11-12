import { Split } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ErrorNoticeAction } from '@/components/ErrorNotice';
import { iconSize, iconStroke, useTheme } from '@/theme';

/** Explicit recovery only; never sends a message or interprets the cause of a stream failure. */
export function ReadableHistoryRecovery({
  onRecover,
  busy,
  disabled,
}: {
  onRecover(): void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <ErrorNoticeAction
      label={t('session.tail.readableHistoryRecovery')}
      icon={
        <Split
          color={colors.textPrimary}
          size={iconSize.sm}
          strokeWidth={iconStroke.regular}
        />
      }
      onPress={onRecover}
      disabled={busy || disabled}
      busy={busy}
      testID="session.readableHistoryRecovery"
    />
  );
}
