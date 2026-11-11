import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ViewProps } from 'react-native';
import { CircleAlert, X } from 'lucide-react-native';
import { mobileInteractionStyles } from './mobileInteractionStyles';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';

/** Mobile counterpart of the shared desktop error card; recovery stays with the caller. */
export function ErrorNotice({
  message,
  messageTestID,
  description,
  actions,
  icon,
  onDismiss,
  dismissLabel,
  dismissTestID,
  dismissDisabled,
  dismissBusy,
  dismissHint,
  children,
  style,
  ...props
}: ViewProps & {
  message: string;
  messageTestID?: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissTestID?: string;
  dismissDisabled?: boolean;
  dismissBusy?: boolean;
  dismissHint?: string;
  children?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={[styles.card, style]} {...props}>
      <View style={styles.header}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.icon}
        >
          {icon ?? (
            <CircleAlert
              color={colors.statusError}
              size={iconSize.sm}
              strokeWidth={iconStroke.regular}
            />
          )}
        </View>
        <View style={styles.heading}>
          <Text selectable style={styles.message} testID={messageTestID}>
            {message}
          </Text>
          {description ? (
            <Text style={styles.description}>{description}</Text>
          ) : null}
        </View>
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dismissLabel}
            accessibilityHint={dismissHint}
            accessibilityState={{ disabled: !!dismissDisabled, busy: !!dismissBusy }}
            disabled={dismissDisabled}
            testID={dismissTestID}
            onPress={onDismiss}
            hitSlop={4}
            style={({ pressed }) => [
              styles.close,
              dismissDisabled && styles.disabled,
              pressed && mobileInteractionStyles.pressed,
            ]}
          >
            <X
              color={colors.textSecondary}
              size={iconSize.sm}
              strokeWidth={iconStroke.regular}
            />
          </Pressable>
        ) : null}
      </View>
      {children ? <View style={styles.content}>{children}</View> : null}
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

/** A compact button face with a full-height touch target. */
export function ErrorNoticeAction({
  label,
  icon,
  onPress,
  disabled,
  busy,
  hint,
  testID,
  primary,
}: {
  label: string;
  icon?: ReactNode;
  onPress(): void;
  disabled?: boolean;
  busy?: boolean;
  hint?: string;
  testID?: string;
  primary?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.actionTarget,
        pressed && mobileInteractionStyles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <View style={[styles.actionFace, primary && styles.primaryFace]}>
        {icon}
        <Text style={styles.actionLabel}>{label}</Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      gap: spacing.lg,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceElevated,
      padding: spacing.lg,
    },
    header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    icon: { paddingTop: (lineHeight.caption - iconSize.sm) / 2 },
    heading: { flex: 1, minWidth: 0, gap: spacing.sm },
    close: {
      minWidth: 44,
      minHeight: 44,
      marginTop: -spacing.sm,
      marginRight: -spacing.sm,
      marginBottom: -spacing.sm,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
    },
    content: { minWidth: 0, gap: spacing.sm },
    disabled: { opacity: 0.5 },
    actionTarget: { minHeight: 44, maxWidth: '100%', justifyContent: 'center' },
    actionFace: {
      minHeight: lineHeight.bodySmall + spacing.sm * 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    primaryFace: {
      backgroundColor: colors.surfaceChip,
      borderColor: colors.surfaceChip,
    },
    actionLabel: {
      flexShrink: 1,
      color: colors.textPrimary,
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.medium,
    },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.md,
    },
    message: {
      color: colors.textPrimary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
    description: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
    },
  });
