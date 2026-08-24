/**
 * 首页任务搜索条。对齐桌面 SidebarInlineSearch 展开态:
 * 圆角 pill、左侧放大镜、占位「搜索标题或内容…」、有字时清空、右侧筛选钮。
 */
import { Search, SlidersHorizontal, X } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { TextInput } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, radius, spacing, typeScale } from '@/theme/tokens';

export function HomeSearchBar({
  autoFocus,
  filterA11y,
  filterActive,
  onChangeQuery,
  onDismiss,
  onOpenFilter,
  padded = true,
  query,
  testIDs,
}: {
  autoFocus: boolean;
  filterA11y?: string;
  filterActive: boolean;
  onChangeQuery(value: string): void;
  onDismiss?: () => void;
  onOpenFilter(): void;
  padded?: boolean;
  query: string;
  testIDs?: {
    clear?: string;
    filter?: string;
    input?: string;
    row?: string;
  };
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const trimmed = query.trim();
  return (
    <View style={[styles.row, !padded && styles.rowFlush]} testID={testIDs?.row ?? 'home.searchRow'}>
      <View style={styles.pill}>
        <Search
          color={colors.textSecondary}
          size={iconSize.md}
          strokeWidth={iconStroke.regular}
        />
        <TextInput
          accessibilityLabel={t('devices.list.search.placeholder')}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={autoFocus}
          onChangeText={onChangeQuery}
          placeholder={t('devices.list.search.placeholder')}
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          testID={testIDs?.input ?? 'home.searchInput'}
          value={query}
        />
        {trimmed || onDismiss ? (
          <Pressable
            accessibilityLabel={trimmed ? t('devices.detail.search.clearA11y') : t('devices.detail.search.closeInputA11y')}
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => {
              if (trimmed) {
                onChangeQuery('');
                return;
              }
              onDismiss?.();
            }}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            testID={testIDs?.clear ?? 'home.searchClearButton'}
          >
            <X color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityLabel={filterA11y ?? t('devices.list.search.filterA11y')}
          accessibilityRole="button"
          accessibilityState={{ selected: filterActive }}
          hitSlop={6}
          onPress={onOpenFilter}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          testID={testIDs?.filter ?? 'home.searchFilterButton'}
        >
          <SlidersHorizontal
            color={filterActive ? colors.textPrimary : colors.textSecondary}
            size={iconSize.md}
            strokeWidth={iconStroke.regular}
          />
          {filterActive ? <View style={styles.filterDot} /> : null}
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  row: {
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  rowFlush: {
    paddingBottom: 0,
    paddingHorizontal: 0,
  },
  pill: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 44,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
  },
  input: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    minWidth: 0,
    paddingVertical: spacing.sm,
  },
  iconButton: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    position: 'relative',
    width: 36,
  },
  filterDot: {
    backgroundColor: colors.statusAccent,
    borderRadius: radius.pill,
    height: 6,
    position: 'absolute',
    right: 7,
    top: 7,
    width: 6,
  },
  pressed: {
    opacity: 0.72,
  },
});
