import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Stethoscope } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { Text } from '@/components/AppText';
import { ErrorNoticeAction } from '@/components/ErrorNotice';
import {
  iconSize,
  iconStroke,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from '@/theme';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** Local disclosure only: never retries a request or changes the persisted error. */
export function AgentErrorDetails({
  message,
  actions,
  onDiagnose,
}: {
  message: string;
  actions?: ReactNode;
  /** Offered only after the user expands details; the caller decides where diagnosis happens. */
  onDiagnose?: () => void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [message]);
  return (
    <View>
      <View style={styles.actions}>
        {actions}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => [
            styles.toggle,
            pressed && mobileInteractionStyles.pressed,
          ]}
        >
          {expanded ? (
            <ChevronDown
              color={colors.textSecondary}
              size={iconSize.sm}
              strokeWidth={iconStroke.regular}
            />
          ) : (
            <ChevronRight
              color={colors.textSecondary}
              size={iconSize.sm}
              strokeWidth={iconStroke.regular}
            />
          )}
          <Text style={styles.label}>
            {t(
              expanded
                ? 'session.tail.hideErrorDetails'
                : 'session.tail.showErrorDetails',
            )}
          </Text>
        </Pressable>
        {expanded && onDiagnose ? (
          <ErrorNoticeAction
            label={t('session.tail.diagnose')}
            hint={t('session.tail.diagnoseHint')}
            icon={
              <Stethoscope
                color={colors.textPrimary}
                size={iconSize.sm}
                strokeWidth={iconStroke.regular}
              />
            }
            onPress={onDiagnose}
            testID="agentError.diagnose"
          />
        ) : null}
      </View>
      {expanded ? (
        <Text selectable style={styles.detail}>
          {redactSensitiveText(message)}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: spacing.md,
      rowGap: spacing.sm,
    },
    toggle: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      minHeight: 44,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
    },
    label: {
      flexShrink: 1,
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
    },
    detail: {
      marginTop: spacing.sm,
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      backgroundColor: colors.surface,
      padding: spacing.sm,
      borderRadius: radius.control,
    },
  });
