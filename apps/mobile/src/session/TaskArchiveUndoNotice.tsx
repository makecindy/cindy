/**
 * 卡片「离开后自动归档」成功后的可撤销提示(与电脑端同样停留 8 秒)。归档发生在用户离开任务页之后,
 * 提示挂在应用根部,落到首页或另一个任务上都看得到。同一时间只显示最近一次。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/AppText';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

const TASK_ARCHIVE_UNDO_MS = 8000;

interface Notice { id: number; title: string; undo: () => void }

let current: Notice | null = null;
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function showTaskArchiveUndo(title: string, undo: () => void): void {
  current = { id: ++nextId, title, undo };
  emit();
}

function dismiss(id: number): void {
  if (current?.id !== id) return;
  current = null;
  emit();
}

export function TaskArchiveUndoHost() {
  const notice = useSyncExternalStore(subscribe, () => current);
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dismiss(notice.id), TASK_ARCHIVE_UNDO_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return (
    <View pointerEvents="box-none" style={[styles.host, { bottom: insets.bottom + spacing.lg }]}>
      <View style={styles.pill} accessibilityLiveRegion="polite" testID="taskArchiveUndo">
        <Text style={styles.text} numberOfLines={2}>{t('plugins.taskArchive.archived', { title: notice.title })}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('plugins.taskArchive.undo')}
          hitSlop={spacing.sm}
          style={({ pressed }) => [styles.undo, pressed && styles.pressed]}
          onPress={() => { dismiss(notice.id); notice.undo(); }}>
          <Text style={styles.undoLabel}>{t('plugins.taskArchive.undo')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  host: {
    alignItems: 'center',
    left: 0,
    paddingHorizontal: spacing.lg,
    position: 'absolute',
    right: 0,
  },
  pill: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    maxWidth: 480,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.xs,
  },
  text: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  undo: {
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: spacing.md,
  },
  undoLabel: {
    color: colors.textPrimary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.caption,
  },
  pressed: { opacity: 0.72 },
});
