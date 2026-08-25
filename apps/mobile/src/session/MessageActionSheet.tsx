import { useCallback, useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  Link2,
  MessageSquarePlus,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/AppText';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import { SheetModal } from '@/session/SheetModal';
import type { MobileMessageMenuActionId, MobileMessageMenuItem } from '@/session/messageActionMenu';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

const ACTION_ICONS: Record<MobileMessageMenuActionId, LucideIcon> = {
  'add-to-chat': MessageSquarePlus,
  'copy-link': Link2,
  rewind: Undo2,
  delete: Trash2,
};

/** Touch-first counterpart of desktop's compact More dropdown. */
export function MessageActionSheet({
  disabledActions,
  items,
  onAction,
  onClose,
  visible,
}: {
  disabledActions?: readonly MobileMessageMenuActionId[];
  items: readonly MobileMessageMenuItem[];
  onAction(action: MobileMessageMenuActionId): void;
  onClose(): void;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const pendingActionRef = useRef<MobileMessageMenuActionId | null>(null);

  // A fade-out interrupted by a quick reopen must not replay the old choice
  // when the later close eventually finishes.
  useEffect(() => {
    if (visible) pendingActionRef.current = null;
  }, [visible]);
  const handleClosed = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (action) onAction(action);
  }, [onAction]);
  const closeWithoutAction = useCallback(() => {
    pendingActionRef.current = null;
    onClose();
  }, [onClose]);

  const select = (action: MobileMessageMenuActionId) => {
    pendingActionRef.current = action;
    onClose();
  };

  return (
    <SheetModal
      backdropTestID="message.actions.backdrop"
      onBackdropPress={closeWithoutAction}
      onClosed={handleClosed}
      onRequestClose={closeWithoutAction}
      visible={visible}
    >
      <View style={[styles.cardArea, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <View style={styles.actionCard} testID="message.actions.sheet">
          <BlurBackdrop intensity={32} overlayColor={colors.sheetActionSurface} />
          {items.map((item) => {
            const Icon = ACTION_ICONS[item.id];
            const color = item.destructive ? colors.destructive : colors.sheetActionText;
            const disabled = disabledActions?.includes(item.id) === true;
            return (
              <View key={item.id}>
                {item.separatorBefore ? <View style={styles.separator} /> : null}
                <Pressable
                  accessibilityLabel={item.label}
                  accessibilityRole="button"
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={() => select(item.id)}
                  style={({ pressed }) => [
                    styles.actionRow,
                    disabled && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                  testID={`message.actions.${item.id}`}
                >
                  <Icon color={color} size={iconSize.lg} strokeWidth={iconStroke.regular} />
                  <Text numberOfLines={1} style={[styles.actionLabel, item.destructive && styles.danger]}>
                    {item.label}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
        <Pressable
          accessibilityLabel={t('session.common.cancel')}
          accessibilityRole="button"
          onPress={closeWithoutAction}
          style={({ pressed }) => [styles.cancelCard, pressed && styles.pressed]}
          testID="message.actions.cancel"
        >
          <BlurBackdrop intensity={32} overlayColor={colors.sheetActionSurface} />
          <Text style={styles.cancelText}>{t('session.common.cancel')}</Text>
        </Pressable>
      </View>
    </SheetModal>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  cardArea: { gap: spacing.sm, paddingHorizontal: spacing.md },
  actionCard: {
    backgroundColor: 'transparent',
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 54,
    paddingHorizontal: spacing.lg,
  },
  separator: { backgroundColor: colors.sheetActionBorder, height: StyleSheet.hairlineWidth },
  disabled: { opacity: 0.42 },
  actionLabel: {
    color: colors.sheetActionText,
    flexShrink: 1,
    fontSize: typeScale.listBody,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listBody,
  },
  danger: { color: colors.destructive },
  cancelCard: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderColor: colors.sheetActionBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 54,
    overflow: 'hidden',
  },
  cancelText: {
    color: colors.sheetActionText,
    fontSize: typeScale.listBody,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listBody,
  },
  pressed: { opacity: 0.72 },
});
