import { Fragment } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Check, type LucideIcon } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { iconSize, iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { SessionActionSheetFrame } from './SessionActionSheetFrame';

export interface HomeSectionOptionItem {
  id: string;
  title: string;
  subtitle?: string;
  selected?: boolean;
  disabled?: boolean;
  sfSymbol?: string;
  icon?: LucideIcon;
  testID?: string;
  onPress(): void;
}

export interface HomeSectionOptionsGroup {
  id: string;
  title?: string;
  footer?: string;
  items: readonly HomeSectionOptionItem[];
}

export interface HomeSectionOptionsSheetProps {
  visible: boolean;
  title: string;
  sections: readonly HomeSectionOptionsGroup[];
  testID?: string;
  onClose(): void;
  onClosed?(): void;
}

/** Shared Android (Compose bottom sheet) and non-iOS options sheet for Home section headers. */
export function HomeSectionOptionsSheet({
  visible,
  title,
  sections,
  testID,
  onClose,
  onClosed,
}: HomeSectionOptionsSheetProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const nativeSheet = Platform.OS === 'android';
  const visibleSections = sections.filter((section) => section.items.length > 0);

  return (
    <SessionActionSheetFrame visible={visible} onClose={onClose} onClosed={onClosed}>
      <View style={[styles.card, nativeSheet && styles.nativeCard]} testID={testID}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {visibleSections.map((section, sectionIndex) => (
          <Fragment key={section.id}>
            {sectionIndex > 0 ? <View style={styles.divider} /> : null}
            {section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <Pressable
                  key={item.id}
                  accessibilityLabel={[item.title, item.subtitle].filter(Boolean).join(', ')}
                  accessibilityRole="button"
                  accessibilityState={{
                    ...(item.selected !== undefined ? { selected: item.selected } : {}),
                    ...(item.disabled ? { disabled: true } : {}),
                  }}
                  disabled={item.disabled}
                  onPress={item.onPress}
                  style={({ pressed }) => [
                    styles.row,
                    item.disabled && styles.disabled,
                    pressed && !item.disabled && styles.pressed,
                  ]}
                  testID={item.testID}
                >
                  {Icon ? (
                    <View style={styles.iconSlot}>
                      <Icon color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} />
                    </View>
                  ) : null}
                  <View style={styles.labelGroup}>
                    <Text style={styles.rowLabel} numberOfLines={1}>{item.title}</Text>
                    {item.subtitle ? (
                      <Text style={styles.rowSubtitle} numberOfLines={1}>{item.subtitle}</Text>
                    ) : null}
                  </View>
                  {item.selected ? (
                    <Check color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />
                  ) : null}
                </Pressable>
              );
            })}
            {section.footer ? <Text style={styles.footer}>{section.footer}</Text> : null}
          </Fragment>
        ))}
      </View>
    </SessionActionSheetFrame>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      padding: spacing.md,
    },
    nativeCard: {
      borderWidth: 0,
    },
    title: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.title,
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.sm,
    },
    sectionTitle: {
      color: colors.textTertiary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.xs,
      paddingBottom: spacing.xs,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.md,
      minHeight: 48,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    iconSlot: {
      alignItems: 'center',
      justifyContent: 'center',
      width: 24,
    },
    labelGroup: {
      flex: 1,
      minWidth: 0,
    },
    rowLabel: {
      color: colors.textPrimary,
      flexShrink: 1,
      fontSize: typeScale.body,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.body,
    },
    rowSubtitle: {
      color: colors.textSecondary,
      flexShrink: 1,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
    },
    divider: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginVertical: spacing.sm,
    },
    footer: {
      color: colors.textSecondary,
      fontSize: typeScale.footnote,
      fontWeight: fontWeight.regular,
      lineHeight: lineHeight.caption,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.xs,
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.72,
    },
  });
